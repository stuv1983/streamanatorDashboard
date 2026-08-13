"""Application-specific API integrations.

Every function here is optional and returns a status object carrying its own
`configured` / `reachable` flags. Missing credentials produce NOT CONFIGURED,
never a failure — the dashboard is expected to be useful before any API key has
been supplied, and each integration adds detail rather than being required.

No credential is ever read from source: keys arrive through the environment
(see `scripts/extract_api_keys.sh` for pulling them out of the container config
files into a local .env).
"""

from __future__ import annotations

import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Any

import requests

from utils.logging_setup import get_logger

log = get_logger("apps")

_UA = {"User-Agent": "streamanator-dashboard/1.0"}


@dataclass
class AppStatus:
    """Common shape for every application integration."""

    key: str
    display: str
    configured: bool = False
    reachable: bool | None = None
    version: str = ""
    error: str = ""
    detail: dict[str, Any] = field(default_factory=dict)
    checked_at: float = field(default_factory=time.time)

    @property
    def unknown(self) -> bool:
        return self.reachable is None


def _get_json(
    url: str, timeout: float, headers: dict[str, str] | None = None, params: dict | None = None
) -> tuple[dict | list | None, str]:
    """GET returning (payload, error). Never raises.

    Bounded and redirect-refusing (`utils.http.get_bounded`): these calls
    carry API keys in headers, and requests does not reliably strip custom
    headers on a cross-host redirect — so a 3xx is reported as an error, never
    followed. The body is capped in bytes and wall-clock time because
    `timeout=` alone is an inactivity timeout, not a deadline.
    """
    from utils import http as bounded_http

    try:
        response = bounded_http.get_bounded(
            url, timeout=timeout, headers={**_UA, **(headers or {})}, params=params
        )
    except requests.Timeout:
        return None, f"timed out after {timeout}s"
    except requests.RequestException as exc:
        return None, f"{type(exc).__name__}"
    except bounded_http.ResponseTooLarge:
        return None, "response too large"
    except bounded_http.DeadlineExceeded:
        return None, f"deadline exceeded after {timeout}s"
    if 300 <= response.status_code < 400:
        return None, "redirect refused while sending credentials"
    if response.status_code == 401:
        return None, "unauthorised (check API key)"
    if response.status_code >= 400:
        return None, f"HTTP {response.status_code}"
    try:
        return response.json(), ""
    except ValueError:
        return None, "response was not JSON"


# ---------------------------------------------------------------------------
# Plex
# ---------------------------------------------------------------------------


@dataclass
class PlexSession:
    user: str
    title: str
    player: str
    #: One of directplay / directstream / transcode.
    decision: str
    local: bool
    bandwidth_kbps: float | None


@dataclass
class PlexStatus(AppStatus):
    sessions: list[PlexSession] = field(default_factory=list)

    @property
    def stream_count(self) -> int:
        return len(self.sessions)

    @property
    def transcode_count(self) -> int:
        return sum(1 for s in self.sessions if s.decision == "transcode")

    @property
    def remote_count(self) -> int:
        return sum(1 for s in self.sessions if not s.local)

    @property
    def total_bandwidth_kbps(self) -> float | None:
        values = [s.bandwidth_kbps for s in self.sessions if s.bandwidth_kbps]
        return sum(values) if values else None


