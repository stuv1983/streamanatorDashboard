"""Central configuration for the Streamanator Dashboard.

Every tunable lives here or in `health/thresholds.py`. Nothing in this module
reads a secret from source: credentials arrive via environment variables (or a
`.env` file loaded at import time), never from literals.

Values default to what was observed on the live `streamanator` host on
13 Aug 2026. Where the live system disagreed with the project README, the live
system won and the discrepancy is recorded in `docs/DISCREPANCIES.md`.
"""

from __future__ import annotations

import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

# --------------------------------------------------------------------------
# .env parsing — the ONE parser, shared with admin/env_file.py
# --------------------------------------------------------------------------
#
# The writer (`admin/env_file.py`) and this loader previously disagreed about
# escaping: a password containing quotes or backslashes round-tripped through
# the writer's `_quote()` correctly, but the naive `strip('"')` here turned it
# into a *different* credential at runtime — a silent failure that looks like
# a wrong password at the service end. One parser, used by both sides.

PROJECT_ROOT = Path(__file__).resolve().parent

_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
_ESCAPED = re.compile(r"\\(.)")


def parse_env_value(raw: str) -> str:
    """Decode one .env value exactly as the writer encodes it.

    Double-quoted values un-escape ``\\"`` and ``\\\\`` in a single pass (a
    two-pass ``.replace`` chain mis-decodes ``\\\\"``). Single-quoted values
    are literal. Bare values lose any trailing ``  # comment``.
    """
    text = raw.strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        return _ESCAPED.sub(r"\1", text[1:-1])
    if len(text) >= 2 and text[0] == text[-1] == "'":
        return text[1:-1]
    return re.split(r"\s+#", text, maxsplit=1)[0].strip()


def parse_env_file(path: str | Path) -> dict[str, str]:
    """Parse a .env into a dict. Missing file yields {}. Duplicates: last wins.

    Last-wins matches what a shell sourcing the file would do, and both the
    import-time load and `reload_settings()` go through here so the two can
    never disagree about which duplicate is authoritative again.
    """
    file = Path(path)
    if not file.is_file():
        return {}
    values: dict[str, str] = {}
    try:
        for raw in file.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            match = _ENV_LINE.match(line)
            if match:
                values[match.group(1)] = parse_env_value(match.group(2))
    except OSError:
        # A malformed or unreadable .env must never stop the dashboard booting.
        pass
    return values


# --------------------------------------------------------------------------
# The effective environment snapshot
# --------------------------------------------------------------------------
#
# Configuration reads go through `_ENV`, an immutable-in-practice dict that is
# only ever *replaced whole* under `_ENV_LOCK` — never mutated key-by-key.
# `os.environ` is populated once at import (so child processes inherit the
# values) and never touched again: POSIX environment mutation is not
# thread-safe against concurrent readers, and a reload used to update it one
# key at a time while the sampler thread, request threads and subprocess
# setup could all be reading it mid-change.

_ENV_LOCK = threading.RLock()

_env_path = Path(os.environ.get("STREAMANATOR_ENV_FILE", PROJECT_ROOT / ".env"))
_file_values = parse_env_file(_env_path)
for _key, _value in _file_values.items():
    os.environ.setdefault(_key, _value)

#: The merged view every env_* helper reads. At import, identical to
#: os.environ (which already includes the .env values via setdefault above).
_ENV: dict[str, str] = dict(os.environ)

#: Keys that have ever been sourced from the .env file. On reload, these are
#: dropped from the os.environ base before the file is overlaid, so deleting a
#: key from the file genuinely removes it — without this, the import-time copy
#: in os.environ would resurrect it forever.
_FILE_KEYS: set[str] = set(_file_values)

del _file_values


def _effective(key: str) -> str | None:
    return _ENV.get(key)


# --------------------------------------------------------------------------
# Small env helpers
# --------------------------------------------------------------------------


def env_str(key: str, default: str = "") -> str:
    value = _effective(key) or default
    return value.strip() if value else default


def env_opt(key: str) -> str | None:
    """Return an env var, or None when unset/blank. Used for secrets."""
    value = (_effective(key) or "").strip()
    return value or None


def env_int(key: str, default: int) -> int:
    try:
        return int((_effective(key) or "").strip() or default)
    except ValueError:
        return default


def env_float(key: str, default: float) -> float:
    try:
        return float((_effective(key) or "").strip() or default)
    except ValueError:
        return default


