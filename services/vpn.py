"""Gluetun / VPN state, leak detection and cause analysis.

Gluetun is the single most operationally critical container on this host: the
whole download and indexer stack joins its network namespace, so when it fails
every dependent service loses DNS and Internet simultaneously while still
reporting "Up". That is exactly what happened on 9 Aug 2026 (AUTH_FAILED loop,
health endpoint returning `500 - did not run yet`, Prowlarr unable to resolve
`api.nzb.life`).

So this module does three things:

1. reads tunnel state, exit IP, provider and endpoint;
2. runs the leak check — the exit IP must differ from the home WAN IP;
3. when unhealthy, reads Gluetun's own logs to name a probable cause rather
   than reporting a bare "unhealthy".
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field

import requests

from services.docker_service import (
    ContainerInfo,
    DockerUnavailable,
    exec_readonly,
    get_container_logs,
)
from utils.cache import ttl_cache
from utils.logging_setup import get_logger

log = get_logger("vpn")


@dataclass
class VpnStatus:
    """Everything known about the tunnel right now."""

    container_present: bool = False
    container_running: bool = False
    #: Docker healthcheck verdict; None when the container defines no check.
    container_healthy: bool | None = None
    tunnel_up: bool | None = None
    public_ip: str | None = None
    location: str = ""
    org: str = ""
    provider: str = ""
    protocol: str = ""
    endpoint: str = ""
    uptime_seconds: float | None = None
    restart_count: int = 0
    dns_ok: bool | None = None
    https_ok: bool | None = None
    auth_failures: int = 0
    reconnects: int = 0
    recent_errors: list[str] = field(default_factory=list)
    error: str = ""
    checked_at: float = field(default_factory=time.time)
    source: str = "docker"


@dataclass
class LeakCheck:
    """Result of comparing the tunnel exit IP against the home WAN IP."""

    #: True = traffic is leaving via the VPN (the desired state).
    passed: bool | None
    vpn_ip: str | None
    wan_ip: str | None
    detail: str

    @property
    def conclusive(self) -> bool:
        return self.passed is not None


#: Log signatures worth naming. Ordered most-specific first; the first match
#: becomes the probable cause.
_LOG_SIGNATURES: tuple[tuple[re.Pattern[str], str, str], ...] = (
    (
        re.compile(r"AUTH_FAILED", re.IGNORECASE),
        "VPN authentication failure",
        "The provider rejected the credentials. Check OPENVPN_USER/OPENVPN_PASSWORD "
        "in the Gluetun environment — NordVPN service credentials are not the same "
        "as the account login.",
    ),
    (
        re.compile(r"TLS Error|TLS handshake failed", re.IGNORECASE),
        "TLS handshake failure to the VPN endpoint",
        "The endpoint may be down or blocked. Try a different server.",
    ),
    (
        re.compile(r"Connection refused|Network is unreachable", re.IGNORECASE),
        "Network path to the VPN endpoint unavailable",
        "Check the host's own Internet connectivity first.",
    ),
    (
        re.compile(r"did not run yet", re.IGNORECASE),
        "Gluetun health server has not completed its first check",
        "Normal briefly after a restart; persistent means the tunnel never came up.",
    ),
    (
        re.compile(r"SIGUSR1|restarting", re.IGNORECASE),
        "Tunnel restart loop",
        "Gluetun is cycling. Read the lines above the restart for the trigger.",
    ),
    (
        re.compile(r"dial tcp.*i/o timeout", re.IGNORECASE),
        "Timeout reaching the VPN endpoint",
        "Provider-side or upstream network issue.",
    ),
)


def analyse_logs(lines: list[str]) -> tuple[str, str, int, int, list[str]]:
    """Derive (cause, recommendation, auth_failures, reconnects, errors) from logs.

    Pure function over log lines so the cause-analysis logic is unit testable
    against captured output from the real incident.
    """
    auth_failures = sum(1 for line in lines if "AUTH_FAILED" in line.upper())
    reconnects = sum(
        1
        for line in lines
        if re.search(r"SIGUSR1|restarting|reconnect", line, re.IGNORECASE)
    )
    errors = [
        line
        for line in lines
        if re.search(r"\bERROR\b|\bFATAL\b|AUTH_FAILED|TLS Error", line, re.IGNORECASE)
    ][-8:]

    for pattern, cause, recommendation in _LOG_SIGNATURES:
        if any(pattern.search(line) for line in lines):
            return cause, recommendation, auth_failures, reconnects, errors
    return "", "", auth_failures, reconnects, errors


def get_vpn_status(
    container: ContainerInfo | None,
    container_name: str,
    ip_check_url: str = "https://ipinfo.io/json",
    provider: str = "nordvpn",
    protocol: str = "openvpn",
    control_url: str = "",
    api_key: str | None = None,
    timeout: float = 10.0,
    read_logs: bool = True,
) -> VpnStatus:
    """Assemble the full VPN picture.

    `container` comes from the shared Docker inventory so this does not re-list
    containers. Logs are only read when something already looks wrong, keeping
    the healthy-path cost to a single exec.
    """
    status = VpnStatus(provider=provider, protocol=protocol)

    if container is None:
        status.error = f"Container {container_name} not found"
        return status

    status.container_present = True
    status.container_running = container.running
    status.container_healthy = container.healthy
    status.uptime_seconds = container.uptime_seconds
    status.restart_count = container.restart_count

    # Provider/protocol from the container's own environment beats config
    # defaults, since that is what Gluetun is actually running with.
    env_provider = container.labels.get("vpn_service_provider")
    if env_provider:
        status.provider = env_provider

    if not container.running:
        status.tunnel_up = False
        status.error = f"Container state: {container.state}"
        if read_logs:
            _attach_log_analysis(status, container_name)
        return status

    # The exit IP has to be observed from *inside* Gluetun's namespace; from
    # the host we would just measure the home WAN link.
    ip_info = _exit_ip_via_container(container_name, ip_check_url, timeout)
    if ip_info is not None:
        status.public_ip = ip_info.get("ip")
        status.location = ", ".join(
            part
            for part in (
                ip_info.get("city", ""),
                ip_info.get("region", ""),
                ip_info.get("country", ""),
            )
            if part
        )
        status.org = ip_info.get("org", "")
        status.tunnel_up = bool(status.public_ip)
        status.dns_ok = True
        status.https_ok = True
    else:
        status.tunnel_up = False
        status.dns_ok, status.https_ok = _probe_from_container(container_name, timeout)

    if control_url:
        _augment_from_control_server(status, control_url, api_key, timeout)

    unhealthy = (
        status.container_healthy is False
        or status.tunnel_up is False
        or status.dns_ok is False
    )
    if read_logs and unhealthy:
        _attach_log_analysis(status, container_name)

    return status


@ttl_cache(seconds=90)
def _exit_ip_via_container(
    container_name: str, url: str, timeout: float
) -> dict | None:
    """Fetch the tunnel's public IP from inside the container.

    Tries wget then curl; Gluetun's Alpine base ships wget, but the image
    contents are not something to assume.

    Cached for a minute: this is a `docker exec` plus an outbound HTTPS request
    through the tunnel, easily a second or two, and the exit IP does not change
    between page refreshes under normal operation. A tunnel that drops is still
    caught within the TTL, and the leak check is re-evaluated every render
    against the cached pair.
    """
    for argv in (
        ["wget", "-qO-", "-T", "8", url],
        ["curl", "-s", "-m", "8", url],
    ):
        try:
            code, output = exec_readonly(container_name, argv, timeout)
        except Exception as exc:  # noqa: BLE001
            log.debug("exec %s failed: %s", argv[0], exc)
            continue
        if code != 0 or not output:
            continue
        try:
            payload = json.loads(output)
        except json.JSONDecodeError:
            # Some endpoints return a bare IP string.
            candidate = output.strip()
            if re.fullmatch(r"[0-9a-fA-F.:]+", candidate):
                return {"ip": candidate}
            continue
        if isinstance(payload, dict) and payload.get("ip"):
            return payload
    return None


def _probe_from_container(
    container_name: str, timeout: float
) -> tuple[bool | None, bool | None]:
    """Separate DNS failure from HTTPS failure inside the namespace."""
    dns_ok: bool | None = None
    https_ok: bool | None = None
    try:
        code, _ = exec_readonly(
            container_name, ["getent", "hosts", "cloudflare.com"], timeout
        )
        dns_ok = code == 0
    except Exception:  # noqa: BLE001
        dns_ok = None
    try:
        code, _ = exec_readonly(
            container_name,
            ["wget", "-q", "--spider", "-T", "6", "https://1.1.1.1"],
            timeout,
        )
        https_ok = code == 0
    except Exception:  # noqa: BLE001
        https_ok = None
    return dns_ok, https_ok


def _augment_from_control_server(
    status: VpnStatus, control_url: str, api_key: str | None, timeout: float
) -> None:
    """Read Gluetun's HTTP control server, when credentials are available.

    Gluetun v3.40+ requires auth on this API. On this host the control server
    listens on :8000 with an auth config file, so without GLUETUN_API_KEY the
    call is skipped rather than logged as a failure.
    """
    if not api_key:
        return
    headers = {"X-API-Key": api_key}
    base = control_url.rstrip("/")
    try:
        response = requests.get(
            f"{base}/v1/openvpn/status",
            headers=headers,
            timeout=timeout,
            allow_redirects=False,
        )
        if response.ok:
            payload = response.json()
            if not isinstance(payload, dict):
                payload = {}
            state = str(payload.get("status", "")).lower()
            if state:
                status.tunnel_up = state == "running"
    except (requests.RequestException, ValueError) as exc:
        log.debug("Gluetun control server unavailable: %s", exc)

    try:
        response = requests.get(
            f"{base}/v1/openvpn/portforwarded",
            headers=headers,
            timeout=timeout,
            allow_redirects=False,
        )
        if response.ok:
            forwarded = response.json()
            port = forwarded.get("port") if isinstance(forwarded, dict) else None
            if port:
                status.endpoint = f"{status.endpoint} (forwarded port {port})".strip()
    except (requests.RequestException, ValueError):
        pass


def _attach_log_analysis(status: VpnStatus, container_name: str) -> None:
    try:
        lines = get_container_logs(container_name, lines=120)
    except DockerUnavailable:
        return
    if not lines:
        return
    cause, recommendation, auth_failures, reconnects, errors = analyse_logs(lines)
    status.auth_failures = auth_failures
    status.reconnects = reconnects
    status.recent_errors = errors
    if cause:
        status.error = cause
        # Stash the recommendation where the alert builder can find it.
        status.recent_errors = [f"Recommended: {recommendation}", *errors]


def check_leak(vpn_ip: str | None, wan_ip: str | None) -> LeakCheck:
    """The core safety check: the download stack must not use the home WAN IP.

    Returns `passed=None` when either address is unknown — an inconclusive
    check must never be rendered as a pass, because a pass here is a safety
    claim about where torrent traffic is going.
    """
    if not vpn_ip and not wan_ip:
        return LeakCheck(
            passed=None,
            vpn_ip=None,
            wan_ip=None,
            detail="Neither the VPN exit IP nor the home WAN IP could be determined.",
        )
    if not vpn_ip:
        return LeakCheck(
            passed=None,
            vpn_ip=None,
            wan_ip=wan_ip,
            detail=(
                "VPN exit IP unknown — the tunnel may be down. Cannot confirm that "
                "download traffic is leaving through the VPN."
            ),
        )
    if not wan_ip:
        return LeakCheck(
            passed=None,
            vpn_ip=vpn_ip,
            wan_ip=None,
            detail=(
                "Home WAN IP unknown, so the comparison cannot be made. "
                "Check outbound HTTPS from the host."
            ),
        )
    if vpn_ip == wan_ip:
        return LeakCheck(
            passed=False,
            vpn_ip=vpn_ip,
            wan_ip=wan_ip,
            detail=(
                "The download stack's public IP matches the home WAN IP. Traffic "
                "is not going through the VPN."
            ),
        )
    return LeakCheck(
        passed=True,
        vpn_ip=vpn_ip,
        wan_ip=wan_ip,
        detail="Download stack exits on a different public IP from the home WAN.",
    )