def get_plex_status(base_url: str, token: str | None, timeout: float = 6.0) -> PlexStatus:
    """Plex availability, version and active sessions.

    `/identity` needs no token, so availability and version work with no
    credentials at all; only the session list requires PLEX_TOKEN.
    """
    status = PlexStatus(key="plex", display="Plex", configured=bool(token))
    base = base_url.rstrip("/")

    try:
        response = requests.get(
            f"{base}/identity", timeout=timeout, headers=_UA, allow_redirects=False
        )
        response.raise_for_status()
        root = ET.fromstring(response.text)
        status.reachable = True
        status.version = root.attrib.get("version", "")
    except requests.RequestException as exc:
        status.reachable = False
        status.error = f"Plex unreachable: {type(exc).__name__}"
        return status
    except ET.ParseError:
        status.reachable = False
        status.error = "Plex returned an unparseable identity document"
        return status

    if not token:
        status.error = "PLEX_TOKEN not set — session detail unavailable"
        return status

    try:
        response = requests.get(
            f"{base}/status/sessions",
            timeout=timeout,
            headers={**_UA, "X-Plex-Token": token, "Accept": "application/xml"},
        )
        response.raise_for_status()
        root = ET.fromstring(response.text)
    except requests.RequestException as exc:
        status.error = f"Session query failed: {type(exc).__name__}"
        return status
    except ET.ParseError:
        status.error = "Session response was not valid XML"
        return status

    sessions: list[PlexSession] = []
    for video in list(root):
        player = video.find("Player")
        user = video.find("User")
        session = video.find("Session")
        transcode = video.find("TranscodeSession")

        # Plex reports the playback decision on the Player element; fall back
        # to the presence of a TranscodeSession when it is absent.
        decision = ""
        if player is not None:
            decision = (player.attrib.get("decision") or "").lower()
        if not decision:
            decision = "transcode" if transcode is not None else "directplay"

        bandwidth = None
        if session is not None and session.attrib.get("bandwidth"):
            try:
                bandwidth = float(session.attrib["bandwidth"])
            except ValueError:
                bandwidth = None

        sessions.append(
            PlexSession(
                user=(user.attrib.get("title", "?") if user is not None else "?"),
                title=video.attrib.get("title", "?"),
                player=(player.attrib.get("title", "?") if player is not None else "?"),
                decision=decision,
                local=(player is not None and player.attrib.get("local") == "1"),
                bandwidth_kbps=bandwidth,
            )
        )
    status.sessions = sessions
    return status


# ---------------------------------------------------------------------------
# Immich
# ---------------------------------------------------------------------------


def get_immich_status(base_url: str, timeout: float = 6.0) -> AppStatus:
    """Immich API health and version. No credentials needed for these endpoints."""
    status = AppStatus(key="immich", display="Immich", configured=True)
    base = base_url.rstrip("/")

    payload, error = _get_json(f"{base}/api/server/ping", timeout)
    if error or not isinstance(payload, dict) or payload.get("res") != "pong":
        status.reachable = False
        status.error = error or "ping did not return pong"
        return status
    status.reachable = True

    version, _ = _get_json(f"{base}/api/server/version", timeout)
    if isinstance(version, dict):
        parts = [version.get("major"), version.get("minor"), version.get("patch")]
        if all(p is not None for p in parts):
            status.version = ".".join(str(p) for p in parts)

    stats, _ = _get_json(f"{base}/api/server/storage", timeout)
    if isinstance(stats, dict):
        status.detail["storage"] = stats
    return status


# ---------------------------------------------------------------------------
# Sonarr / Radarr / Prowlarr (shared *arr v3 API)
# ---------------------------------------------------------------------------


@dataclass
class ArrStatus(AppStatus):
    health_warnings: list[str] = field(default_factory=list)
    queue_count: int | None = None
    #: Sonarr/Radarr: items that failed to import. Prowlarr: failed indexers.
    failure_count: int | None = None
    missing_count: int | None = None
    indexers_total: int | None = None
    indexers_failing: int | None = None