def env_bool(key: str, default: bool = False) -> bool:
    raw = (_effective(key) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def env_list(key: str, default: Sequence[str] = ()) -> list[str]:
    raw = (_effective(key) or "").strip()
    if not raw:
        return list(default)
    return [item.strip() for item in raw.split(",") if item.strip()]


# --------------------------------------------------------------------------
# Host / identity
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class HostConfig:
    hostname: str = env_str("STREAMANATOR_HOST", "streamanator")
    address: str = env_str("STREAMANATOR_ADDR", "10.0.40.100")
    primary_user: str = env_str("STREAMANATOR_USER", "arm")
    vlan: str = "VLAN 40 - Media-DMZ"
    timezone: str = env_str("STREAMANATOR_TZ", "Australia/Melbourne")
    #: `nproc` on the live host. Used to judge load average against core count.
    cpu_cores: int = env_int("STREAMANATOR_CPU_CORES", 24)


@dataclass(frozen=True)
class Vlan:
    vlan_id: int
    name: str
    subnet: str
    trusted: bool


VLANS: tuple[Vlan, ...] = (
    Vlan(10, "Home", "10.0.10.0/24", True),
    Vlan(20, "IoT", "10.0.20.0/24", False),
    Vlan(30, "Guest", "10.0.30.0/24", False),
    Vlan(40, "Media", "10.0.40.0/24", False),
    Vlan(50, "DMZ", "10.0.50.0/24", True),
)


# --------------------------------------------------------------------------
# Telemetry sources
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class PrometheusConfig:
    """Prometheus is the *preferred* source but is optional.

    When `PROMETHEUS_URL` is unset the dashboard falls back to local collectors
    plus its own SQLite history store, so it is fully functional either way.
    The 13 Aug 2026 survey found no Prometheus running; `deploy/monitoring-stack/`
    now ships one, and `deploy.sh` sets this URL when it is brought up.
    """

    url: str = env_str("PROMETHEUS_URL", "")
    timeout_seconds: float = env_float("PROMETHEUS_TIMEOUT", 4.0)
    #: A scrape older than this makes a Prometheus-derived value UNKNOWN/STALE.
    stale_after_seconds: int = env_int("PROMETHEUS_STALE_AFTER", 180)

    @property
    def configured(self) -> bool:
        return bool(self.url)


@dataclass(frozen=True)
class GrafanaConfig:
    url: str = env_str("GRAFANA_URL", "")

    @property
    def configured(self) -> bool:
        return bool(self.url)


@dataclass(frozen=True)
class UnifiConfig:
    """UniFi telemetry via the Network Integration API (API key, MFA-compatible).

    `default_factory` for the same reason as `AppApiConfig` — these are
    settable from the admin console and must apply on reload, not on restart.
    """

    exporter_url: str = field(default_factory=lambda: env_str("UNIFI_EXPORTER_URL", ""))
    controller_url: str = field(
        default_factory=lambda: env_str("UNIFI_CONTROLLER_URL", "")
    )
    api_key: str | None = field(default_factory=lambda: env_opt("UNIFI_API_KEY"))
    site: str = field(default_factory=lambda: env_str("UNIFI_SITE", "default"))
    verify_tls: bool = field(default_factory=lambda: env_bool("UNIFI_VERIFY_TLS", False))
    #: Path to the console's CA or pinned certificate. When set, TLS is
    #: verified against it — strictly better than verify_tls=False for a key
    #: that carries write scope. Export it once with:
    #:   openssl s_client -connect 10.0.40.1:443 </dev/null 2>/dev/null \
    #:     | openssl x509 > unifi-console.pem
    ca_bundle: str = field(default_factory=lambda: env_str("UNIFI_CA_BUNDLE", ""))

    @property
    def tls_verify(self) -> bool | str:
        """What to hand to requests' `verify=`: bundle path if set, else bool."""
        return self.ca_bundle if self.ca_bundle else self.verify_tls

    @property
    def configured(self) -> bool:
        return bool(self.exporter_url or (self.controller_url and self.api_key))


@dataclass(frozen=True)
class BlackboxConfig:
    url: str = env_str("BLACKBOX_URL", "")

    @property
    def configured(self) -> bool:
        return bool(self.url)


@dataclass(frozen=True)
class LocalCollectorConfig:
    """Direct, read-only interrogation of the host.

    Only used for data Prometheus cannot supply, or (today) for everything,
    because no Prometheus server exists yet. Every collector is timeout
    protected and cached; none of them mutate the system.
    """

    enabled: bool = env_bool("LOCAL_COLLECTORS", True)
    command_timeout: float = env_float("LOCAL_COMMAND_TIMEOUT", 5.0)
    proc_mdstat: str = env_str("PROC_MDSTAT", "/proc/mdstat")
    docker_socket: str = env_str("DOCKER_SOCKET", "/var/run/docker.sock")
    #: smartctl needs root. Left False until the sudoers drop-in in
    #: deploy/sudoers-smartctl is installed, or a smartctl exporter is running.
    smartctl_via_sudo: bool = env_bool("SMARTCTL_SUDO", False)
    smartctl_path: str = env_str("SMARTCTL_PATH", "/usr/sbin/smartctl")


# --------------------------------------------------------------------------
# Storage / RAID
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class RaidConfig:
    device: str = env_str("RAID_DEVICE", "md127")
    level: str = "raid5"
    required_members: int = env_int("RAID_REQUIRED_MEMBERS", 4)


@dataclass(frozen=True)
class DiskConfig:
    """A physical disk, identified by serial — never by /dev/sdX.

    Device letters were observed to move between boots on this host (the
    11 Aug 2026 incident), so serial is the only stable key.
    """

    serial: str
    model: str
    role: str
    #: Disks with a known history of SATA-path errors get delta-focused display.
    watch_crc: bool = False


#: Verified against `lsblk -o NAME,SIZE,MODEL,SERIAL` on 13 Aug 2026.
DISKS: tuple[DiskConfig, ...] = (
    DiskConfig("WPV2E65M", "ST8000VN002-2ZM1", "RAID5 member (md127)"),
    DiskConfig("WPV36EV6", "ST8000VN002-2ZM1", "RAID5 member (md127)"),
    DiskConfig("WPV2E6KL", "ST8000VN002-2ZM1", "RAID5 member (md127)"),
    DiskConfig(
        "WPV2E6LL",
        "ST8000VN002-2ZM1",
        "RAID5 member (md127)",
        watch_crc=True,
    ),
    DiskConfig("S2ZWNDAHA21787", "SAMSUNG MZ7TY256", "Boot / root LVM"),
    DiskConfig("2518106901831", "BIWIN M100 1TB", "Download staging (/mnt/ssd)"),
    DiskConfig("2246AP402020", "Portable SSD", "Backup target (/mnt/backup)"),
)

#: The disk with the documented UDMA CRC history. Its *delta* matters more
#: than its absolute count, which sat near 5670 after the Aug 2026 recovery.
CRC_WATCH_SERIAL: str = env_str("CRC_WATCH_SERIAL", "WPV2E6LL")


@dataclass(frozen=True)
class Filesystem:
    mountpoint: str
    label: str
    #: Forecasting is only meaningful on filesystems that actually grow.
    forecast: bool = True
    critical: bool = False


#: `df -hT` on 13 Aug 2026. /mnt/backup and /boot were absent from the README.
FILESYSTEMS: tuple[Filesystem, ...] = (
    Filesystem("/mnt/media", "Media (RAID5 md127)", forecast=True, critical=True),
    Filesystem("/mnt/ssd", "Download staging (SSD)", forecast=True, critical=True),
    Filesystem("/mnt/backup", "Backup target (portable SSD)", forecast=True),
    Filesystem("/", "Root", forecast=True, critical=True),
    Filesystem("/boot", "Boot", forecast=False),
)

MEDIA_DIRECTORIES: tuple[str, ...] = (
    "/mnt/media/movies",
    "/mnt/media/tv",
    "/mnt/media/photos",
    "/mnt/media/music",
)


# --------------------------------------------------------------------------
# Containers and applications
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ExpectedContainer:
    """A container the dashboard insists should exist.

    `name` is the live container name as reported by `docker ps` on
    13 Aug 2026. The media stack has mixed Compose v1/v2 naming
    (`media-vpn_sonarr_1` vs `media-vpn-sabnzbd-1`) because SABnzbd was
    recreated under Compose v2 during the 11 Aug update.
    """

    name: str
    display: str
    stack: str
    #: True when the container shares Gluetun's network namespace, so its
    #: connectivity fails whenever Gluetun does.
    behind_vpn: bool = False
    critical: bool = True


EXPECTED_CONTAINERS: tuple[ExpectedContainer, ...] = (
    ExpectedContainer("media-vpn_gluetun_1", "Gluetun", "media-vpn"),
    ExpectedContainer("media-vpn-sabnzbd-1", "SABnzbd", "media-vpn", behind_vpn=True),
    ExpectedContainer("media-vpn_sonarr_1", "Sonarr", "media-vpn", behind_vpn=True),
    ExpectedContainer("media-vpn_radarr_1", "Radarr", "media-vpn", behind_vpn=True),
    ExpectedContainer("media-vpn_prowlarr_1", "Prowlarr", "media-vpn", behind_vpn=True),
    ExpectedContainer(
        "media-vpn_qbittorrent_1", "qBittorrent", "media-vpn", behind_vpn=True
    ),
    ExpectedContainer("immich-server", "Immich server", "immich"),
    ExpectedContainer("immich-microservices", "Immich microservices", "immich"),
    ExpectedContainer("immich-machine-learning", "Immich ML", "immich", critical=False),
    ExpectedContainer("immich-db", "Immich database", "immich"),
    ExpectedContainer("immich-redis", "Immich Redis", "immich"),
)

#: Gluetun publishes the media stack's ports on the host, so every one of these
#: host ports actually belongs to the gluetun container.
GLUETUN_PUBLISHED_PORTS: dict[int, str] = {
    8080: "SABnzbd",
    8081: "Sonarr (container 8989)",
    8082: "Radarr (container 7878)",
    8085: "Prowlarr (container 9696)",
    8086: "qBittorrent",
    6881: "qBittorrent BitTorrent",
}


@dataclass(frozen=True)
class ServiceEndpoint:
    """A synthetically probed service."""

    key: str
    display: str
    url: str
    #: HTTP statuses treated as "the application answered correctly".
    expect_status: tuple[int, ...] = (200,)
    critical: bool = False
    #: How the service is hosted — shown on the diagnostics page.
    hosting: str = ""


HOST_ADDR = env_str("STREAMANATOR_ADDR", "10.0.40.100")

def _build_service_endpoints() -> tuple[ServiceEndpoint, ...]:
    """Build the probe endpoint list from the current environment.

    A function rather than a module constant so a URL changed from the
    admin console applies on `reload_settings()` instead of waiting for a
    process restart. `Settings.endpoints` calls this per instantiation.
    """
    # Prometheus and Grafana are optional and their hosting label is derived,
    # not hard-coded: once deploy/monitoring-stack/deploy.sh runs it sets these
    # URLs, and the label must flip from "not deployed" to the live location
    # rather than freezing on a survey date that has since gone stale.
    prometheus_url = env_str("PROMETHEUS_URL")
    grafana_url = env_str("GRAFANA_URL")
    _stack_hint = "Not deployed — run deploy/monitoring-stack/deploy.sh"
    return (
        ServiceEndpoint(
            "plex",
            "Plex",
            env_str("PLEX_URL", f"http://{HOST_ADDR}:32400") + "/identity",
            critical=True,
            hosting="native systemd (plexmediaserver.service), not Docker",
        ),
        ServiceEndpoint(
            "immich",
            "Immich",
            env_str("IMMICH_URL", f"http://{HOST_ADDR}:2283") + "/api/server/ping",
            critical=True,
            hosting="Docker (immich-server)",
        ),
        ServiceEndpoint(
            "sports_data_lab",
            "Sports Data Lab",
            env_str("SPORTS_DATA_LAB_URL", f"http://{HOST_ADDR}:6969") + "/_stcore/health",
            critical=True,
            hosting="systemd sports-data-lab.service (Streamlit, port 6969)",
        ),
        ServiceEndpoint(
            "aqualog",
            "AquaLog",
            env_str("AQUALOG_URL", f"http://{HOST_ADDR}:8501") + "/_stcore/health",
            hosting="systemd aqualog.service (Streamlit, port 8501)",
        ),
        ServiceEndpoint(
            "sabnzbd",
            "SABnzbd",
            env_str("SABNZBD_URL", f"http://{HOST_ADDR}:8080"),
            hosting="Docker via gluetun published port 8080",
        ),
        ServiceEndpoint(
            "sonarr",
            "Sonarr",
            env_str("SONARR_URL", f"http://{HOST_ADDR}:8081") + "/ping",
            hosting="Docker via gluetun published port 8081",
        ),
        ServiceEndpoint(
            "radarr",
            "Radarr",
            env_str("RADARR_URL", f"http://{HOST_ADDR}:8082") + "/ping",
            hosting="Docker via gluetun published port 8082",
        ),
        ServiceEndpoint(
            "prowlarr",
            "Prowlarr",
            env_str("PROWLARR_URL", f"http://{HOST_ADDR}:8085") + "/ping",
            hosting="Docker via gluetun published port 8085",
        ),
        ServiceEndpoint(
            "qbittorrent",
            "qBittorrent",
            env_str("QBITTORRENT_URL", f"http://{HOST_ADDR}:8086"),
            expect_status=(200, 401, 403),
            hosting="Docker via gluetun published port 8086",
        ),
        ServiceEndpoint(
            "grafana",
            "Grafana",
            grafana_url + "/api/health" if grafana_url else "",
            hosting=(
                "Docker · monitoring stack · 127.0.0.1:3000"
                if grafana_url
                else _stack_hint
            ),
        ),
        ServiceEndpoint(
            "prometheus",
            "Prometheus",
            prometheus_url + "/-/healthy" if prometheus_url else "",
            hosting=(
                "Docker · monitoring stack · 127.0.0.1:9090"
                if prometheus_url
                else _stack_hint
            ),
        ),
    )


#: Snapshot at import time, for modules that import the constant directly.
#: Prefer `get_settings().endpoints`, which reflects later edits.
SERVICE_ENDPOINTS: tuple[ServiceEndpoint, ...] = _build_service_endpoints()


@dataclass(frozen=True)
class AppApiConfig:
    """API credentials. All optional — every consumer degrades to NOT CONFIGURED.

    Set them from the admin console, or extract them into .env with
    `scripts/extract_api_keys.sh`. Never inline them.

    These use `default_factory` rather than a plain default, unlike the rest of
    this module. A plain default is evaluated once, when the class is defined
    at import time, so a credential added through the admin console would not
    take effect until the process restarted — the file on disk would be right
    and the running dashboard would still report NOT CONFIGURED. The factory is
    evaluated per instantiation, which is what makes `reload_settings()` work.
    """

    plex_token: str | None = field(default_factory=lambda: env_opt("PLEX_TOKEN"))
    sonarr_api_key: str | None = field(
        default_factory=lambda: env_opt("SONARR_API_KEY")
    )
    radarr_api_key: str | None = field(
        default_factory=lambda: env_opt("RADARR_API_KEY")
    )
    prowlarr_api_key: str | None = field(
        default_factory=lambda: env_opt("PROWLARR_API_KEY")
    )
    sabnzbd_api_key: str | None = field(
        default_factory=lambda: env_opt("SABNZBD_API_KEY")
    )
    qbittorrent_user: str | None = field(
        default_factory=lambda: env_opt("QBITTORRENT_USER")
    )
    qbittorrent_password: str | None = field(
        default_factory=lambda: env_opt("QBITTORRENT_PASSWORD")
    )
    tautulli_url: str = field(default_factory=lambda: env_str("TAUTULLI_URL", ""))
    tautulli_api_key: str | None = field(
        default_factory=lambda: env_opt("TAUTULLI_API_KEY")
    )
    #: Gluetun's control server requires auth from v3.40 onward.
    gluetun_control_url: str = field(
        default_factory=lambda: env_str("GLUETUN_CONTROL_URL", "")
    )
    gluetun_api_key: str | None = field(
        default_factory=lambda: env_opt("GLUETUN_API_KEY")
    )


# --------------------------------------------------------------------------
# VPN
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class VpnConfig:
    container: str = env_str("GLUETUN_CONTAINER", "media-vpn_gluetun_1")
    provider: str = env_str("VPN_PROVIDER", "nordvpn")
    protocol: str = env_str("VPN_PROTOCOL", "openvpn")
    #: Checked from inside the Gluetun namespace to learn the tunnel exit IP.
    ip_check_url: str = env_str("VPN_IP_CHECK_URL", "https://ipinfo.io/json")
    #: Checked from the host to learn the home WAN IP for the leak comparison.
    wan_ip_check_url: str = env_str("WAN_IP_CHECK_URL", "https://ipinfo.io/json")


# --------------------------------------------------------------------------
# Backups
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class BackupJob:
    key: str
    display: str
    directory: str
    pattern: str
    #: Human description of the schedule, for the UI.
    schedule: str
    #: Days between expected runs — drives the age thresholds.
    expected_interval_days: float
    #: A backup far below this is treated as suspicious/truncated.
    min_plausible_bytes: int
    source: str = ""
    #: Cron weekday numbers (0 = Sunday) the job is scheduled to run on, and
    #: the hour it runs at. Supplied so a *missed run* can be detected directly
    #: rather than inferred from age — a twice-weekly job that skips one run
    #: stays inside its age threshold for days before raw age catches it.
    schedule_weekdays: tuple[int, ...] = ()
    schedule_hour: int = 0
    #: Hours after the scheduled time before a missing run is called missed.
    schedule_grace_hours: float = 3.0


BACKUP_JOBS: tuple[BackupJob, ...] = (
    BackupJob(
        key="sports_data_lab",
        display="Sports Data Lab archive",
        directory=env_str("SPORTS_BACKUP_DIR", "/mnt/media/sportsDBackUp"),
        pattern="*.tar.gz",
        schedule="Wed & Sun 23:00 (cron: 0 23 * * 0,3)",
        expected_interval_days=4.0,
        min_plausible_bytes=1_000_000_000,
        source="/usr/local/sbin/sports-data-backup.sh (root crontab)",
        schedule_weekdays=(0, 3),  # Sunday and Wednesday
        schedule_hour=23,
    ),
    BackupJob(
        key="nightly_system",
        display="Nightly system backup",
        directory=env_str("NIGHTLY_BACKUP_DIR", "/mnt/backup/nightly"),
        pattern="*",
        schedule="Daily 02:00 (backup-nightly.timer)",
        expected_interval_days=1.0,
        min_plausible_bytes=1_000_000,
        source="/usr/local/bin/backup.sh",
        schedule_weekdays=(0, 1, 2, 3, 4, 5, 6),
        schedule_hour=2,
    ),
)

#: Systemd units whose failure the dashboard should call out by name.
WATCHED_UNITS: tuple[str, ...] = (
    "backup-nightly.service",
    "sports-data-lab.service",
    "aqualog.service",
    "plexmediaserver.service",
    "docker.service",
    "mdmonitor.service",
)


@dataclass(frozen=True)
class SportsDatabase:
    key: str
    display: str
    path: str
    #: A database untouched for longer than this is called out as stale.
    max_age_hours: float = 48.0


SPORTS_DB_ROOT = env_str("SPORTS_DATA_LAB_PATH", "/home/arm/projects/sports_data_lab")

SPORTS_DATABASES: tuple[SportsDatabase, ...] = (
    SportsDatabase("afl", "AFL", f"{SPORTS_DB_ROOT}/data/afl/afl.db"),
    SportsDatabase("nba", "NBA", f"{SPORTS_DB_ROOT}/data/nba/nba.db"),
    SportsDatabase("nfl", "NFL", f"{SPORTS_DB_ROOT}/data/nfl/nfl.db"),
    SportsDatabase("mlb", "MLB", f"{SPORTS_DB_ROOT}/data/mlb/mlb.db"),
)


# --------------------------------------------------------------------------
# Security / external exposure
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ExposedPort:
    port: int
    expected: bool
    service: str
    note: str = ""


#: Ports believed to be reachable from the Internet. "Expected" means
#: intentional; anything detected-but-unexpected is a finding.
EXTERNAL_PORTS: tuple[ExposedPort, ...] = (
    ExposedPort(32400, True, "Plex", "Remote access; attracts IDS/IPS scan traffic"),
    ExposedPort(80, False, "Unknown", "Observed open; receiving service undocumented"),
    ExposedPort(443, False, "Unknown", "Observed open; receiving service undocumented"),
)

#: Host ports that should be listening internally. Anything else listening on a
#: non-loopback address is surfaced as unexpected.
EXPECTED_LISTENERS: dict[int, str] = {
    22: "SSH",
    139: "Samba (NetBIOS)",
    445: "Samba (SMB)",
    2283: "Immich",
    6881: "qBittorrent BitTorrent (via gluetun)",
    6969: "Sports Data Lab (Streamlit)",
    8080: "SABnzbd (via gluetun)",
    8081: "Sonarr (via gluetun)",
    8082: "Radarr (via gluetun)",
    8085: "Prowlarr (via gluetun)",
    8086: "qBittorrent (via gluetun)",
    8501: "AquaLog (Streamlit)",
    32400: "Plex",
    env_int("DASHBOARD_PORT", 8600): "Streamanator Dashboard",
}


# --------------------------------------------------------------------------
# Dashboard behaviour
# --------------------------------------------------------------------------

REFRESH_CHOICES: tuple[tuple[str, int], ...] = (
    ("Off", 0),
    ("15 sec", 15),
    ("30 sec", 30),
    ("60 sec", 60),
    ("5 min", 300),
)

DEFAULT_REFRESH_SECONDS = env_int("DASHBOARD_REFRESH_SECONDS", 30)

TIME_RANGES: tuple[tuple[str, int], ...] = (
    ("1h", 3600),
    ("6h", 21600),
    ("24h", 86400),
    ("7d", 604800),
    ("30d", 2592000),
    ("90d", 7776000),
)

DEFAULT_TIME_RANGE = env_str("DASHBOARD_DEFAULT_RANGE", "24h")


@dataclass(frozen=True)
class DashboardConfig:
    port: int = env_int("DASHBOARD_PORT", 8600)
    bind_address: str = env_str("DASHBOARD_BIND", "0.0.0.0")
    #: SQLite time-series used for deltas/forecasts while Prometheus is absent.
    history_path: str = env_str(
        "HISTORY_DB_PATH", str(PROJECT_ROOT / "var" / "history.sqlite3")
    )
    history_retention_days: int = env_int("HISTORY_RETENTION_DAYS", 400)
    #: Background sampler interval. Independent of UI refresh so history keeps
    #: accruing even when nobody has the page open.
    sample_interval_seconds: int = env_int("HISTORY_SAMPLE_INTERVAL", 60)
    log_level: str = env_str("LOG_LEVEL", "INFO")
    log_file: str = env_str("LOG_FILE", "")


@dataclass(frozen=True)
class EmailConfig:
    """SMTP delivery and non-secret notification-state locations.

    Gmail app passwords are credentials, so they stay in the same protected
    ``.env`` as the application's API keys.  Subscription choices and delivery
    state contain no secrets and live in their own atomic JSON store.
    """

    smtp_host: str = field(
        default_factory=lambda: env_str("EMAIL_SMTP_HOST", "smtp.gmail.com")
    )
    smtp_port: int = field(default_factory=lambda: env_int("EMAIL_SMTP_PORT", 465))
    username: str | None = field(
        default_factory=lambda: env_opt("EMAIL_SMTP_USER")
    )
    app_password: str | None = field(
        default_factory=lambda: env_opt("EMAIL_SMTP_APP_PASSWORD")
    )
    sender: str | None = field(default_factory=lambda: env_opt("EMAIL_FROM"))
    timeout_seconds: float = field(
        default_factory=lambda: max(1.0, env_float("EMAIL_SMTP_TIMEOUT", 15.0))
    )
    preferences_path: str = field(
        default_factory=lambda: env_str(
            "NOTIFICATION_CONFIG_PATH",
            str(PROJECT_ROOT / "var" / "notifications.json"),
        )
    )
    poll_interval_seconds: int = field(
        default_factory=lambda: max(60, env_int("NOTIFICATION_POLL_INTERVAL", 300))
    )

    @property
    def configured(self) -> bool:
        return bool(self.smtp_host and self.username and self.app_password)

    @property
    def from_address(self) -> str:
        return self.sender or self.username or ""


@dataclass(frozen=True)
class AuthConfig:
    """Administrative access control.

    The read-only monitoring pages stay open by default. Gating them would
    change what the dashboard is for, and the request was to add an admin
    surface — not to put a login in front of the wall display. Set
    `REQUIRE_AUTH_FOR_ALL=true` if the dashboard ever becomes reachable from a
    VLAN you do not trust, though the standing advice is still not to expose it.
    """

    accounts_path: str = field(
        default_factory=lambda: env_str(
            "ADMIN_ACCOUNTS_PATH", str(PROJECT_ROOT / "var" / "accounts.json")
        )
    )
    audit_path: str = field(
        default_factory=lambda: env_str(
            "ADMIN_AUDIT_PATH", str(PROJECT_ROOT / "var" / "audit.log")
        )
    )
    #: The .env the admin console reads and writes.
    env_file: str = field(
        default_factory=lambda: env_str(
            "STREAMANATOR_ENV_FILE", str(PROJECT_ROOT / ".env")
        )
    )
    require_auth_for_all: bool = field(
        default_factory=lambda: env_bool("REQUIRE_AUTH_FOR_ALL", False)
    )
    #: Master switch for the control surface. Credentials and probe config stay
    #: editable when this is off; only command execution is disabled.
    actions_enabled: bool = field(
        default_factory=lambda: env_bool("ADMIN_ACTIONS_ENABLED", True)
    )
    #: Shown in authenticator apps during TOTP enrolment.
    totp_issuer: str = field(
        default_factory=lambda: env_str("ADMIN_TOTP_ISSUER", "Streamanator Dashboard")
    )


@dataclass(frozen=True)
class Settings:
    """Aggregate settings object. Build once via `get_settings()`."""

    host: HostConfig = field(default_factory=HostConfig)
    auth: AuthConfig = field(default_factory=AuthConfig)
    dashboard: DashboardConfig = field(default_factory=DashboardConfig)
    email: EmailConfig = field(default_factory=EmailConfig)
    prometheus: PrometheusConfig = field(default_factory=PrometheusConfig)
    grafana: GrafanaConfig = field(default_factory=GrafanaConfig)
    unifi: UnifiConfig = field(default_factory=UnifiConfig)
    blackbox: BlackboxConfig = field(default_factory=BlackboxConfig)
    local: LocalCollectorConfig = field(default_factory=LocalCollectorConfig)
    raid: RaidConfig = field(default_factory=RaidConfig)
    vpn: VpnConfig = field(default_factory=VpnConfig)
    api: AppApiConfig = field(default_factory=AppApiConfig)

    vlans: tuple[Vlan, ...] = VLANS
    disks: tuple[DiskConfig, ...] = DISKS
    filesystems: tuple[Filesystem, ...] = FILESYSTEMS
    containers: tuple[ExpectedContainer, ...] = EXPECTED_CONTAINERS
    #: Rebuilt per instantiation so a URL changed in the admin console applies
    #: on `reload_settings()` rather than at the next process restart.
    endpoints: tuple[ServiceEndpoint, ...] = field(
        default_factory=_build_service_endpoints
    )
    backups: tuple[BackupJob, ...] = BACKUP_JOBS
    sports_databases: tuple[SportsDatabase, ...] = SPORTS_DATABASES
    external_ports: tuple[ExposedPort, ...] = EXTERNAL_PORTS

    def endpoint(self, key: str) -> ServiceEndpoint | None:
        return next((e for e in self.endpoints if e.key == key), None)

    def disk(self, serial: str) -> DiskConfig | None:
        return next((d for d in self.disks if d.serial == serial), None)


_SETTINGS: Settings | None = None


def get_settings() -> Settings:
    """Return the process-wide settings singleton."""
    global _SETTINGS
    if _SETTINGS is None:
        _SETTINGS = Settings()
    return _SETTINGS


def reload_settings(env_file: str | Path | None = None) -> Settings:
    """Re-read the .env file and rebuild the settings singleton, atomically.

    Called after the admin console writes a credential, so the change takes
    effect on the next page render instead of at the next restart.

    Semantics, deliberately different from import:

    * At import, an existing environment variable beats the file — a value
      passed by systemd or the shell is an operator decision.
    * On explicit reload, the **file wins** — it is what the operator just
      edited, and the stale copy of a file-sourced key must not shadow it.
    * A key *removed* from the file disappears: keys that were ever
      file-sourced are excluded from the base before the overlay, so deletion
      works without reaching into `os.environ` (which is never mutated here —
      the snapshot is rebuilt and swapped in a single assignment under the
      lock, and a failed `Settings()` build leaves the previous snapshot in
      place).
    """
    global _SETTINGS, _ENV
    path = Path(env_file) if env_file else Path(
        os.environ.get("STREAMANATOR_ENV_FILE", PROJECT_ROOT / ".env")
    )
    with _ENV_LOCK:
        file_values = parse_env_file(path)
        base = {k: v for k, v in os.environ.items() if k not in _FILE_KEYS}
        candidate_env = {**base, **file_values}
        previous = _ENV
        _ENV = candidate_env
        _FILE_KEYS.update(file_values)
        try:
            _SETTINGS = Settings()
        except BaseException:
            _ENV = previous
            raise
        return _SETTINGS
