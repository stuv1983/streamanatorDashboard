"""UniFi integration.

**Authentication choice matters here.** The polling account on this network has
email MFA enforced, which rules out any path that performs an interactive
login:

* `unpoller` and the legacy internal API (`/proxy/network/api/s/<site>/...`)
  authenticate with username + password and expect a session cookie back. With
  MFA enabled that flow stops for a second factor and never completes, so those
  paths are unusable regardless of the account's role.
* The **Network Integration API** (`/proxy/network/integration/v1/...`)
  authenticates with an `X-API-KEY` header. An API key is a separate credential
  issued from the console; it does not go through the login flow, so MFA on the
  human account stays enabled and unaffected.

The Integration API was confirmed present on this console — the endpoint
answers 401 (auth required) rather than 404 — so that is the path this module
uses.

Scope, checked against the published v10.4.57 specification rather than
assumed: the API exposes device health, uplink throughput, client inventory,
**network/VLAN definitions, WAN configuration and firewall policies**. It does
not expose IDS/IPS alarm history or per-VLAN firewall *counters* — those remain
legacy-API-only and stay reported as unavailable rather than approximated.

**This module issues GET requests only, and that is enforced, not merely
intended.** The same API key that reads a firewall policy can also `DELETE`
one, and can `PUT` a network, replace an SSID, or `POST` an action to a device.
UniFi issues one key with full scope; there is no read-only variant to ask for.
So the read-only property has to live on this side of the connection:
`_request()` is the only way out of this module, it hard-codes the verb, and
`tests/test_unifi_readonly.py` fails if a mutating verb ever appears here.
Nothing here raises into the UI or blocks a page render.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Mapping

import requests

from utils.cache import ttl_cache
from utils.logging_setup import get_logger

log = get_logger("unifi")

#: Exact work required to light up the UniFi sections, written for an
#: MFA-enforced account.
INTEGRATION_STEPS: tuple[str, ...] = (
    "Keep MFA enabled on your UniFi account — an API key is a separate "
    "credential and does not weaken it.",
    "In the UniFi console (https://10.0.40.1): Settings → Control Plane → "
    "Integrations → Create API Key. Copy it once; it is not shown again. "
    "If your console is cloud-adopted you can also create it from "
    "unifi.ui.com under the same Control Plane section.",
    "Verify it: curl -sk -H 'X-API-KEY: <key>' "
    "https://10.0.40.1/proxy/network/integration/v1/info — expect HTTP 200 "
    "and the Network application version.",
    "Put it in the dashboard: Admin → API keys → UniFi, or set "
    "UNIFI_CONTROLLER_URL=https://10.0.40.1 and UNIFI_API_KEY=<key> in .env "
    "and chmod 600 .env.",
    "Treat the key as privileged. UniFi issues one scope, and it includes "
    "write access to networks, firewall policies, SSIDs and device actions. "
    "This dashboard only ever sends GET, but anyone holding the key is not "
    "limited to that. Store it like a root password and revoke it in the "
    "console if it leaks.",
    "Do NOT use unpoller with this account — it logs in with username and "
    "password, which MFA will block.",
)

#: What the Integration API actually provides. Taken from the published
#: v10.4.57 specification, not from assumption — the first version of this list
#: was written before the spec was read and understated it.
PROVIDED_BY_INTEGRATION_API: tuple[str, ...] = (
    "Adopted and pending devices, device details, physical ports and radios",
    "Latest device CPU, memory, uptime, load, uplink and radio statistics",
    "Connected client identity, access state and uplink device",
    "Network/VLAN definitions, details and reference relationships",
    "WiFi broadcast definitions with credential fields redacted",
    "Firewall policies, firewall zones and ACL rules",
    "LAGs, MC-LAG domains and switch stacks",
    "DNS policies and traffic matching lists",
    "WAN interfaces, VPN servers and site-to-site tunnels",
    "DPI applications/categories, device tags and RADIUS profile names",
    "Network application version and local site inventory",
)

#: What it does not provide. Listed so these stay visibly unavailable rather
#: than quietly missing.
NOT_PROVIDED_BY_INTEGRATION_API: tuple[str, ...] = (
    "Per-client bandwidth and usage counters on the documented client endpoints",
    "IDS/IPS alarm history (legacy API only)",
    "Per-VLAN firewall hit, drop and block counters — the API exposes the "
    "rules themselves, but not how many times each has matched",
    "Historical WAN latency (use the dashboard's own ICMP history instead)",
)

_INTEGRATION_BASE = "/proxy/network/integration/v1"

# Device classification. Types are what the Integration API reports in
# `type`; the model prefixes are the fallback for firmware that leaves it
# empty. Tuples, because `str.startswith` accepts one directly.
_GATEWAY_TYPES = frozenset({"UGW", "UDM", "UXG", "UCG"})
_GATEWAY_MODELS = ("UDM", "UXG", "UCG", "UDR", "USG")
_SWITCH_TYPES = frozenset({"USW", "SWITCH"})
_SWITCH_MODELS = ("US", "USW", "USL", "FLEX")
_AP_TYPES = frozenset({"UAP", "AP"})
_AP_MODELS = ("UAP", "U6", "U7", "U5", "UWB", "UAP-AC")


@dataclass
class UnifiAvailability:
    """Whether UniFi data can be obtained, and how."""

    configured: bool
    source: str
    detail: str
    steps: tuple[str, ...] = INTEGRATION_STEPS


@dataclass
class GatewayStatus:
    name: str = ""
    model: str = ""
    version: str = ""
    state: str = ""
    uptime_seconds: float | None = None
    cpu_percent: float | None = None
    memory_percent: float | None = None
    temperature_celsius: float | None = None
    wan_up: bool | None = None
    wan_rx_bytes_per_sec: float | None = None
    wan_tx_bytes_per_sec: float | None = None
    wan_latency_ms: float | None = None
    configured: bool = False
    error: str = ""
    checked_at: float = field(default_factory=time.time)


@dataclass(frozen=True)
class RadioStats:
    """One radio on an access point."""

    frequency_ghz: float
    tx_retries_percent: float | None = None
    wlan_standard: str = ""
    channel: int | None = None
    channel_width_mhz: int | None = None

    @property
    def band(self) -> str:
        """The band as people refer to it, not as the API reports it."""
        if self.frequency_ghz >= 5.9:
            return "6 GHz"
        if self.frequency_ghz >= 4.9:
            return "5 GHz"
        return "2.4 GHz"


@dataclass(frozen=True)
class PortStats:
    """Read-only physical port state reported by an adopted device."""

    index: int | None = None
    state: str = ""
    connector: str = ""
    speed_mbps: int | None = None
    max_speed_mbps: int | None = None
    poe_enabled: bool | None = None
    poe_state: str = ""
    poe_standard: str = ""


@dataclass
class UnifiDevice:
    """One UniFi device (gateway, switch or access point)."""

    device_id: str
    name: str
    model: str
    mac: str
    ip_address: str
    state: str
    device_type: str = ""
    uptime_seconds: float | None = None
    cpu_percent: float | None = None
    memory_percent: float | None = None
    uplink_rx_bps: float | None = None
    uplink_tx_bps: float | None = None
    firmware_version: str = ""
    firmware_updatable: bool = False
    load_1m: float | None = None
    supported: bool | None = None
    adopted_at: str = ""
    provisioned_at: str = ""
    configuration_id: str = ""
    uplink_device_id: str = ""
    ports: tuple[PortStats, ...] = ()
    #: Per-radio transmit retry percentage, access points only. High retries
    #: mean an RF problem — interference, or clients at the edge of range —
    #: which nothing else on this dashboard would show.
    radios: tuple[RadioStats, ...] = ()

    @property
    def online(self) -> bool:
        return self.state.upper() == "ONLINE"

    @property
    def role(self) -> str:
        """Gateway, switch, access point, or a plain device when unclear.

        Derived from the reported type first and the model string second: the
        Integration API's `type` field is authoritative where it is populated,
        but comes back empty on some firmware versions, and a dashboard that
        cannot tell a switch from an AP is not much use.

        Order matters — the gateway test runs first because `USG` would
        otherwise be caught by the `US` switch prefix.
        """
        kind = self.device_type.upper()
        model = self.model.upper()
        if kind in _GATEWAY_TYPES or any(tag in model for tag in _GATEWAY_MODELS):
            return "gateway"
        if kind in _SWITCH_TYPES or model.startswith(_SWITCH_MODELS) or "SWITCH" in model:
            return "switch"
        # Modern AP model names carry no "AP" at all (U6-Pro, U7-Pro), so the
        # generation prefixes are matched explicitly rather than by substring.
        if kind in _AP_TYPES or model.startswith(_AP_MODELS):
            return "access point"
        return "device"


@dataclass
class VlanStats:
    """Per-network statistics. All fields optional — UniFi may expose none."""

    vlan_id: int
    name: str
    subnet: str
    client_count: int | None = None
    rx_bytes: int | None = None
    tx_bytes: int | None = None
    rx_bytes_per_sec: float | None = None
    tx_bytes_per_sec: float | None = None
    #: The Integration API does not expose firewall counters, so this stays
    #: None rather than being invented from another measurement.
    firewall_blocks: int | None = None
    top_clients: list[dict[str, Any]] = field(default_factory=list)


def availability(config) -> UnifiAvailability:
    """Report whether any UniFi source is usable."""
    if config.controller_url and config.api_key:
        return UnifiAvailability(
            configured=True,
            source="UniFi Network Integration API",
            detail=(
                f"API-key authentication against {config.controller_url}. "
                f"MFA on the account is unaffected."
            ),
        )
    if config.exporter_url:
        return UnifiAvailability(
            configured=True,
            source="unpoller exporter",
            detail=f"Scraping {config.exporter_url}",
        )
    return UnifiAvailability(
        configured=False,
        source="",
        detail=(
            "No UniFi API key configured. Gateway health, WAN throughput, "
            "per-VLAN client counts and device status are unavailable. Because "
            "this account uses MFA, the API-key path is the one to use — "
            "username/password polling will be blocked by the second factor."
        ),
    )


# ---------------------------------------------------------------------------
# Integration API transport
# ---------------------------------------------------------------------------


#: Paths this module is allowed to read. An allowlist rather than a blocklist,
#: because the risky endpoints are reached by *method*, not by path — the same
#: `/firewall/policies` that lists rules deletes one under DELETE. Keeping the
#: set of reachable paths small and declared means a future caller cannot
#: quietly widen what the key is used for.
_READ_PATHS: tuple[str, ...] = (
    "/info",
    "/sites",
    "/pending-devices",
    "/dpi/categories",
    "/dpi/applications",
    "/sites/{site}/devices",
    "/sites/{site}/devices/{device}",
    "/sites/{site}/devices/{device}/statistics/latest",
    "/sites/{site}/clients",
    "/sites/{site}/clients/{client}",
    "/sites/{site}/networks",
    "/sites/{site}/networks/{network}",
    "/sites/{site}/networks/{network}/references",
    "/sites/{site}/wifi/broadcasts",
    "/sites/{site}/wifi/broadcasts/{broadcast}",
    "/sites/{site}/wans",
    "/sites/{site}/firewall/policies",
    "/sites/{site}/firewall/policies/{policy}",
    "/sites/{site}/firewall/zones",
    "/sites/{site}/firewall/zones/{zone}",
    "/sites/{site}/acl-rules",
    "/sites/{site}/acl-rules/{rule}",
    "/sites/{site}/switching/lags",
    "/sites/{site}/switching/lags/{lag}",
    "/sites/{site}/switching/mc-lag-domains",
    "/sites/{site}/switching/mc-lag-domains/{domain}",
    "/sites/{site}/switching/switch-stacks",
    "/sites/{site}/switching/switch-stacks/{stack}",
    "/sites/{site}/dns/policies",
    "/sites/{site}/dns/policies/{policy}",
    "/sites/{site}/traffic-matching-lists",
    "/sites/{site}/traffic-matching-lists/{matching_list}",
    "/sites/{site}/vpn/servers",
    "/sites/{site}/vpn/site-to-site-tunnels",
    "/sites/{site}/radius/profiles",
    "/sites/{site}/device-tags",
)

_QUERY_KEYS = frozenset({"offset", "limit"})
_PAGE_SIZE = 100
_MAX_COLLECTION_ITEMS = 5_000


def _is_resource_id(value: str) -> bool:
    """Accept UUID-like API identifiers, never path/query syntax."""
    return bool(value) and len(value) <= 128 and all(
        character.isascii() and (character.isalnum() or character in "_-")
        for character in value
    )


def _path_is_allowlisted(path: str) -> bool:
    """Match a concrete path against the declared read-only templates."""
    if not path.startswith("/") or "?" in path or "#" in path or "//" in path:
        return False
    concrete = path.split("/")[1:]
    for template in _READ_PATHS:
        expected = template.split("/")[1:]
        if len(concrete) != len(expected):
            continue
        if all(
            (_is_resource_id(value) if part.startswith("{") else value == part)
            for value, part in zip(concrete, expected)
        ):
            return True
    return False


def _query_is_safe(params: Mapping[str, int] | None) -> bool:
    if params is None:
        return True
    if not set(params).issubset(_QUERY_KEYS):
        return False
    return all(
        type(value) is int and 0 <= value <= _MAX_COLLECTION_ITEMS
        for value in params.values()
    )


def _request(
    config,
    path: str,
    timeout: float = 8.0,
    params: Mapping[str, int] | None = None,
) -> tuple[Any | None, str]:
    """GET an Integration API path. Returns (payload, error). Never raises.

    The verb is a literal `requests.get`, not a parameter. That is the single
    enforcement point for this module's read-only contract: the API key has
    write scope on networks, firewall policies, SSIDs and device actions, and
    UniFi does not offer a read-only key to ask for instead. Since the
    credential cannot be constrained, the client is.
    """
    if not _path_is_allowlisted(path):
        return None, "Read path is not allowlisted"
    if not _query_is_safe(params):
        return None, "Query parameters are not allowlisted"
    if not (config.controller_url and config.api_key):
        return None, "No controller URL or API key configured"
    url = f"{config.controller_url.rstrip('/')}{_INTEGRATION_BASE}{path}"
    # Prefer a pinned CA bundle (UNIFI_CA_BUNDLE) over blanket verify=False —
    # this key carries write scope, so authenticating the peer matters more
    # here than anywhere else in the project. `tls_verify` returns the bundle
    # path when configured, else the verify_tls boolean.
    verify = getattr(config, "tls_verify", None)
    if verify is None:
        verify = config.verify_tls
    import time as _time

    deadline = _time.monotonic() + timeout
    try:
        response = requests.get(
            url,
            headers={
                "X-API-KEY": config.api_key,
                "Accept": "application/json",
            },
            params=dict(params) if params else None,
            timeout=timeout,
            verify=verify,
            # A redirect could otherwise carry the API key to another host.
            allow_redirects=False,
            # Streamed + bounded read below: `timeout=` is an inactivity
            # timeout, and a peer that trickles bytes forever would otherwise
            # pin this thread with the response buffering unbounded.
            stream=True,
        )
    except requests.RequestException as exc:
        return None, f"{type(exc).__name__}"

    try:
        if response.status_code == 401:
            return None, (
                "401 Unauthorized — the API key was rejected. Re-issue it from "
                "Settings → Control Plane → Integrations."
            )
        if response.status_code == 404:
            return None, (
                "404 Not Found — this read endpoint is unavailable on the current "
                "UniFi Network version."
            )
        if 300 <= response.status_code < 400:
            return None, "Redirect refused while sending the API key"
        if response.status_code >= 400:
            return None, f"HTTP {response.status_code}"
    finally:
        if response.status_code >= 300:
            response.close()
    from utils.http import DeadlineExceeded, ResponseTooLarge, read_bounded

    try:
        body = read_bounded(response, deadline=deadline)
    except (ResponseTooLarge, DeadlineExceeded) as exc:
        return None, str(exc)
    except requests.RequestException as exc:
        return None, f"{type(exc).__name__}"
    finally:
        response.close()
    import json as _json

    try:
        payload = _json.loads(body.decode("utf-8", errors="replace"))
    except ValueError:
        return None, "Response was not JSON"
    return payload, ""


def _as_non_negative_int(value: Any) -> int | None:
    if type(value) is int and value >= 0:
        return value
    return None


def _request_collection(
    config,
    path: str,
    timeout: float = 8.0,
) -> tuple[tuple[dict[str, Any], ...], str]:
    """Read every page of a collection, failing closed on partial results."""
    items: list[dict[str, Any]] = []
    offset = 0

    while offset < _MAX_COLLECTION_ITEMS:
        payload, error = _request(
            config,
            path,
            timeout=timeout,
            params={"offset": offset, "limit": _PAGE_SIZE},
        )
        if error:
            return (), error
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            return (), "Unexpected collection response"

        page = payload["data"]
        total = _as_non_negative_int(payload.get("totalCount"))
        if total is not None and total > _MAX_COLLECTION_ITEMS:
            return (), (
                f"Collection contains {total} items, above the safe limit of "
                f"{_MAX_COLLECTION_ITEMS}"
            )

        items.extend(entry for entry in page if isinstance(entry, dict))
        if len(items) > _MAX_COLLECTION_ITEMS:
            return (), f"Collection exceeded the safe limit of {_MAX_COLLECTION_ITEMS}"
        if not page:
            if total is not None and len(items) < total:
                return (), (
                    f"Collection ended after {len(items)} of {total} declared items"
                )
            return tuple(items), ""

        next_offset = offset + len(page)
        if next_offset <= offset:
            return (), "Collection pagination did not advance"
        if total is not None and next_offset >= total:
            return tuple(items), ""
        offset = next_offset

    return (), f"Collection exceeded the safe limit of {_MAX_COLLECTION_ITEMS}"


@ttl_cache(seconds=300, max_entries=128)
def _fetch_collection_cached(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    path: str,
) -> tuple[tuple[dict[str, Any], ...], str]:
    return _request_collection(_Config(controller_url, api_key, tls_verify), path)


_COLLECTION_PATHS: dict[str, str] = {
    "sites": "/sites",
    "pending_devices": "/pending-devices",
    "adopted_devices": "/sites/{site}/devices",
    "clients": "/sites/{site}/clients",
    "networks": "/sites/{site}/networks",
    "wifi_broadcasts": "/sites/{site}/wifi/broadcasts",
    "wans": "/sites/{site}/wans",
    "firewall_policies": "/sites/{site}/firewall/policies",
    "firewall_zones": "/sites/{site}/firewall/zones",
    "acl_rules": "/sites/{site}/acl-rules",
    "lags": "/sites/{site}/switching/lags",
    "mc_lag_domains": "/sites/{site}/switching/mc-lag-domains",
    "switch_stacks": "/sites/{site}/switching/switch-stacks",
    "dns_policies": "/sites/{site}/dns/policies",
    "traffic_matching_lists": "/sites/{site}/traffic-matching-lists",
    "vpn_servers": "/sites/{site}/vpn/servers",
    "site_to_site_vpn_tunnels": "/sites/{site}/vpn/site-to-site-tunnels",
    "radius_profiles": "/sites/{site}/radius/profiles",
    "device_tags": "/sites/{site}/device-tags",
    "dpi_categories": "/dpi/categories",
    "dpi_applications": "/dpi/applications",
}

_DETAIL_PATHS: dict[str, str] = {
    "device": "/sites/{site}/devices/{resource}",
    "client": "/sites/{site}/clients/{resource}",
    "network": "/sites/{site}/networks/{resource}",
    "network_references": "/sites/{site}/networks/{resource}/references",
    "wifi_broadcast": "/sites/{site}/wifi/broadcasts/{resource}",
    "firewall_policy": "/sites/{site}/firewall/policies/{resource}",
    "firewall_zone": "/sites/{site}/firewall/zones/{resource}",
    "acl_rule": "/sites/{site}/acl-rules/{resource}",
    "lag": "/sites/{site}/switching/lags/{resource}",
    "mc_lag_domain": "/sites/{site}/switching/mc-lag-domains/{resource}",
    "switch_stack": "/sites/{site}/switching/switch-stacks/{resource}",
    "dns_policy": "/sites/{site}/dns/policies/{resource}",
    "traffic_matching_list": "/sites/{site}/traffic-matching-lists/{resource}",
}


@ttl_cache(seconds=300)
def _resolve_site_id(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    site: str,
) -> str | None:
    """Look up the internal site id across every available page."""
    cfg = _Config(controller_url, api_key, tls_verify)
    sites, error = _request_collection(cfg, "/sites")
    if error:
        log.debug("Site lookup failed: %s", error)
        return None
    for entry in sites:
        # Match either the human name or the internal reference ("default").
        if site.lower() in {
            str(entry.get("internalReference", "")).lower(),
            str(entry.get("name", "")).lower(),
        }:
            return entry.get("id")
    # Fall back to the first site — single-site is the common case.
    return sites[0].get("id") if sites else None


def site_id(config) -> str | None:
    if not (config.controller_url and config.api_key):
        return None
    return _resolve_site_id(
        config.controller_url,
        config.api_key,
        getattr(config, "tls_verify", config.verify_tls),
        config.site,
    )


def _concrete_resource_path(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    site: str,
    template: str,
    resource_id: str = "",
) -> tuple[str, str]:
    path = template
    if "{site}" in path:
        resolved = _resolve_site_id(controller_url, api_key, tls_verify, site)
        if not resolved:
            return "", "Could not resolve the site id"
        path = path.replace("{site}", str(resolved))
    if "{resource}" in path:
        if not _is_resource_id(resource_id):
            return "", "Invalid resource id"
        path = path.replace("{resource}", resource_id)
    return path, ""


def get_api_collection(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    site: str,
    resource: str,
) -> tuple[list[dict[str, Any]], str]:
    """Return a complete, bounded collection from a named GET-only resource."""
    template = _COLLECTION_PATHS.get(resource)
    if template is None:
        return [], "Unknown read-only UniFi resource"
    path, error = _concrete_resource_path(
        controller_url, api_key, tls_verify, site, template
    )
    if error:
        return [], error
    items, error = _fetch_collection_cached(
        controller_url, api_key, tls_verify, path
    )
    return list(items), error


@ttl_cache(seconds=300, max_entries=256)
def _fetch_detail_cached(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    path: str,
) -> tuple[dict[str, Any], str]:
    payload, error = _request(_Config(controller_url, api_key, tls_verify), path)
    if error:
        return {}, error
    if not isinstance(payload, dict):
        return {}, "Unexpected detail response"
    nested = payload.get("data")
    if isinstance(nested, dict):
        return nested, ""
    return payload, ""


def get_api_detail(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    site: str,
    resource: str,
    resource_id: str,
) -> tuple[dict[str, Any], str]:
    """Return one detail object from a declared GET-only resource."""
    template = _DETAIL_PATHS.get(resource)
    if template is None:
        return {}, "Unknown read-only UniFi detail resource"
    path, error = _concrete_resource_path(
        controller_url, api_key, tls_verify, site, template, resource_id
    )
    if error:
        return {}, error
    return _fetch_detail_cached(controller_url, api_key, tls_verify, path)


_SENSITIVE_FIELD_MARKERS = (
    "password",
    "passphrase",
    "secret",
    "token",
    "credential",
    "apikey",
    "privatekey",
    "presharedkey",
    "sharedkey",
    "psk",
    "communitystring",
)


def safe_for_display(value: Any, *, _depth: int = 0) -> Any:
    """Copy an API payload while removing credential-shaped fields."""
    if _depth >= 8:
        return "[nested data omitted]"
    if isinstance(value, dict):
        safe: dict[str, Any] = {}
        for key, nested in value.items():
            name = str(key)
            normalized = "".join(
                character for character in name.casefold() if character.isalnum()
            )
            if any(marker in normalized for marker in _SENSITIVE_FIELD_MARKERS):
                safe[name] = "[redacted]"
            else:
                safe[name] = safe_for_display(nested, _depth=_depth + 1)
        return safe
    if isinstance(value, (list, tuple)):
        visible = [
            safe_for_display(item, _depth=_depth + 1) for item in value[:500]
        ]
        if len(value) > 500:
            visible.append(f"[{len(value) - 500} additional items omitted]")
        return visible
    if isinstance(value, str) and len(value) > 4096:
        return value[:4096] + "… [truncated]"
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------


@ttl_cache(seconds=60)
def _fetch_devices(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    resolved_site: str,
) -> tuple[tuple[UnifiDevice, ...], str]:
    cfg = _Config(controller_url, api_key, tls_verify)
    entries, error = _request_collection(cfg, f"/sites/{resolved_site}/devices")
    if error:
        return (), error or "Unexpected device response"

    devices: list[UnifiDevice] = []
    for entry in entries:
        uplink = entry.get("uplink") if isinstance(entry.get("uplink"), dict) else {}
        device = UnifiDevice(
            device_id=str(entry.get("id", "")),
            name=str(entry.get("name", "")),
            model=str(entry.get("model", "")),
            mac=str(entry.get("macAddress", "")),
            ip_address=str(entry.get("ipAddress", "")),
            state=str(entry.get("state", "")),
            device_type=str(entry.get("type", "")),
            firmware_version=str(entry.get("firmwareVersion", "")),
            firmware_updatable=bool(entry.get("firmwareUpdatable", False)),
            supported=(
                entry.get("supported")
                if isinstance(entry.get("supported"), bool)
                else None
            ),
            adopted_at=str(entry.get("adoptedAt", "") or ""),
            provisioned_at=str(entry.get("provisionedAt", "") or ""),
            configuration_id=str(entry.get("configurationId", "") or ""),
            uplink_device_id=str(uplink.get("deviceId", "") or ""),
            ports=_ports(entry),
            radios=_radios(entry),
        )
        # Per-device statistics are a second call; only made for devices that
        # are actually online, to keep the request count down.
        if device.online and device.device_id:
            stats, stats_error = _request(
                cfg, f"/sites/{resolved_site}/devices/{device.device_id}/statistics/latest"
            )
            if not stats_error and isinstance(stats, dict):
                device.uptime_seconds = _to_float(stats.get("uptimeSec"))
                device.cpu_percent = _to_float(stats.get("cpuUtilizationPct"))
                device.memory_percent = _to_float(stats.get("memoryUtilizationPct"))
                uplink = stats.get("uplink") or {}
                device.uplink_rx_bps = _to_float(uplink.get("rxRateBps"))
                device.uplink_tx_bps = _to_float(uplink.get("txRateBps"))
                device.load_1m = _to_float(stats.get("loadAverage1Min"))
                statistical_radios = _radios(stats)
                if statistical_radios:
                    device.radios = _merge_radios(device.radios, statistical_radios)
        devices.append(device)
    return tuple(devices), ""


def get_devices(config) -> tuple[list[UnifiDevice], str]:
    """All UniFi devices with their latest statistics."""
    resolved = site_id(config)
    if resolved is None:
        return [], "Could not resolve the UniFi site id"
    devices, error = _fetch_devices(
        config.controller_url,
        config.api_key,
        getattr(config, "tls_verify", config.verify_tls),
        resolved,
    )
    return list(devices), error


def get_gateway_status(
    config,
    prometheus_client=None,
    timeout: float = 8.0,
    devices: list[UnifiDevice] | None = None,
) -> GatewayStatus:
    """Gateway health, preferring the Integration API.

    Falls back to unpoller metrics in Prometheus when those are present, which
    supports a mixed setup, but the API-key path is the one that works with MFA.

    `devices` lets a caller that has already fetched the inventory pass it in.
    Each fetch is one request per device for statistics, so re-fetching it here
    would double the controller traffic on every collection.
    """
    status = GatewayStatus()
    available = availability(config)
    status.configured = available.configured
    if not available.configured:
        status.error = available.detail
        return status

    if config.controller_url and config.api_key:
        error = ""
        if devices is None:
            devices, error = get_devices(config)
        if error:
            status.error = error
            return status
        gateway = _pick_gateway(devices)
        if gateway is None:
            status.error = "No gateway device found in the UniFi inventory"
            return status
        status.name = gateway.name
        status.model = gateway.model
        status.state = gateway.state
        status.uptime_seconds = gateway.uptime_seconds
        status.cpu_percent = gateway.cpu_percent
        status.memory_percent = gateway.memory_percent
        status.wan_up = gateway.online
        status.wan_rx_bytes_per_sec = (
            gateway.uplink_rx_bps / 8.0 if gateway.uplink_rx_bps is not None else None
        )
        status.wan_tx_bytes_per_sec = (
            gateway.uplink_tx_bps / 8.0 if gateway.uplink_tx_bps is not None else None
        )
        return status

    return _gateway_from_prometheus(status, prometheus_client)


def _radios(stats: dict[str, Any]) -> tuple[RadioStats, ...]:
    """Radio statistics from an access point's `interfaces.radios`.

    Absent on switches and gateways, which is why this returns an empty tuple
    rather than raising — the caller renders radios only when there are any.
    """
    interfaces = stats.get("interfaces")
    if not isinstance(interfaces, dict):
        return ()
    radios: list[RadioStats] = []
    for entry in interfaces.get("radios") or []:
        if not isinstance(entry, dict):
            continue
        frequency = _to_float(entry.get("frequencyGHz"))
        if frequency is None:
            continue
        radios.append(
            RadioStats(
                frequency_ghz=frequency,
                tx_retries_percent=_to_float(entry.get("txRetriesPct")),
                wlan_standard=str(entry.get("wlanStandard", "") or ""),
                channel=_to_int(entry.get("channel")),
                channel_width_mhz=_to_int(entry.get("channelWidthMHz")),
            )
        )
    return tuple(radios)


def _merge_radios(
    configured: tuple[RadioStats, ...],
    statistical: tuple[RadioStats, ...],
) -> tuple[RadioStats, ...]:
    """Merge interface configuration with latest retry statistics by band."""
    configured_by_band = {radio.band: radio for radio in configured}
    statistical_by_band = {radio.band: radio for radio in statistical}
    merged: list[RadioStats] = []
    for band in dict.fromkeys([*configured_by_band, *statistical_by_band]):
        base = configured_by_band.get(band)
        stats = statistical_by_band.get(band)
        merged.append(
            RadioStats(
                frequency_ghz=(base or stats).frequency_ghz,  # type: ignore[union-attr]
                tx_retries_percent=(
                    stats.tx_retries_percent if stats else base.tx_retries_percent
                ),
                wlan_standard=(base.wlan_standard if base else stats.wlan_standard),
                channel=(base.channel if base else stats.channel),
                channel_width_mhz=(
                    base.channel_width_mhz if base else stats.channel_width_mhz
                ),
            )
        )
    return tuple(merged)


def _ports(payload: dict[str, Any]) -> tuple[PortStats, ...]:
    interfaces = payload.get("interfaces")
    if not isinstance(interfaces, dict):
        return ()
    ports: list[PortStats] = []
    for entry in interfaces.get("ports") or []:
        if not isinstance(entry, dict):
            continue
        poe = entry.get("poe") if isinstance(entry.get("poe"), dict) else {}
        ports.append(
            PortStats(
                index=_to_int(entry.get("idx")),
                state=str(entry.get("state", "") or ""),
                connector=str(entry.get("connector", "") or ""),
                speed_mbps=_to_int(entry.get("speedMbps")),
                max_speed_mbps=_to_int(entry.get("maxSpeedMbps")),
                poe_enabled=(
                    poe.get("enabled") if isinstance(poe.get("enabled"), bool) else None
                ),
                poe_state=str(poe.get("state", "") or ""),
                poe_standard=str(poe.get("standard", "") or ""),
            )
        )
    return tuple(ports)


def _pick_gateway(devices: list[UnifiDevice]) -> UnifiDevice | None:
    """Identify the gateway among the device inventory."""
    for device in devices:
        if device.role == "gateway":
            return device
    return devices[0] if devices else None


def _gateway_from_prometheus(status: GatewayStatus, prometheus_client) -> GatewayStatus:
    """Read gateway health from unpoller metrics, when that path is in use."""
    if prometheus_client is None or not prometheus_client.available():
        status.error = "unpoller metrics are not available in Prometheus"
        return status
    try:
        status.uptime_seconds = prometheus_client.query_one(
            "unpoller_device_uptime_seconds{type='ugw'}"
        )
        status.cpu_percent = prometheus_client.query_one(
            "unpoller_device_cpu_percent{type='ugw'}"
        )
        status.memory_percent = prometheus_client.query_one(
            "unpoller_device_memory_percent{type='ugw'}"
        )
        latency = prometheus_client.query_one("unpoller_usg_wan_latency_seconds")
        status.wan_latency_ms = latency * 1000.0 if latency is not None else None
        status.wan_rx_bytes_per_sec = prometheus_client.query_one(
            "rate(unpoller_usg_wan_bytes_total{direction='rx'}[5m])"
        )
        status.wan_tx_bytes_per_sec = prometheus_client.query_one(
            "rate(unpoller_usg_wan_bytes_total{direction='tx'}[5m])"
        )
        status.wan_up = status.uptime_seconds is not None
    except Exception as exc:  # noqa: BLE001 - optional integration
        log.debug("UniFi metrics query failed: %s", exc)
        status.error = f"UniFi metrics query failed: {exc}"
    return status


def _to_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Clients and VLANs
# ---------------------------------------------------------------------------


@ttl_cache(seconds=60)
def _fetch_clients(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    resolved_site: str,
) -> tuple[tuple[dict, ...], str]:
    cfg = _Config(controller_url, api_key, tls_verify)
    clients, error = _request_collection(cfg, f"/sites/{resolved_site}/clients")
    if error:
        return (), error or "Unexpected client response"
    return clients, ""


def get_vlan_stats(config, vlans, prometheus_client=None) -> list[VlanStats]:
    """Per-VLAN statistics, or bare definitions when UniFi is unavailable.

    Client counts are derived by matching each client's IP against the VLAN
    subnets, since the Integration API reports addresses rather than network
    names. Traffic and firewall counters stay None — the Integration API does
    not expose them, and inferring them from another measurement would put a
    different number under the same label.
    """
    stats = [
        VlanStats(vlan_id=v.vlan_id, name=v.name, subnet=v.subnet) for v in vlans
    ]
    available = availability(config)
    if not available.configured:
        return stats

    if config.controller_url and config.api_key:
        resolved = site_id(config)
        if resolved is None:
            return stats
        clients, error = _fetch_clients(
            config.controller_url,
            config.api_key,
            getattr(config, "tls_verify", config.verify_tls),
            resolved,
        )
        if error:
            log.debug("Client fetch failed: %s", error)
            return stats

        import ipaddress

        networks = []
        for entry in stats:
            try:
                networks.append((entry, ipaddress.ip_network(entry.subnet)))
                entry.client_count = 0
            except ValueError:
                continue

        for client in clients:
            address = str(client.get("ipAddress", "")).strip()
            if not address:
                continue
            try:
                parsed = ipaddress.ip_address(address)
            except ValueError:
                continue
            for entry, network in networks:
                if parsed in network:
                    entry.client_count = (entry.client_count or 0) + 1
                    break
        return stats

    if prometheus_client is not None and prometheus_client.available():
        try:
            counts = {
                item.labels.get("network", ""): item.value
                for item in prometheus_client.query("unpoller_client_count")
            }
            for entry in stats:
                for network_name, value in counts.items():
                    if network_name.lower() == entry.name.lower():
                        entry.client_count = int(value)
                        break
        except Exception as exc:  # noqa: BLE001
            log.debug("VLAN client counts unavailable: %s", exc)
    return stats


# ---------------------------------------------------------------------------
# Controller metadata, networks, WANs and firewall policy
# ---------------------------------------------------------------------------


@dataclass
class ControllerInfo:
    version: str = ""
    reachable: bool = False
    error: str = ""


@ttl_cache(seconds=600)
def get_controller_info(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
) -> ControllerInfo:
    """`GET /v1/info` — the cheapest proof that a key works.

    Used by the onboarding check because it needs no site id, returns almost
    nothing, and distinguishes all three failure modes cleanly: unreachable
    host, rejected key, and firmware without the Integration API.
    """
    cfg = _Config(controller_url, api_key, tls_verify)
    payload, error = _request(cfg, "/info")
    if error:
        return ControllerInfo(error=error)
    return ControllerInfo(version=_extract_version(payload), reachable=True)


def _extract_version(payload: Any) -> str:
    """Pull the application version out of whichever shape /info returns.

    Firmware versions have moved this field between the envelope and a nested
    `data` object, so both are checked rather than pinning to one and showing
    a blank version on the other.
    """
    if not isinstance(payload, dict):
        return ""
    candidates = [payload]
    nested = payload.get("data")
    if isinstance(nested, dict):
        candidates.append(nested)
    for source in candidates:
        for key in ("applicationVersion", "version"):
            value = source.get(key)
            if value:
                return str(value)
    return ""


@dataclass
class UnifiNetwork:
    """A network as the controller defines it, rather than as config guesses."""

    network_id: str
    name: str
    subnet: str = ""
    vlan_id: int | None = None
    purpose: str = ""
    enabled: bool = True


@ttl_cache(seconds=300)
def get_networks(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    site: str,
) -> tuple[list[UnifiNetwork], str]:
    """Network/VLAN definitions from the controller.

    Worth preferring over the hard-coded subnet table in `config.py`: that
    table is a transcription of the documentation, and a VLAN renumbered on
    the console would leave it silently wrong — client counts would land in
    the wrong row with no indication anything had drifted.
    """
    resolved = _resolve_site_id(controller_url, api_key, tls_verify, site)
    if not resolved:
        return [], "Could not resolve the site id"
    entries, error = _fetch_collection_cached(
        controller_url, api_key, tls_verify, f"/sites/{resolved}/networks"
    )
    if error:
        return [], error or "Unexpected response"

    networks: list[UnifiNetwork] = []
    for entry in entries:
        vlan = entry.get("vlanId", entry.get("vlan"))
        try:
            vlan_id = int(vlan) if vlan is not None else None
        except (TypeError, ValueError):
            vlan_id = None
        networks.append(
            UnifiNetwork(
                network_id=str(entry.get("id", "")),
                name=str(entry.get("name", "")),
                subnet=str(entry.get("subnet", entry.get("ipSubnet", "")) or ""),
                vlan_id=vlan_id,
                purpose=str(entry.get("purpose", "") or ""),
                enabled=bool(entry.get("enabled", True)),
            )
        )
    return networks, ""


@dataclass
class FirewallPolicy:
    policy_id: str
    name: str
    action: str = ""
    enabled: bool = True
    predefined: bool = False
    source: str = ""
    destination: str = ""


@ttl_cache(seconds=300)
def get_firewall_policies(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    site: str,
) -> tuple[list[FirewallPolicy], str]:
    """Firewall policies as configured.

    This is rules, not counters. It answers "is the Media-DMZ still blocked
    from reaching Home?" — a configuration-drift question — and not "how many
    packets were dropped", which the Integration API does not expose at all.
    Keeping that distinction visible matters: a rules list rendered under a
    heading about blocked traffic would read as an all-clear it cannot support.
    """
    resolved = _resolve_site_id(controller_url, api_key, tls_verify, site)
    if not resolved:
        return [], "Could not resolve the site id"
    entries, error = _fetch_collection_cached(
        controller_url, api_key, tls_verify, f"/sites/{resolved}/firewall/policies"
    )
    if error:
        # Observed on UniFi 10.5.67: this endpoint answers HTTP 500
        # (api.unexpected-error) while every other firewall endpoint works.
        # An upstream defect, surfaced as such rather than as our failure —
        # firewall *zones* answer the isolation question without it.
        if "500" in error:
            return [], (
                "The controller's firewall-policies endpoint returned HTTP 500 "
                "(a UniFi-side error on this firmware). Firewall zones below "
                "are unaffected."
            )
        return [], error
    policies: list[FirewallPolicy] = []
    for entry in entries:
        source = entry.get("source", {})
        destination = entry.get("destination", {})
        policies.append(
            FirewallPolicy(
                policy_id=str(entry.get("id", "")),
                name=str(entry.get("name", "") or "(unnamed)"),
                action=str(entry.get("action", "") or ""),
                enabled=bool(entry.get("enabled", True)),
                predefined=bool(entry.get("predefined", False)),
                source=_endpoint_label(source),
                destination=_endpoint_label(destination),
            )
        )
    return policies, ""


def _endpoint_label(spec: Any) -> str:
    """Collapse a firewall source/destination object into one readable string."""
    if not isinstance(spec, dict):
        return ""
    for key in ("zoneId", "zone", "networkId", "matchingTarget", "ips"):
        value = spec.get(key)
        if isinstance(value, list) and value:
            return ", ".join(str(v) for v in value[:3])
        if value:
            return str(value)
    return ""


@dataclass
class FirewallZone:
    zone_id: str
    name: str
    network_ids: tuple[str, ...] = ()


@ttl_cache(seconds=300)
def get_firewall_zones(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    site: str,
) -> tuple[list[FirewallZone], str]:
    """Firewall zones and the networks assigned to each.

    Preferred over policies on this network: the policies endpoint 500s on the
    live firmware, and zones already answer the security question that matters
    here — which VLANs share a trust boundary. Media-DMZ (VLAN 40) sitting in
    its own zone, apart from Home (VLAN 10), is the isolation the whole
    segmented design depends on.
    """
    resolved = _resolve_site_id(controller_url, api_key, tls_verify, site)
    if not resolved:
        return [], "Could not resolve the site id"
    entries, error = _fetch_collection_cached(
        controller_url, api_key, tls_verify, f"/sites/{resolved}/firewall/zones"
    )
    if error:
        return [], error or "Unexpected response"
    zones: list[FirewallZone] = []
    for entry in entries:
        network_ids = entry.get("networkIds", [])
        zones.append(
            FirewallZone(
                zone_id=str(entry.get("id", "")),
                name=str(entry.get("name", "") or "(unnamed)"),
                network_ids=tuple(
                    str(n) for n in network_ids if isinstance(network_ids, list)
                ),
            )
        )
    return zones, ""


@ttl_cache(seconds=300)
def get_wans(
    controller_url: str,
    api_key: str,
    tls_verify: bool | str,
    site: str,
) -> tuple[list[dict[str, Any]], str]:
    """WAN interface configuration."""
    resolved = _resolve_site_id(controller_url, api_key, tls_verify, site)
    if not resolved:
        return [], "Could not resolve the site id"
    entries, error = _fetch_collection_cached(
        controller_url, api_key, tls_verify, f"/sites/{resolved}/wans"
    )
    if error:
        return [], error or "Unexpected response"
    return list(entries), ""


class _Config:
    """Minimal config shape for the cached helpers.

    The cached functions take plain strings rather than a Settings object
    because `ttl_cache` keys on arguments, and a dataclass instance would
    produce a fresh key on every rebuild of the settings singleton — turning
    every cached lookup into a miss.
    """

    __slots__ = ("controller_url", "api_key", "verify_tls")

    def __init__(
        self,
        controller_url: str,
        api_key: str,
        verify_tls: bool | str,
    ) -> None:
        self.controller_url = controller_url
        self.api_key = api_key
        self.verify_tls = verify_tls


def get_ids_events(config, limit: int = 50, timeout: float = 8.0) -> list[dict[str, Any]]:
    """IDS/IPS alerts.

    The Network Integration API does not expose alarm history — that remains
    legacy-API-only, and the legacy API needs an interactive login that MFA
    blocks. So this returns an empty list, and the Security page distinguishes
    "no events" from "cannot see events" using `ids_available()` rather than
    rendering an empty table as an all-clear.
    """
    return []


def ids_available(config) -> bool:
    """Whether IDS/IPS events can be read at all in the current configuration."""
    return False
