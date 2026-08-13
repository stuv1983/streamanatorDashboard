"""The catalogue of credentials the admin console can manage, and how to test them.

Each entry knows three things a settings form cannot guess: where the user
finds the key in that application's own UI, what shape a valid value has, and
how to ask the service whether the key actually works.

That last part is the reason this module exists rather than a plain text
input. A key that was pasted with a trailing newline, copied from the wrong
instance, or revoked last month looks identical to a good one in a form field.
The dashboard would then show the integration as configured and report NO DATA
forever. Testing on save turns a silent misconfiguration into an error message
at the moment the mistake is made.

Every validator is a single GET to one explicit, configured host — never a
scan, never a sweep, never a discovery attempt.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

import requests

from auth.crypto import fingerprint
from utils.logging_setup import get_logger

log = get_logger("admin.credentials")

#: Validators are user-triggered and must never hang a page render.
TEST_TIMEOUT = 8.0

_UA = {"User-Agent": "streamanator-dashboard/1.0 (admin credential test)"}


@dataclass(frozen=True)
class TestResult:
    ok: bool
    message: str
    #: Extra facts learned from a successful test — version, site name, etc.
    detail: str = ""

    @property
    def icon(self) -> str:
        return ":material/check_circle:" if self.ok else ":material/error:"


@dataclass(frozen=True)
class ManagedCredential:
    """One secret the admin console can set."""

    env_key: str
    label: str
    service: str
    #: Where to find this value in the service's own interface.
    where_to_find: str
    #: Companion env var holding the base URL, when the value alone is useless.
    url_key: str | None = None
    url_default: str = ""
    #: True for values that are not secret (a URL, a username). Rendered as a
    #: normal text input rather than a masked one.
    is_secret: bool = True
    #: Compiled shape check. Rejects the obvious paste error before a network
    #: round trip — but never so strict that a legitimate key is refused.
    pattern: str | None = None
    pattern_hint: str = ""
    tester: Callable[[str, str], TestResult] | None = None
    note: str = ""

    def shape_problem(self, value: str) -> str | None:
        if not value:
            return None
        if value != value.strip():
            return "Value has leading or trailing whitespace — likely a paste error."
        if self.pattern and not re.fullmatch(self.pattern, value):
            return self.pattern_hint or "Value does not look like a valid key."
        return None

    def fingerprint(self, value: str) -> str:
        return fingerprint(value)


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------



def _json_object(response, app: str):
    """Parse a response body as a JSON *object*, or explain why not.

    Returns (payload, error). A service that answers with valid JSON that is
    not an object — `[]`, `null`, a bare string — used to crash the admin
    thread at the first `.get()`. A reverse proxy error page can produce
    exactly that.
    """
    try:
        payload = response.json()
    except ValueError:
        return None, f"{app} returned a non-JSON response."
    if not isinstance(payload, dict):
        return None, f"{app} returned an unexpected JSON shape ({type(payload).__name__})."
    return payload, ""

def _arr_tester(app: str) -> Callable[[str, str], TestResult]:
    """Sonarr / Radarr / Prowlarr all speak the same v3 status endpoint."""

    def test(base_url: str, api_key: str) -> TestResult:
        if not base_url:
            return TestResult(False, f"No {app} URL configured.")
        url = f"{base_url.rstrip('/')}/api/v3/system/status"
        try:
            response = requests.get(
                url,
                headers={**_UA, "X-Api-Key": api_key},
                timeout=TEST_TIMEOUT,
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            return TestResult(False, f"Could not reach {app}: {_short(exc)}")
        if response.status_code == 401:
            return TestResult(False, "Rejected: the API key is not valid.")
        if response.status_code == 404:
            return TestResult(
                False,
                "404 from the status endpoint — the URL probably points at "
                "something other than " + app + ".",
            )
        if response.status_code != 200:
            return TestResult(False, f"HTTP {response.status_code} from {app}.")
        payload, shape_error = _json_object(response, app)
        if payload is None:
            return TestResult(False, shape_error)
        version = payload.get("version", "unknown")
        name = payload.get("instanceName") or payload.get("appName") or app
        return TestResult(True, f"Connected to {name}.", f"version {version}")

    return test


def _plex_tester(base_url: str, token: str) -> TestResult:
    if not base_url:
        return TestResult(False, "No Plex URL configured.")
    url = f"{base_url.rstrip('/')}/identity"
    try:
        response = requests.get(
            url,
            headers={**_UA, "X-Plex-Token": token, "Accept": "application/xml"},
            timeout=TEST_TIMEOUT,
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        return TestResult(False, f"Could not reach Plex: {_short(exc)}")
    if response.status_code in (401, 403):
        return TestResult(False, "Rejected: the Plex token is not valid.")
    if response.status_code != 200:
        return TestResult(False, f"HTTP {response.status_code} from Plex.")
    # /identity answers without a token, so a 200 alone proves nothing about
    # the token. Ask for something that genuinely requires authentication.
    try:
        authed = requests.get(
            f"{base_url.rstrip('/')}/library/sections",
            headers={**_UA, "X-Plex-Token": token, "Accept": "application/xml"},
            timeout=TEST_TIMEOUT,
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        return TestResult(False, f"Could not reach Plex libraries: {_short(exc)}")
    if authed.status_code in (401, 403):
        return TestResult(
            False, "Server reachable, but the token was rejected for library access."
        )
    if authed.status_code != 200:
        return TestResult(False, f"HTTP {authed.status_code} reading libraries.")
    sections = len(re.findall(r"<Directory\b", authed.text))
    return TestResult(True, "Plex token accepted.", f"{sections} librar"
                      + ("y" if sections == 1 else "ies") + " visible")


def _unifi_get(base_url: str, api_key: str, path: str):
    """One GET against the Network Integration API. Read-only by construction."""
    return requests.get(
        f"{base_url.rstrip('/')}/proxy/network/integration/v1{path}",
        headers={**_UA, "X-API-KEY": api_key, "Accept": "application/json"},
        timeout=TEST_TIMEOUT,
        # UniFi consoles ship a self-signed certificate and the connection is
        # to a known LAN address. `allow_redirects=False` matters more here
        # than the certificate: a redirect would carry the API key onward to
        # whatever host it named.
        verify=False,
        allow_redirects=False,
    )


def _unifi_tester(base_url: str, api_key: str) -> TestResult:
    """Verify a UniFi key against `/v1/info`, then enrich from `/v1/sites`.

    `/info` is the better first call: it needs no site id, returns almost
    nothing, and separates the three failure modes cleanly — unreachable host,
    rejected key, and firmware predating the Integration API. Testing against
    `/sites` conflated "key is wrong" with "site lookup failed".
    """
    if not base_url:
        return TestResult(False, "No UniFi controller URL configured.")
    try:
        response = _unifi_get(base_url, api_key, "/info")
    except requests.RequestException as exc:
        return TestResult(False, f"Could not reach the controller: {_short(exc)}")

    if response.status_code == 401:
        return TestResult(
            False,
            "Rejected: the API key is not valid. Create one at "
            "Settings → Control Plane → Integrations.",
        )
    if response.status_code == 404:
        return TestResult(
            False,
            "404 — this console does not expose the Network Integration API. "
            "Update UniFi Network on the console.",
        )
    if response.status_code != 200:
        return TestResult(False, f"HTTP {response.status_code} from the controller.")

    payload, shape_error = _json_object(response, "The controller")
    if payload is None:
        return TestResult(False, shape_error)

    from services.unifi import _extract_version

    version = _extract_version(payload) or "unknown"

    # A working key should also enumerate sites; report it if it does, but do
    # not fail the test on it — /info answering 200 already proves the key.
    detail = f"Network {version}"
    try:
        sites_response = _unifi_get(base_url, api_key, "/sites")
        if sites_response.status_code == 200:
            sites_payload, _ = _json_object(sites_response, "The controller")
            sites = (
                sites_payload.get("data", []) if sites_payload is not None else []
            )
            if not isinstance(sites, list):
                sites = []
            names = ", ".join(
                s.get("name", "?") for s in sites[:3] if isinstance(s, dict)
            )
            detail += f" · {len(sites)} site(s): {names}"
    except (requests.RequestException, ValueError):
        detail += " · site list unavailable"

    return TestResult(True, "UniFi API key accepted.", detail)


def _sabnzbd_tester(base_url: str, api_key: str) -> TestResult:
    if not base_url:
        return TestResult(False, "No SABnzbd URL configured.")
    try:
        response = requests.get(
            f"{base_url.rstrip('/')}/api",
            params={"mode": "version", "output": "json", "apikey": api_key},
            headers=_UA,
            timeout=TEST_TIMEOUT,
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        return TestResult(False, f"Could not reach SABnzbd: {_short(exc)}")
    if response.status_code != 200:
        return TestResult(False, f"HTTP {response.status_code} from SABnzbd.")
    payload, shape_error = _json_object(response, "SABnzbd")
    if payload is None:
        return TestResult(False, shape_error)
    if "error" in payload:
        return TestResult(False, f"Rejected: {payload['error']}")
    return TestResult(
        True, "SABnzbd API key accepted.", f"version {payload.get('version', '?')}"
    )


def _tautulli_tester(base_url: str, api_key: str) -> TestResult:
    if not base_url:
        return TestResult(False, "No Tautulli URL configured.")
    try:
        response = requests.get(
            f"{base_url.rstrip('/')}/api/v2",
            params={"apikey": api_key, "cmd": "get_server_friendly_name"},
            headers=_UA,
            timeout=TEST_TIMEOUT,
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        return TestResult(False, f"Could not reach Tautulli: {_short(exc)}")
    if response.status_code != 200:
        return TestResult(False, f"HTTP {response.status_code} from Tautulli.")
    envelope, shape_error = _json_object(response, "Tautulli")
    if envelope is None:
        return TestResult(False, shape_error)
    payload = envelope.get("response")
    if not isinstance(payload, dict):
        return TestResult(False, "Tautulli returned an unexpected JSON shape.")
    if payload.get("result") != "success":
        return TestResult(False, f"Rejected: {payload.get('message', 'invalid key')}")
    return TestResult(True, "Tautulli API key accepted.", str(payload.get("data", "")))


def _short(exc: Exception) -> str:
    """Trim a requests exception to one readable line, without the URL.

    The URL can carry an API key in its query string for some of these
    services, and exception text ends up in logs and screenshots.
    """
    text = str(exc).split("\n")[0]
    text = re.sub(r"apikey=[^&\s'\"]+", "apikey=<redacted>", text, flags=re.I)
    text = re.sub(r"X-Plex-Token=[^&\s'\"]+", "X-Plex-Token=<redacted>", text, flags=re.I)
    return text[:180]


# ---------------------------------------------------------------------------
# The catalogue
# ---------------------------------------------------------------------------

#: `pattern` values are shape checks, not security controls. They exist to
#: catch a truncated paste, not to enforce a format the vendor might change.
CREDENTIALS: tuple[ManagedCredential, ...] = (
    ManagedCredential(
        env_key="UNIFI_API_KEY",
        label="UniFi API key",
        service="UniFi",
        where_to_find=(
            "UniFi console → Settings → Control Plane → Integrations → "
            "Create API Key. Shown once; copy it immediately. A cloud-adopted "
            "console offers the same page at unifi.ui.com."
        ),
        url_key="UNIFI_CONTROLLER_URL",
        url_default="https://10.0.40.1",
        pattern=r"[A-Za-z0-9_\-]{20,120}",
        pattern_hint="UniFi keys are 20+ characters of letters, digits, dash or underscore.",
        tester=_unifi_tester,
        note=(
            "An API key authenticates without the login flow, so email MFA "
            "stays enabled on the account. **Treat it as privileged**: UniFi "
            "issues one scope, and it carries write access to networks, "
            "firewall policies, SSIDs and device actions. This dashboard only "
            "ever sends GET — enforced by test — but anyone holding the key "
            "is not limited to that. Revoke it in the console if it leaks. "
            "IDS/IPS alarm history stays unavailable either way: that is "
            "legacy-API only."
        ),
    ),
    ManagedCredential(
        env_key="PLEX_TOKEN",
        label="Plex token",
        service="Plex",
        where_to_find=(
            "Plex web → play any item → ⋮ → Get Info → View XML, then copy the "
            "X-Plex-Token value from the browser address bar."
        ),
        url_key="PLEX_URL",
        url_default="http://10.0.40.100:32400",
        pattern=r"[A-Za-z0-9_\-]{15,40}",
        pattern_hint="Plex tokens are around 20 characters, letters and digits.",
        tester=_plex_tester,
    ),
    ManagedCredential(
        env_key="SONARR_API_KEY",
        label="Sonarr API key",
        service="Sonarr",
        where_to_find="Sonarr → Settings → General → Security → API Key.",
        url_key="SONARR_URL",
        url_default="http://10.0.40.100:8081",
        pattern=r"[a-f0-9]{32}",
        pattern_hint="Sonarr keys are 32 lowercase hex characters.",
        tester=_arr_tester("Sonarr"),
    ),
    ManagedCredential(
        env_key="RADARR_API_KEY",
        label="Radarr API key",
        service="Radarr",
        where_to_find="Radarr → Settings → General → Security → API Key.",
        url_key="RADARR_URL",
        url_default="http://10.0.40.100:8082",
        pattern=r"[a-f0-9]{32}",
        pattern_hint="Radarr keys are 32 lowercase hex characters.",
        tester=_arr_tester("Radarr"),
    ),
    ManagedCredential(
        env_key="PROWLARR_API_KEY",
        label="Prowlarr API key",
        service="Prowlarr",
        where_to_find="Prowlarr → Settings → General → Security → API Key.",
        url_key="PROWLARR_URL",
        url_default="http://10.0.40.100:8085",
        pattern=r"[a-f0-9]{32}",
        pattern_hint="Prowlarr keys are 32 lowercase hex characters.",
        tester=_arr_tester("Prowlarr"),
    ),
    ManagedCredential(
        env_key="SABNZBD_API_KEY",
        label="SABnzbd API key",
        service="SABnzbd",
        where_to_find="SABnzbd → Config → General → API Key.",
        url_key="SABNZBD_URL",
        url_default="http://10.0.40.100:8080",
        pattern=r"[a-f0-9]{32}",
        pattern_hint="SABnzbd keys are 32 lowercase hex characters.",
        tester=_sabnzbd_tester,
    ),
    ManagedCredential(
        env_key="QBITTORRENT_USER",
        label="qBittorrent username",
        service="qBittorrent",
        where_to_find="qBittorrent → Tools → Options → Web UI → Authentication.",
        url_key="QBITTORRENT_URL",
        url_default="http://10.0.40.100:8086",
        is_secret=False,
    ),
    ManagedCredential(
        env_key="QBITTORRENT_PASSWORD",
        label="qBittorrent password",
        service="qBittorrent",
        where_to_find="The password set in qBittorrent's Web UI options.",
    ),
    ManagedCredential(
        env_key="TAUTULLI_API_KEY",
        label="Tautulli API key",
        service="Tautulli",
        where_to_find="Tautulli → Settings → Web Interface → API → API Key.",
        url_key="TAUTULLI_URL",
        url_default="",
        pattern=r"[a-f0-9]{32,64}",
        pattern_hint="Tautulli keys are 32-64 hex characters.",
        tester=_tautulli_tester,
        note="Optional. Provides Plex watch history the Plex API does not expose.",
    ),
    ManagedCredential(
        env_key="GLUETUN_API_KEY",
        label="Gluetun control API key",
        service="Gluetun",
        where_to_find=(
            "Set in the Gluetun container's own config (HTTP_CONTROL_SERVER_AUTH "
            "role file). Required from Gluetun v3.40 onward."
        ),
        url_key="GLUETUN_CONTROL_URL",
        url_default="",
        note=(
            "Only needed for Gluetun's control server. VPN leak detection works "
            "without it — that check runs inside the container's namespace."
        ),
    ),
)

#: Services the user explicitly asked to be able to configure, surfaced first.
PRIORITY_SERVICES = ("UniFi", "Plex", "Sonarr", "Radarr", "Prowlarr")


def by_service() -> dict[str, list[ManagedCredential]]:
    """Credentials grouped by service, priority services first."""
    groups: dict[str, list[ManagedCredential]] = {}
    for credential in CREDENTIALS:
        groups.setdefault(credential.service, []).append(credential)
    ordered = {name: groups.pop(name) for name in PRIORITY_SERVICES if name in groups}
    ordered.update(dict(sorted(groups.items())))
    return ordered


def find(env_key: str) -> ManagedCredential | None:
    return next((c for c in CREDENTIALS if c.env_key == env_key), None)


def all_env_keys() -> set[str]:
    keys = {c.env_key for c in CREDENTIALS}
    keys |= {c.url_key for c in CREDENTIALS if c.url_key}
    return keys
