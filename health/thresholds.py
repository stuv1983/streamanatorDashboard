"""Every threshold in one place.

Nothing elsewhere in the codebase hard-codes a limit. Values can be overridden
per-deployment through the environment so tuning does not require a code
change.

The numbers come from the spec, tightened where the live host justified it —
`/mnt/media` is already at 78%, so an 80% warning would fire almost
immediately and then never mean anything again; the storage rules therefore
lean on *forecast* dates rather than the bare percentage for that filesystem.
"""

from __future__ import annotations

from dataclasses import dataclass

from config import env_float, env_int


@dataclass(frozen=True)
class HostThresholds:
    cpu_warning_percent: float = env_float("TH_CPU_WARNING", 90.0)
    cpu_critical_percent: float = env_float("TH_CPU_CRITICAL", 97.0)
    #: Sustained duration before a CPU alert is raised, in seconds.
    cpu_sustained_seconds: int = env_int("TH_CPU_SUSTAINED", 600)
    memory_available_warning_percent: float = env_float("TH_MEM_AVAIL_WARNING", 10.0)
    memory_available_critical_percent: float = env_float("TH_MEM_AVAIL_CRITICAL", 5.0)
    swap_warning_percent: float = env_float("TH_SWAP_WARNING", 50.0)
    swap_critical_percent: float = env_float("TH_SWAP_CRITICAL", 80.0)
    iowait_warning_percent: float = env_float("TH_IOWAIT_WARNING", 20.0)
    iowait_critical_percent: float = env_float("TH_IOWAIT_CRITICAL", 40.0)
    #: Load average is judged relative to core count (24 on this host).
    load_warning_ratio: float = env_float("TH_LOAD_WARNING_RATIO", 1.0)
    load_critical_ratio: float = env_float("TH_LOAD_CRITICAL_RATIO", 2.0)
    cpu_temp_warning: float = env_float("TH_CPU_TEMP_WARNING", 80.0)
    cpu_temp_critical: float = env_float("TH_CPU_TEMP_CRITICAL", 90.0)
    #: A host up for less than this probably rebooted unexpectedly.
    recent_boot_seconds: int = env_int("TH_RECENT_BOOT", 1800)


@dataclass(frozen=True)
class StorageThresholds:
    warning_percent: float = env_float("TH_FS_WARNING", 80.0)
    high_percent: float = env_float("TH_FS_HIGH", 90.0)
    critical_percent: float = env_float("TH_FS_CRITICAL", 95.0)
    inode_warning_percent: float = env_float("TH_INODE_WARNING", 80.0)
    #: Forecast horizons: a filesystem predicted to fill inside these windows
    #: is flagged even when its current percentage is still acceptable.
    forecast_warning_days: float = env_float("TH_FORECAST_WARNING_DAYS", 90.0)
    forecast_critical_days: float = env_float("TH_FORECAST_CRITICAL_DAYS", 30.0)
    #: Minimum history before a growth forecast is offered at all.
    min_forecast_history_days: float = env_float("TH_MIN_FORECAST_DAYS", 3.0)
    #: Minimum R² for a linear fit to be considered trustworthy.
    min_forecast_r_squared: float = env_float("TH_MIN_FORECAST_R2", 0.5)


@dataclass(frozen=True)
class DiskThresholds:
    temp_warning: float = env_float("TH_DISK_TEMP_WARNING", 50.0)
    temp_critical: float = env_float("TH_DISK_TEMP_CRITICAL", 55.0)
    temp_watch: float = env_float("TH_DISK_TEMP_WATCH", 45.0)
    #: Any pending or offline-uncorrectable sector is critical: those are
    #: unreadable blocks, not a statistic to trend.
    pending_sectors_critical: int = env_int("TH_PENDING_SECTORS", 0)
    offline_uncorrectable_critical: int = env_int("TH_OFFLINE_UNCORRECTABLE", 0)
    #: CRC is judged on its *delta*. A large static count is a scar; a rising
    #: one is an active fault in the SATA data path.
    crc_delta_warning: int = env_int("TH_CRC_DELTA_WARNING", 1)
    crc_delta_critical: int = env_int("TH_CRC_DELTA_CRITICAL", 50)
    reallocated_delta_warning: int = env_int("TH_REALLOC_DELTA_WARNING", 1)
    command_timeout_delta_warning: int = env_int("TH_CMD_TIMEOUT_DELTA", 1)