def get_arr_status(
    key: str, display: str, base_url: str, api_key: str | None, timeout: float = 6.0
) -> ArrStatus:
    """Health, queue and failure counts from a Sonarr/Radarr/Prowlarr instance."""
    status = ArrStatus(key=key, display=display, configured=bool(api_key))
    base = base_url.rstrip("/")

    if not api_key:
        status.error = f"{key.upper()}_API_KEY not set"
        return status

    headers = {"X-Api-Key": api_key}

    payload, error = _get_json(f"{base}/api/v3/system/status", timeout, headers)
    if error or not isinstance(payload, dict):
        status.reachable = False
        status.error = error or "unexpected system/status response"
        return status
    status.reachable = True
    status.version = str(payload.get("version", ""))

    health, _ = _get_json(f"{base}/api/v3/health", timeout, headers)
    if isinstance(health, list):
        status.health_warnings = [
            f"{item.get('type', 'warning')}: {item.get('message', '')}".strip()
            for item in health
            if isinstance(item, dict)
        ]

    queue, _ = _get_json(
        f"{base}/api/v3/queue", timeout, headers, params={"pageSize": 1}
    )
    if isinstance(queue, dict) and "totalRecords" in queue:
        status.queue_count = int(queue["totalRecords"])

    if key == "prowlarr":
        indexers, _ = _get_json(f"{base}/api/v1/indexer", timeout, headers)
        if isinstance(indexers, list):
            status.indexers_total = len(indexers)
            status.indexers_failing = sum(
                1 for item in indexers if isinstance(item, dict) and not item.get("enable", True)
            )
        # Prowlarr reports indexer failures through its health endpoint.
        status.failure_count = sum(
            1 for warning in status.health_warnings if "indexer" in warning.lower()
        )
    else:
        wanted, _ = _get_json(
            f"{base}/api/v3/wanted/missing",
            timeout,
            headers,
            params={"pageSize": 1},
        )
        if isinstance(wanted, dict) and "totalRecords" in wanted:
            status.missing_count = int(wanted["totalRecords"])

    return status


# ---------------------------------------------------------------------------
# SABnzbd
# ---------------------------------------------------------------------------


@dataclass
class SabnzbdStatus(AppStatus):
    paused: bool | None = None
    speed_bytes_per_sec: float | None = None
    queue_size: int | None = None
    remaining_mb: float | None = None
    disk_free_gb: float | None = None
    current_job: str = ""
    warnings: int | None = None


def get_sabnzbd_status(
    base_url: str, api_key: str | None, timeout: float = 6.0
) -> SabnzbdStatus:
    status = SabnzbdStatus(key="sabnzbd", display="SABnzbd", configured=bool(api_key))
    if not api_key:
        status.error = "SABNZBD_API_KEY not set"
        return status

    payload, error = _get_json(
        f"{base_url.rstrip('/')}/api",
        timeout,
        params={"mode": "queue", "output": "json", "apikey": api_key},
    )
    if error or not isinstance(payload, dict):
        status.reachable = False
        status.error = error or "unexpected queue response"
        return status

    queue = payload.get("queue")
    if not isinstance(queue, dict):
        status.reachable = False
        status.error = "response did not contain a queue"
        return status

    status.reachable = True
    status.version = str(queue.get("version", ""))
    status.paused = bool(queue.get("paused"))
    try:
        status.speed_bytes_per_sec = float(queue.get("kbpersec", 0)) * 1024.0
    except (TypeError, ValueError):
        status.speed_bytes_per_sec = None
    slots = queue.get("slots") or []
    status.queue_size = len(slots)
    status.current_job = slots[0].get("filename", "") if slots else ""
    for source, target in (("mbleft", "remaining_mb"), ("diskspace1", "disk_free_gb")):
        try:
            setattr(status, target, float(queue.get(source)))
        except (TypeError, ValueError):
            setattr(status, target, None)
    return status


# ---------------------------------------------------------------------------
# qBittorrent
# ---------------------------------------------------------------------------


@dataclass
class QbittorrentStatus(AppStatus):
    download_bytes_per_sec: float | None = None
    upload_bytes_per_sec: float | None = None
    total_torrents: int | None = None
    downloading: int | None = None
    seeding: int | None = None
    stalled: int | None = None
    errored: int | None = None
    peers: int | None = None