@dataclass(frozen=True)
class NetworkThresholds:
    latency_warning_ms: float = env_float("TH_LATENCY_WARNING", 100.0)
    latency_critical_ms: float = env_float("TH_LATENCY_CRITICAL", 250.0)
    packet_loss_warning_percent: float = env_float("TH_LOSS_WARNING", 5.0)
    packet_loss_critical_percent: float = env_float("TH_LOSS_CRITICAL", 15.0)
    #: Internet must be down for this long before it is called CRITICAL,
    #: so a single dropped probe does not page anyone.
    internet_down_seconds: int = env_int("TH_INTERNET_DOWN", 120)
    gateway_cpu_warning: float = env_float("TH_GW_CPU_WARNING", 85.0)
    gateway_memory_warning: float = env_float("TH_GW_MEM_WARNING", 90.0)


@dataclass(frozen=True)
class ContainerThresholds:
    #: Restarts within the observation window that indicate a crash loop.
    restart_delta_warning: int = env_int("TH_RESTART_DELTA_WARNING", 1)
    restart_delta_critical: int = env_int("TH_RESTART_DELTA_CRITICAL", 3)
    #: A container up for less than this restarted very recently.
    recent_start_seconds: int = env_int("TH_RECENT_START", 900)
    memory_percent_warning: float = env_float("TH_CONTAINER_MEM_WARNING", 90.0)


@dataclass(frozen=True)
class BackupThresholds:
    #: Multiples of the job's expected interval before warning/critical.
    warning_days: float = env_float("TH_BACKUP_WARNING_DAYS", 4.0)
    critical_days: float = env_float("TH_BACKUP_CRITICAL_DAYS", 7.0)
    destination_full_percent: float = env_float("TH_BACKUP_DEST_FULL", 90.0)
    #: A backup that shrank by more than this against its predecessor is
    #: suspicious even if it is above the absolute minimum size.
    shrink_warning_percent: float = env_float("TH_BACKUP_SHRINK", 25.0)


@dataclass(frozen=True)
class ProbeThresholds:
    latency_warning_ms: float = env_float("TH_PROBE_LATENCY_WARNING", 2000.0)
    latency_critical_ms: float = env_float("TH_PROBE_LATENCY_CRITICAL", 5000.0)
    tls_expiry_warning_days: float = env_float("TH_TLS_WARNING_DAYS", 30.0)
    tls_expiry_high_days: float = env_float("TH_TLS_HIGH_DAYS", 14.0)
    tls_expiry_critical_days: float = env_float("TH_TLS_CRITICAL_DAYS", 7.0)


@dataclass(frozen=True)
class FreshnessThresholds:
    """How old a measurement may be before it is downgraded to UNKNOWN."""

    default_seconds: int = env_int("TH_STALE_DEFAULT", 180)
    prometheus_seconds: int = env_int("TH_STALE_PROMETHEUS", 180)
    #: Local collectors run per-render, so their budget is short.
    local_seconds: int = env_int("TH_STALE_LOCAL", 120)
    #: Probes and IP lookups are sampled less often.
    probe_seconds: int = env_int("TH_STALE_PROBE", 300)
    smart_seconds: int = env_int("TH_STALE_SMART", 3600)


@dataclass(frozen=True)
class Thresholds:
    host: HostThresholds = HostThresholds()
    storage: StorageThresholds = StorageThresholds()
    disk: DiskThresholds = DiskThresholds()
    network: NetworkThresholds = NetworkThresholds()
    container: ContainerThresholds = ContainerThresholds()
    backup: BackupThresholds = BackupThresholds()
    probe: ProbeThresholds = ProbeThresholds()
    freshness: FreshnessThresholds = FreshnessThresholds()


_THRESHOLDS: Thresholds | None = None


def get_thresholds() -> Thresholds:
    global _THRESHOLDS
    if _THRESHOLDS is None:
        _THRESHOLDS = Thresholds()
    return _THRESHOLDS


#: Weights for the global health score. RAID and disks dominate because this
#: environment's only unrecoverable failure mode is losing the array.
COMPONENT_WEIGHTS: dict[str, float] = {
    "raid_disks": env_float("WEIGHT_RAID", 25.0),
    "server": env_float("WEIGHT_SERVER", 15.0),
    "network": env_float("WEIGHT_NETWORK", 15.0),
    "vpn": env_float("WEIGHT_VPN", 10.0),
    "storage": env_float("WEIGHT_STORAGE", 10.0),
    "applications": env_float("WEIGHT_APPLICATIONS", 10.0),
    "backups": env_float("WEIGHT_BACKUPS", 10.0),
    "security": env_float("WEIGHT_SECURITY", 5.0),
}