def get_qbittorrent_status(
    base_url: str,
    username: str | None,
    password: str | None,
    timeout: float = 6.0,
) -> QbittorrentStatus:
    """qBittorrent transfer and torrent-state summary.

    Uses a short-lived session cookie; credentials are sent once and never
    logged or persisted.
    """
    status = QbittorrentStatus(
        key="qbittorrent", display="qBittorrent", configured=bool(username)
    )
    base = base_url.rstrip("/")
    # Context-managed so the connection pool is closed instead of leaked to
    # the GC on every collection pass.
    with requests.Session() as session:
        return _qbittorrent_with_session(session, base, username, password, timeout, status)


def _qbittorrent_with_session(
    session: requests.Session,
    base: str,
    username: str | None,
    password: str | None,
    timeout: float,
    status: QbittorrentStatus,
) -> QbittorrentStatus:
    session.headers.update(_UA)

    if username:
        try:
            login = session.post(
                f"{base}/api/v2/auth/login",
                data={"username": username, "password": password or ""},
                timeout=timeout,
                headers={"Referer": base},
                allow_redirects=False,
            )
            if login.status_code != 200 or "Fails" in login.text:
                status.reachable = False
                status.error = "Login rejected — check QBITTORRENT_USER/PASSWORD"
                return status
        except requests.RequestException as exc:
            status.reachable = False
            status.error = f"Login failed: {type(exc).__name__}"
            return status
    else:
        status.error = "QBITTORRENT_USER not set — trying unauthenticated"

    try:
        response = session.get(
            f"{base}/api/v2/transfer/info", timeout=timeout, allow_redirects=False
        )
        if response.status_code == 403:
            status.reachable = False
            status.error = "Forbidden — authentication required"
            return status
        response.raise_for_status()
        transfer = response.json()
    except (requests.RequestException, ValueError) as exc:
        status.reachable = False
        status.error = f"transfer/info failed: {type(exc).__name__}"
        return status

    if not isinstance(transfer, dict):
        status.reachable = False
        status.error = "transfer/info returned an unexpected JSON shape"
        return status
    status.reachable = True
    status.download_bytes_per_sec = float(transfer.get("dl_info_speed", 0) or 0)
    status.upload_bytes_per_sec = float(transfer.get("up_info_speed", 0) or 0)

    try:
        response = session.get(
            f"{base}/api/v2/torrents/info", timeout=timeout, allow_redirects=False
        )
        response.raise_for_status()
        torrents = response.json()
    except (requests.RequestException, ValueError):
        return status

    if isinstance(torrents, list):
        status.total_torrents = len(torrents)
        states = [str(t.get("state", "")) for t in torrents]
        status.downloading = sum(1 for s in states if s in {"downloading", "metaDL"})
        status.seeding = sum(1 for s in states if s in {"uploading", "stalledUP"})
        status.stalled = sum(1 for s in states if s == "stalledDL")
        status.errored = sum(1 for s in states if s in {"error", "missingFiles"})
        status.peers = sum(int(t.get("num_leechs", 0) or 0) for t in torrents)
    return status


# ---------------------------------------------------------------------------
# Tautulli (richer Plex sessions)
# ---------------------------------------------------------------------------


def get_tautulli_activity(
    base_url: str, api_key: str | None, timeout: float = 6.0
) -> AppStatus:
    status = AppStatus(key="tautulli", display="Tautulli", configured=bool(api_key))
    if not api_key or not base_url:
        status.error = "TAUTULLI_URL / TAUTULLI_API_KEY not set"
        return status
    payload, error = _get_json(
        f"{base_url.rstrip('/')}/api/v2",
        timeout,
        params={"apikey": api_key, "cmd": "get_activity"},
    )
    if error or not isinstance(payload, dict):
        status.reachable = False
        status.error = error or "unexpected response"
        return status
    data = (payload.get("response") or {}).get("data") or {}
    status.reachable = True
    status.detail = {
        "stream_count": int(data.get("stream_count", 0) or 0),
        "stream_count_transcode": int(data.get("stream_count_transcode", 0) or 0),
        "total_bandwidth": int(data.get("total_bandwidth", 0) or 0),
        "sessions": data.get("sessions", []),
    }
    return status
