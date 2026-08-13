"""Collection and aggregation.

Turns raw collector output into scored `ComponentHealth` objects, alerts and a
global health score. This is the only module that knows how every source maps
onto the health model, which keeps the page files thin and the rules pure.

Design notes:

* Source preference is decided per-area by `SourceRouter`: Prometheus when it
  is deployed and has the relevant metrics, local collectors otherwise. Pages
  never choose a source themselves.
* Every collector is wrapped so an exception becomes an UNKNOWN reading with
  the error attached — one broken integration must not take out the page.
* Deltas and forecasts read from the history store, which is populated by the
  background sampler regardless of whether anyone has the page open.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

from config import Settings
from core.history import HistoryStore
from core.status import Alert, ChangeEvent, ComponentHealth, DataState, Reading, Status
from health import rules
from health.correlation import Incident, correlate, probable_cause_for_disk_crc
from health.forecast import CapacityForecast, forecast_capacity
from health.scoring import HealthScore, calculate_health_score, score_component
from health.thresholds import Thresholds, get_thresholds
from services import backups as backup_service
from services import docker_service, network, probes, smart, sportsdb, system, unifi, vpn
from utils.formatting import human_bytes, human_duration
from utils.logging_setup import get_logger

log = get_logger("collector")


# ---------------------------------------------------------------------------
# Metric keys used in the history store
# ---------------------------------------------------------------------------

M_FS_USED = "fs.used_bytes"
M_SMART_CRC = "smart.udma_crc"
M_SMART_REALLOC = "smart.reallocated"
M_SMART_PENDING = "smart.pending"
M_SMART_TEMP = "smart.temperature"
M_CONTAINER_RESTARTS = "container.restarts"
M_CPU = "host.cpu_percent"
M_IOWAIT = "host.iowait_percent"
M_MEM_AVAIL = "host.mem_available_percent"
M_LATENCY = "net.latency_ms"
M_LOSS = "net.packet_loss_percent"
M_DB_SIZE = "sportsdb.size_bytes"


def _safe(
    func: Callable[[], Any], key: str, label: str, source: str
) -> tuple[Any | None, Reading | None]:
    """Run a collector, converting any failure into an UNKNOWN reading."""
    try:
        return func(), None
    except Exception as exc:  # noqa: BLE001 - deliberate boundary
        log.warning("Collector %s failed: %s", key, exc, exc_info=True)
        return None, Reading.error(
            key=key,
            label=label,
            detail=f"{type(exc).__name__}: {exc}",
            source=source,
        )


class SourceRouter:
    """Decides, per data area, which source to use.

    Prometheus is preferred wherever it can answer. On this host it is not
    deployed, so everything routes to the local collectors and the router
    records *why* — which is what the Diagnostics page reports.
    """

    def __init__(self, settings: Settings, prometheus_client=None) -> None:
        self.settings = settings
        self.prometheus = prometheus_client
        self._features: dict[str, bool] | None = None

    @property
    def prometheus_available(self) -> bool:
        return bool(self.prometheus and self.prometheus.available())

    def features(self) -> dict[str, bool]:
        if self._features is None:
            if self.prometheus_available:
                from services.prometheus import detect_features

                self._features = detect_features(self.prometheus)
            else:
                self._features = {
                    "node_exporter": False,
                    "cadvisor": False,
                    "smartctl_exporter": False,
                    "blackbox_exporter": False,
                    "unifi_exporter": False,
                }
        return self._features

    def source_for(self, area: str) -> str:
        """Human-readable name of the source actually used for an area."""
        mapping = {
            "host": ("node_exporter", "local:/proc"),
            "storage": ("node_exporter", "local:statvfs"),
            "raid": ("node_exporter", "local:/proc/mdstat"),
            "smart": ("smartctl_exporter", "local:smartctl"),
            "containers": ("cadvisor", "local:docker"),
            "probes": ("blackbox_exporter", "direct probe"),
            "unifi": ("unifi_exporter", "not configured"),
        }
        family, fallback = mapping.get(area, ("", "local"))
        if family and self.features().get(family):
            return f"prometheus:{family}"
        return fallback


@dataclass
class Snapshot:
    """Everything the UI needs for one render."""

    health: HealthScore
    components: dict[str, ComponentHealth] = field(default_factory=dict)
    alerts: list[Alert] = field(default_factory=list)
    incidents: list[Incident] = field(default_factory=list)
    changes: list[ChangeEvent] = field(default_factory=list)
    #: Raw collector output, so drill-down pages need not re-collect.
    raw: dict[str, Any] = field(default_factory=dict)
    collected_at: float = field(default_factory=time.time)
    duration_seconds: float = 0.0
    sources: dict[str, str] = field(default_factory=dict)

    def component(self, key: str) -> ComponentHealth | None:
        return self.components.get(key)


# ---------------------------------------------------------------------------
# RAID and physical disks
# ---------------------------------------------------------------------------


def collect_raid_and_disks(
    settings: Settings,
    history: HistoryStore,
    router: SourceRouter,
    thresholds: Thresholds,
) -> tuple[ComponentHealth, dict[str, Any]]:
    """RAID array state plus per-disk SMART health.

    Combined into one component because they answer the same question — is the
    data safe — and because a RAID alert and a disk alert about the same
    physical device should be weighted together, not twice.
    """
    readings: list[Reading] = []
    alerts: list[Alert] = []
    raw: dict[str, Any] = {}

    # --- Array -----------------------------------------------------------
    arrays, error_reading = _safe(
        lambda: system.get_md_arrays(settings.local.proc_mdstat),
        "raid.read",
        "RAID state",
        "local:/proc/mdstat",
    )
    raw["arrays"] = arrays or []

    if error_reading is not None:
        readings.append(error_reading)
    elif arrays is None:
        readings.append(
            Reading.no_data(
                "raid.md127",
                "RAID array",
                "/proc/mdstat is not readable on this system.",
                "local:/proc/mdstat",
            )
        )
    else:
        target = next(
            (a for a in arrays if a.device == settings.raid.device),
            arrays[0] if arrays else None,
        )
        if target is None:
            verdict = rules.Verdict(
                Status.CRITICAL,
                f"Array {settings.raid.device} is not present in /proc/mdstat.",
                "array must exist",
            )
            readings.append(
                rules.reading_from_verdict(
                    f"raid.{settings.raid.device}", "RAID array", None, verdict,
                    source="local:/proc/mdstat",
                )
            )
            alerts.append(
                rules.alert_from_verdict(
                    f"raid.{settings.raid.device}",
                    verdict,
                    "RAID",
                    "RAID array missing",
                    recommended_action="Check `cat /proc/mdstat` and `mdadm --detail`.",
                )
            )
        else:
            verdict = rules.classify_raid(
                active=target.disks_active,
                required=target.disks_required or settings.raid.required_members,
                sync_action=target.sync_action,
                sync_percent=target.sync_percent,
                array_active=target.active,
            )
            readings.append(
                rules.reading_from_verdict(
                    f"raid.{target.device}",
                    f"RAID {target.device}",
                    f"{target.disks_active}/{target.disks_required}",
                    verdict,
                    source="local:/proc/mdstat",
                    extra={
                        "state_string": target.state_string,
                        "level": target.level,
                        "members": target.members,
                        "sync_action": target.sync_action,
                        "sync_percent": target.sync_percent,
                        "sync_speed_kbps": target.sync_speed_kbps,
                        "sync_finish_minutes": target.sync_finish_minutes,
                    },
                )
            )
            alert = rules.alert_from_verdict(
                f"raid.{target.device}",
                verdict,
                "RAID",
                "RAID array degraded"
                if target.degraded
                else f"RAID {target.device} needs attention",
                current_value=f"{target.disks_active}/{target.disks_required} [{target.state_string}]",
                probable_cause=(
                    "A member has dropped out of the array. On this host that has "
                    "previously been a SATA path fault rather than a failed disk."
                    if target.degraded
                    else ""
                ),
                recommended_action=(
                    "Identify the missing member by serial (`lsblk -o NAME,SERIAL`), "
                    "check dmesg for ATA errors, then re-add with "
                    "`mdadm --re-add`. Do not replace a disk on device-name evidence alone."
                    if target.degraded
                    else ""
                ),
            )
            if alert:
                alerts.append(alert)

    # --- SMART -----------------------------------------------------------
    smart_disks: dict[str, smart.SmartDisk] = {}
    smart_source = router.source_for("smart")
    smart_error = ""

    if router.features().get("smartctl_exporter"):
        smart_disks = smart.collect_smart_from_prometheus(router.prometheus)
    elif settings.local.enabled:
        try:
            smart_disks = smart.collect_smart_local(
                settings.local.smartctl_path,
                settings.local.smartctl_via_sudo,
            )
        except smart.SmartUnavailable as exc:
            smart_error = f"{exc} — {exc.hint}"
        except Exception as exc:  # noqa: BLE001
            smart_error = f"{type(exc).__name__}: {exc}"

    raw["smart"] = smart_disks
    raw["smart_error"] = smart_error

    if not smart_disks:
        readings.append(
            Reading.not_configured(
                "disk.smart",
                "Physical disk SMART health",
                smart_error
                or (
                    "No SMART source available. Deploy smartctl_exporter, or grant "
                    "the dashboard read-only smartctl access (deploy/sudoers-smartctl)."
                ),
                smart_source,
            )
        )
    else:
        for disk_config in settings.disks:
            disk = smart_disks.get(disk_config.serial)
            if disk is None:
                continue
            readings.extend(
                _disk_readings(disk, disk_config, history, thresholds, smart_source, alerts)
            )

    component = score_component(
        key="raid_disks",
        label="RAID & disks",
        readings=readings,
        alerts=alerts,
        detail="Array redundancy and physical disk health",
    )
    return component, raw


def _disk_readings(
    disk: smart.SmartDisk,
    disk_config,
    history: HistoryStore,
    thresholds: Thresholds,
    source: str,
    alerts: list[Alert],
) -> list[Reading]:
    """Readings for one physical disk, keyed by serial."""
    labels = {"serial": disk.serial}
    readings: list[Reading] = []

    # SMART overall
    verdict = rules.classify_smart_health(disk.passed)
    readings.append(
        rules.reading_from_verdict(
            f"disk.{disk.serial}.smart",
            f"{disk.serial} SMART health",
            "PASSED" if disk.passed else ("FAILED" if disk.passed is False else None),
            verdict,
            source=source,
        )
    )
    alert = rules.alert_from_verdict(
        f"disk.{disk.serial}.smart",
        verdict,
        f"Disk {disk.serial}",
        "SMART self-assessment failed",
        current_value="FAILED",
        recommended_action="Replace the drive. Verify backups before doing so.",
    )
    if alert:
        alerts.append(alert)

    # Pending / uncorrectable sectors
    for value, classifier, name, title in (
        (
            disk.current_pending_sectors,
            rules.classify_pending_sectors,
            "pending",
            "Pending sectors detected",
        ),
        (
            disk.offline_uncorrectable,
            rules.classify_offline_uncorrectable,
            "uncorrectable",
            "Uncorrectable sectors detected",
        ),
    ):
        verdict = classifier(value, thresholds)
        readings.append(
            rules.reading_from_verdict(
                f"disk.{disk.serial}.{name}",
                f"{disk.serial} {name} sectors",
                int(value) if value is not None else None,
                verdict,
                source=source,
            )
        )
        alert = rules.alert_from_verdict(
            f"disk.{disk.serial}.{name}",
            verdict,
            f"Disk {disk.serial}",
            title,
            current_value=str(int(value)) if value is not None else "",
            probable_cause="Media defects on the platter surface.",
            recommended_action=(
                "Confirm backups, then plan replacement. Run a long SMART self-test "
                "to confirm: smartctl -t long"
            ),
        )
        if alert:
            alerts.append(alert)

    # Temperature
    verdict = rules.classify_disk_temperature(disk.temperature_celsius, thresholds)
    readings.append(
        rules.reading_from_verdict(
            f"disk.{disk.serial}.temp",
            f"{disk.serial} temperature",
            disk.temperature_celsius,
            verdict,
            unit=" °C",
            source=source,
        )
    )
    alert = rules.alert_from_verdict(
        f"disk.{disk.serial}.temp",
        verdict,
        f"Disk {disk.serial}",
        "Disk temperature above threshold",
        current_value=f"{disk.temperature_celsius:.0f} °C"
        if disk.temperature_celsius
        else "",
        probable_cause="Insufficient chassis airflow or a failed fan.",
        recommended_action="Check case fans and drive bay ventilation.",
    )
    if alert:
        alerts.append(alert)

    # CRC — the delta is what matters, so record then difference.
    if disk.udma_crc_errors is not None:
        history.record(M_SMART_CRC, disk.udma_crc_errors, labels)
    delta_1h = history.delta(M_SMART_CRC, 3600, labels)
    delta_24h = history.delta(M_SMART_CRC, 86400, labels)
    delta_7d = history.delta(M_SMART_CRC, 7 * 86400, labels)
    delta_30d = history.delta(M_SMART_CRC, 30 * 86400, labels)

    verdict = rules.classify_crc_delta(
        disk.udma_crc_errors, delta_24h, delta_7d, delta_1h, thresholds
    )
    readings.append(
        rules.reading_from_verdict(
            f"disk.{disk.serial}.crc",
            f"{disk.serial} UDMA CRC errors",
            int(disk.udma_crc_errors) if disk.udma_crc_errors is not None else None,
            verdict,
            source=source,
            extra={
                "delta_1h": delta_1h,
                "delta_24h": delta_24h,
                "delta_7d": delta_7d,
                "delta_30d": delta_30d,
                "watch": disk_config.watch_crc,
                "coverage_seconds": history.coverage_seconds(M_SMART_CRC, labels),
            },
        )
    )
    cause, action = probable_cause_for_disk_crc()
    alert = rules.alert_from_verdict(
        f"disk.{disk.serial}.crc",
        verdict,
        f"Disk {disk.serial}",
        "Disk CRC errors increasing",
        current_value=f"{int(disk.udma_crc_errors):,}"
        if disk.udma_crc_errors is not None
        else "",
        probable_cause=cause,
        recommended_action=action,
    )
    if alert:
        alerts.append(alert)

    # Reallocated sectors
    if disk.reallocated_sectors is not None:
        history.record(M_SMART_REALLOC, disk.reallocated_sectors, labels)
    realloc_delta = history.delta(M_SMART_REALLOC, 7 * 86400, labels)
    verdict = rules.classify_reallocated_delta(
        disk.reallocated_sectors, realloc_delta, thresholds
    )
    readings.append(
        rules.reading_from_verdict(
            f"disk.{disk.serial}.realloc",
            f"{disk.serial} reallocated sectors",
            int(disk.reallocated_sectors)
            if disk.reallocated_sectors is not None
            else None,
            verdict,
            source=source,
            extra={"delta_7d": realloc_delta},
        )
    )
    if disk.temperature_celsius is not None:
        history.record(M_SMART_TEMP, disk.temperature_celsius, labels)

    return readings


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def collect_storage(
    settings: Settings,
    history: HistoryStore,
    router: SourceRouter,
    thresholds: Thresholds,
) -> tuple[ComponentHealth, dict[str, Any]]:
    readings: list[Reading] = []
    alerts: list[Alert] = []
    raw: dict[str, Any] = {"filesystems": {}, "forecasts": {}}
    source = router.source_for("storage")

    for filesystem in settings.filesystems:
        usage = system.get_filesystem_usage(filesystem.mountpoint)
        if usage is None:
            readings.append(
                Reading.no_data(
                    f"storage.{filesystem.mountpoint}",
                    filesystem.label,
                    f"{filesystem.mountpoint} is not mounted or not readable.",
                    source,
                )
            )
            continue

        raw["filesystems"][filesystem.mountpoint] = usage
        labels = {"mount": filesystem.mountpoint}
        history.record(M_FS_USED, usage.used_bytes, labels)

        verdict = rules.classify_filesystem(
            usage.used_percent, usage.free_bytes, thresholds
        )

        forecast: CapacityForecast | None = None
        if filesystem.forecast:
            samples = history.series(M_FS_USED, labels, since=time.time() - 120 * 86400)
            forecast = forecast_capacity(
                samples,
                total_bytes=usage.total_bytes,
                min_history_days=thresholds.storage.min_forecast_history_days,
                min_r_squared=thresholds.storage.min_forecast_r_squared,
            )
            raw["forecasts"][filesystem.mountpoint] = forecast

        readings.append(
            rules.reading_from_verdict(
                f"storage.{filesystem.mountpoint}",
                filesystem.label,
                round(usage.used_percent, 1) if usage.used_percent else None,
                verdict,
                unit="%",
                source=source,
                extra={
                    "usage": usage,
                    "forecast": forecast,
                    "free_bytes": usage.free_bytes,
                    "total_bytes": usage.total_bytes,
                },
            )
        )

        alert = rules.alert_from_verdict(
            f"storage.{filesystem.mountpoint}",
            verdict,
            f"Filesystem {filesystem.mountpoint}",
            f"{filesystem.mountpoint} is filling up",
            current_value=f"{usage.used_percent:.1f}% used, {human_bytes(usage.free_bytes)} free",
            probable_cause="Normal media growth, or a runaway download/transcode directory.",
            recommended_action=(
                f"Check the largest directories: du -x -h -d1 {filesystem.mountpoint} | sort -h | tail"
            ),
        )
        if alert:
            alerts.append(alert)

        # Forecast is a separate, lower-priority signal from current usage.
        if forecast is not None:
            forecast_verdict = rules.classify_forecast(forecast, thresholds)
            if forecast_verdict.status in {Status.WARNING, Status.CRITICAL}:
                alerts.append(
                    Alert(
                        key=f"storage.forecast.{filesystem.mountpoint}",
                        status=forecast_verdict.status,
                        title=f"{filesystem.mountpoint} projected to fill",
                        component=f"Filesystem {filesystem.mountpoint}",
                        detail=forecast_verdict.detail,
                        current_value=f"{usage.used_percent:.1f}% used",
                        threshold=forecast_verdict.threshold,
                        recommended_action="Plan capacity or prune content.",
                    )
                )

        inode_verdict = rules.classify_inodes(usage.inodes_used_percent, thresholds)
        if inode_verdict.status is not Status.HEALTHY:
            readings.append(
                rules.reading_from_verdict(
                    f"storage.inodes.{filesystem.mountpoint}",
                    f"{filesystem.mountpoint} inodes",
                    round(usage.inodes_used_percent, 1)
                    if usage.inodes_used_percent
                    else None,
                    inode_verdict,
                    unit="%",
                    source=source,
                )
            )

    component = score_component(
        key="storage",
        label="Storage",
        readings=readings,
        alerts=alerts,
        detail="Filesystem capacity and growth",
    )
    return component, raw


# ---------------------------------------------------------------------------
# Server / host
# ---------------------------------------------------------------------------


def collect_server(
    settings: Settings,
    history: HistoryStore,
    router: SourceRouter,
    thresholds: Thresholds,
) -> tuple[ComponentHealth, dict[str, Any]]:
    readings: list[Reading] = []
    alerts: list[Alert] = []
    source = router.source_for("host")

    snapshot = system.get_host_snapshot(settings.local.command_timeout)
    raw: dict[str, Any] = {"snapshot": snapshot}

    cpu_percent = snapshot.cpu.used_percent if snapshot.cpu else None
    iowait = snapshot.cpu.iowait_percent if snapshot.cpu else None
    history.record(M_CPU, cpu_percent)
    history.record(M_IOWAIT, iowait)

    verdict = rules.classify_cpu(cpu_percent, thresholds)
    readings.append(
        rules.reading_from_verdict(
            "server.cpu", "CPU utilisation", cpu_percent, verdict, "%", source
        )
    )
    _append_alert(alerts, "server.cpu", verdict, "Host", "CPU utilisation high",
                  f"{cpu_percent:.1f}%" if cpu_percent is not None else "",
                  "A transcode, RAID scrub or import job may be running.",
                  "Check `top` and the Docker page for the responsible container.",
                  alert_on_unknown=False)

    verdict = rules.classify_iowait(iowait, thresholds)
    readings.append(
        rules.reading_from_verdict(
            "server.iowait", "CPU iowait", iowait, verdict, "%", source
        )
    )
    _append_alert(alerts, "server.iowait", verdict, "Host", "iowait high",
                  f"{iowait:.1f}%" if iowait is not None else "",
                  "Storage is saturated — often a RAID resync or heavy import.",
                  "Compare against the Storage page's disk utilisation figures.",
                  alert_on_unknown=False)

    memory = snapshot.memory
    available_percent = memory.available_percent if memory else None
    history.record(M_MEM_AVAIL, available_percent)
    verdict = rules.classify_memory_available(available_percent, thresholds)
    readings.append(
        rules.reading_from_verdict(
            "server.memory",
            "Memory available",
            round(available_percent, 1) if available_percent else None,
            verdict,
            "%",
            source,
            extra={"memory": memory},
        )
    )
    _append_alert(alerts, "server.memory", verdict, "Host", "Available memory low",
                  f"{available_percent:.1f}% available" if available_percent else "",
                  "A container or application is consuming memory.",
                  "Check per-container memory on the Docker page.",
                  alert_on_unknown=False)

    swap_percent = memory.swap_used_percent if memory else None
    verdict = rules.classify_swap(swap_percent, thresholds)
    readings.append(
        rules.reading_from_verdict(
            "server.swap",
            "Swap used",
            round(swap_percent, 1) if swap_percent else None,
            verdict,
            "%",
            source,
        )
    )
    _append_alert(
        alerts, "server.swap", verdict, "Host", "Swap usage high", "", "", "",
        alert_on_unknown=False,
    )

    load = snapshot.load
    verdict = rules.classify_load(
        load.one if load else None, settings.host.cpu_cores, thresholds
    )
    readings.append(
        rules.reading_from_verdict(
            "server.load",
            "Load average (1m)",
            round(load.one, 2) if load else None,
            verdict,
            source=source,
            extra={"load": load},
        )
    )

    verdict = rules.classify_failed_units(snapshot.failed_units)
    failed_names = (
        ", ".join(u.name for u in snapshot.failed_units)
        if snapshot.failed_units
        else ""
    )
    readings.append(
        rules.reading_from_verdict(
            "server.systemd",
            "Failed systemd units",
            len(snapshot.failed_units) if snapshot.failed_units is not None else None,
            verdict,
            source=source,
            extra={"units": snapshot.failed_units},
        )
    )
    _append_alert(
        alerts, "server.systemd", verdict, "Host", "Failed systemd unit(s)",
        failed_names,
        "A scheduled job or service exited non-zero.",
        f"Inspect with: systemctl status {failed_names.split(',')[0].strip()}"
        if failed_names
        else "Inspect with: systemctl --failed",
    )

    if snapshot.uptime_seconds is not None:
        recent = snapshot.uptime_seconds < thresholds.host.recent_boot_seconds
        readings.append(
            Reading(
                key="server.uptime",
                label="Uptime",
                value=human_duration(snapshot.uptime_seconds, parts=2),
                status=Status.INFO if recent else Status.HEALTHY,
                detail=(
                    "Host rebooted recently."
                    if recent
                    else f"Up for {human_duration(snapshot.uptime_seconds, parts=2)}."
                ),
                source=source,
                extra={"seconds": snapshot.uptime_seconds},
            )
        )

    if snapshot.temperatures:
        hottest = max(snapshot.temperatures.values())
        verdict = (
            rules.Verdict(Status.CRITICAL, f"CPU/system sensor at {hottest:.0f} °C.")
            if hottest > thresholds.host.cpu_temp_critical
            else rules.Verdict(Status.WARNING, f"CPU/system sensor at {hottest:.0f} °C.")
            if hottest > thresholds.host.cpu_temp_warning
            else rules.Verdict(Status.HEALTHY, f"Hottest sensor {hottest:.0f} °C.")
        )
        readings.append(
            rules.reading_from_verdict(
                "server.temperature",
                "System temperature",
                round(hottest, 1),
                verdict,
                " °C",
                source,
                extra={"sensors": snapshot.temperatures},
            )
        )
    else:
        readings.append(
            Reading.not_configured(
                "server.temperature",
                "System temperature",
                "No hwmon sensors exposed. Install lm-sensors and run sensors-detect.",
                source,
                optional=True,
            )
        )

    component = score_component(
        key="server",
        label="Server",
        readings=readings,
        alerts=alerts,
        detail=f"{settings.host.hostname} host health",
    )
    return component, raw


def _append_alert(
    alerts: list[Alert],
    key: str,
    verdict,
    component: str,
    title: str,
    current: str,
    cause: str,
    action: str,
    alert_on_unknown: bool = True,
) -> None:
    """Append an alert for a verdict, unless it would not be actionable.

    `alert_on_unknown=False` is used for values that are legitimately absent
    for a moment rather than broken — CPU rate needs two samples, so "not yet
    sampled" is a normal first-render state. It still shows as UNKNOWN on the
    card; it just does not manufacture an alert nobody can act on.
    """
    if verdict.status is Status.UNKNOWN and not alert_on_unknown:
        return
    alert = rules.alert_from_verdict(
        key, verdict, component, title, current, cause, action
    )
    if alert:
        alerts.append(alert)


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------


def collect_network(
    settings: Settings,
    history: HistoryStore,
    router: SourceRouter,
    thresholds: Thresholds,
) -> tuple[ComponentHealth, dict[str, Any]]:
    readings: list[Reading] = []
    alerts: list[Alert] = []
    raw: dict[str, Any] = {}

    gateway_ip = network.get_default_gateway() or network.DEFAULT_GATEWAY
    # These argument sets must match the sampler's warming calls exactly — the
    # TTL cache keys on arguments, so a differing packet count would silently
    # miss the warm entry and pay the full ICMP cost on every page load.
    internet = network.ping(network.DEFAULT_INTERNET_TARGET, count=3, timeout=6.0)
    gateway = network.ping(gateway_ip, count=2, timeout=5.0)
    raw["internet_ping"] = internet
    raw["gateway_ping"] = gateway
    raw["gateway_ip"] = gateway_ip

    history.record(M_LATENCY, internet.latency_ms)
    history.record(M_LOSS, internet.packet_loss_percent)

    # Track when connectivity was first lost, so the CRITICAL threshold is
    # about outage *duration*, not a single failed probe.
    down_since: float | None = None
    state = history.put_state(
        "network.internet.reachable", "up" if internet.reachable else "down"
    )
    if not internet.reachable:
        down_since = state.changed_at

    verdict = rules.classify_internet(
        internet.reachable if internet.packets_sent else None,
        internet.latency_ms,
        internet.packet_loss_percent,
        down_since,
        thresholds,
    )
    readings.append(
        rules.reading_from_verdict(
            "network.internet",
            "Internet",
            round(internet.latency_ms, 1) if internet.latency_ms else None,
            verdict,
            " ms",
            "local:ping",
            extra={"ping": internet},
        )
    )
    _append_alert(
        alerts, "network.internet", verdict, "Internet", "Internet connectivity problem",
        f"{internet.latency_ms:.0f} ms, {internet.packet_loss_percent:.0f}% loss"
        if internet.latency_ms is not None and internet.packet_loss_percent is not None
        else "no response",
        "WAN link, ISP, or gateway fault.",
        "Check the gateway result below; if the gateway responds the fault is upstream.",
    )

    gateway_verdict = (
        rules.Verdict(Status.HEALTHY, f"Gateway {gateway_ip} responding "
                      f"({gateway.latency_ms:.1f} ms).")
        if gateway.reachable and gateway.latency_ms is not None
        else rules.Verdict(Status.CRITICAL, f"Gateway {gateway_ip} is not responding.")
        if gateway.packets_sent
        else rules.Verdict(Status.UNKNOWN, "Gateway could not be probed.")
    )
    readings.append(
        rules.reading_from_verdict(
            "network.gateway",
            "Gateway",
            round(gateway.latency_ms, 2) if gateway.latency_ms else None,
            gateway_verdict,
            " ms",
            "local:ping",
        )
    )

    dns_ok, dns_ms = probes.probe_dns()
    dns_verdict = (
        rules.Verdict(Status.HEALTHY, f"DNS resolving in {dns_ms:.0f} ms.")
        if dns_ok
        else rules.Verdict(Status.CRITICAL, "DNS resolution is failing.")
    )
    readings.append(
        rules.reading_from_verdict(
            "network.dns",
            "DNS resolution",
            round(dns_ms, 1) if dns_ms else None,
            dns_verdict,
            " ms",
            "local:getaddrinfo",
        )
    )
    _append_alert(alerts, "network.dns", dns_verdict, "Internet", "DNS resolution failing",
                  "", "Resolver unreachable or misconfigured.",
                  "Check /etc/resolv.conf and systemd-resolved status.")

    # WAN public IP and change detection
    wan = network.get_public_ip(settings.vpn.wan_ip_check_url)
    raw["wan"] = wan
    if wan.ip:
        change = history.put_state("network.wan_ip", wan.ip)
        raw["wan_ip_change"] = change
        detail = f"Public IP {wan.ip}"
        if change.changed and not change.first_seen:
            detail = f"WAN IP changed from {change.previous} to {wan.ip}."
            history.add_event(
                "network", "WAN public IP changed",
                f"Old: {change.previous}  New: {wan.ip}", "INFO",
            )
        else:
            detail += f" — unchanged for {human_duration(time.time() - change.changed_at)}."
        readings.append(
            Reading(
                key="network.wan_ip",
                label="WAN public IP",
                value=wan.ip,
                status=Status.INFO if change.changed and not change.first_seen else Status.HEALTHY,
                detail=detail,
                source="ipinfo.io",
                extra={"change": change, "info": wan},
            )
        )
    else:
        readings.append(
            Reading.no_data(
                "network.wan_ip", "WAN public IP",
                wan.error or "Could not determine the public IP.", "ipinfo.io",
            )
        )

    # UniFi — explicitly not configured on this host.
    unifi_available = unifi.availability(settings.unifi)
    raw["unifi"] = unifi_available
    raw["vlans"] = unifi.get_vlan_stats(settings.unifi, settings.vlans, router.prometheus)
    if not unifi_available.configured:
        readings.append(
            Reading.not_configured(
                "network.unifi",
                "UniFi telemetry",
                unifi_available.detail,
                "unifi",
                optional=True,
            )
        )
    else:
        # One inventory fetch feeds both the gateway panel and the device list.
        # Statistics are a request per device, so fetching twice would double
        # the controller traffic for the same answer.
        devices, devices_error = unifi.get_devices(settings.unifi)
        raw["unifi_devices"] = devices
        raw["unifi_devices_error"] = devices_error
        raw["gateway_status"] = unifi.get_gateway_status(
            settings.unifi, router.prometheus, devices=devices
        )

        # Switches and access points are infrastructure: when one drops, wifi
        # or a whole switched segment goes with it. That is a network fault,
        # not a footnote, so each gets a reading that feeds the health score.
        for device in devices:
            if device.role == "gateway":
                continue  # already covered by the gateway panel
            label = device.name or device.model or device.mac
            if device.online:
                detail = f"{device.model} at {device.ip_address or 'unknown address'}"
                if device.uptime_seconds:
                    detail += f", up {human_duration(device.uptime_seconds)}"
                readings.append(
                    Reading(
                        key=f"network.unifi.{device.mac or device.device_id}",
                        label=f"{label} ({device.role})",
                        value=device.state.title(),
                        status=Status.HEALTHY,
                        detail=detail,
                        source="unifi",
                        extra={"device": device},
                    )
                )
            else:
                alerts.append(
                    Alert(
                        key=f"network.unifi.{device.mac or device.device_id}",
                        status=Status.CRITICAL,
                        title=f"UniFi {device.role} offline: {label}",
                        component=f"UniFi {device.role}",
                        detail=(
                            f"{device.model} reports state "
                            f"{device.state or 'unknown'}."
                        ),
                        current_value=device.state or "unknown",
                        probable_cause=(
                            "Lost power or PoE, an unplugged uplink, or a "
                            "firmware update that has not come back."
                        ),
                        recommended_action=(
                            f"Check the PoE port feeding {label} on the switch, "
                            f"then its adoption state in the UniFi console."
                        ),
                    )
                )
                readings.append(
                    Reading(
                        key=f"network.unifi.{device.mac or device.device_id}",
                        label=f"{label} ({device.role})",
                        value=device.state.title() or "Offline",
                        status=Status.CRITICAL,
                        detail=f"{device.model} is not reporting to the controller.",
                        source="unifi",
                        extra={"device": device},
                    )
                )

    raw["interface_rates"] = network.get_interface_rates()

    component = score_component(
        key="network",
        label="Network",
        readings=readings,
        alerts=alerts,
        detail="Internet, gateway and DNS",
    )
    return component, raw


# ---------------------------------------------------------------------------
# Containers, VPN, applications
# ---------------------------------------------------------------------------


def collect_containers(
    settings: Settings,
    history: HistoryStore,
    router: SourceRouter,
    thresholds: Thresholds,
) -> tuple[ComponentHealth, dict[str, Any], list[docker_service.ContainerInfo]]:
    readings: list[Reading] = []
    alerts: list[Alert] = []
    raw: dict[str, Any] = {}
    source = router.source_for("containers")

    try:
        containers = docker_service.list_containers(settings.local.command_timeout + 3)
    except docker_service.DockerUnavailable as exc:
        readings.append(
            Reading.error(
                "server.docker", "Docker", f"Docker is unreachable: {exc}", source
            )
        )
        alerts.append(
            Alert(
                key="server.docker",
                status=Status.CRITICAL,
                title="Docker daemon unavailable",
                component="Docker",
                detail=str(exc),
                recommended_action=(
                    "Check `systemctl status docker` and that the dashboard user "
                    "is in the docker group."
                ),
            )
        )
        component = score_component(
            "containers", "Containers", readings, alerts, weight=0.0
        )
        return component, raw, []

    raw["containers"] = containers
    raw["docker_version"] = docker_service.docker_version()

    running = 0
    for expected in settings.containers:
        container = docker_service.find_container(containers, expected.name)

        restart_delta = None
        if container is not None:
            labels = {"container": expected.name}
            history.record(M_CONTAINER_RESTARTS, container.restart_count, labels)
            restart_delta = history.delta(M_CONTAINER_RESTARTS, 3600, labels)
            if restart_delta is not None:
                restart_delta = int(restart_delta)
            if container.running:
                running += 1

            _detect_container_changes(history, expected, container)

        verdict = rules.classify_container(
            container, expected.critical, restart_delta, thresholds
        )
        readings.append(
            rules.reading_from_verdict(
                f"container.{expected.name}",
                expected.display,
                container.state if container else "missing",
                verdict,
                source=source,
                extra={
                    "container": container,
                    "restart_delta": restart_delta,
                    "expected": expected,
                },
            )
        )
        _append_alert(
            alerts, f"container.{expected.name}", verdict, f"Container {expected.display}",
            f"{expected.display} is not healthy",
            container.state if container else "missing",
            (
                "Containers behind Gluetun lose connectivity whenever the VPN fails."
                if expected.behind_vpn
                else ""
            ),
            f"docker logs --tail 100 {expected.name}",
        )

    raw["running_count"] = running
    raw["expected_count"] = len(settings.containers)

    # Containers present on the host but not in the expected inventory.
    expected_names = {e.name for e in settings.containers}
    matched = {
        c.name
        for e in settings.containers
        if (c := docker_service.find_container(containers, e.name)) is not None
    }
    unexpected = [
        c for c in containers if c.running and c.name not in matched and c.name not in expected_names
    ]
    raw["unexpected"] = unexpected
    if unexpected:
        readings.append(
            Reading(
                key="container.unexpected",
                label="Unexpected containers",
                value=len(unexpected),
                status=Status.INFO,
                detail=(
                    "Running but not in the expected inventory: "
                    + ", ".join(c.name for c in unexpected[:5])
                ),
                source=source,
                extra={"containers": unexpected},
            )
        )

    component = score_component(
        key="containers",
        label="Containers",
        readings=readings,
        alerts=alerts,
        weight=0.0,  # Folded into applications; not separately weighted.
        detail=f"{running}/{len(settings.containers)} expected containers running",
    )
    return component, raw, containers


def _detect_container_changes(history: HistoryStore, expected, container) -> None:
    """Record image/version changes into the Recent Changes feed."""
    image_change = history.put_state(
        f"container.{expected.name}.image", f"{container.image}@{container.version}"
    )
    if image_change.changed and not image_change.first_seen:
        previous = (image_change.previous or "").split("@")
        current = f"{container.image}@{container.version}".split("@")
        history.add_event(
            "docker",
            f"{expected.display} image changed",
            f"Previous: {previous[-1] or previous[0]}  Current: {current[-1] or current[0]}",
            "INFO",
        )

    restart_change = history.put_state(
        f"container.{expected.name}.restarts", str(container.restart_count)
    )
    if restart_change.changed and not restart_change.first_seen:
        history.add_event(
            "docker",
            f"{expected.display} restarted",
            f"Restart count {restart_change.previous} → {container.restart_count}",
            "WARNING",
        )


def collect_vpn(
    settings: Settings,
    history: HistoryStore,
    containers: list,
    wan_ip: str | None,
    thresholds: Thresholds,
) -> tuple[ComponentHealth, dict[str, Any]]:
    readings: list[Reading] = []
    alerts: list[Alert] = []

    container = docker_service.find_container(containers, settings.vpn.container)
    status = vpn.get_vpn_status(
        container=container,
        container_name=container.name if container else settings.vpn.container,
        ip_check_url=settings.vpn.ip_check_url,
        provider=settings.vpn.provider,
        protocol=settings.vpn.protocol,
        control_url=settings.api.gluetun_control_url,
        api_key=settings.api.gluetun_api_key,
    )
    leak = vpn.check_leak(status.public_ip, wan_ip)
    raw: dict[str, Any] = {"status": status, "leak": leak}

    if status.public_ip:
        change = history.put_state("vpn.public_ip", status.public_ip)
        raw["ip_change"] = change
        if change.changed and not change.first_seen:
            history.add_event(
                "vpn", "VPN exit IP changed",
                f"Old: {change.previous}  New: {status.public_ip}", "INFO",
            )

    verdict = rules.classify_vpn(status)
    readings.append(
        rules.reading_from_verdict(
            "vpn.gluetun", "Gluetun tunnel", status.public_ip, verdict,
            source="local:docker", extra={"status": status},
        )
    )
    _append_alert(
        alerts, "vpn.gluetun", verdict, "VPN", "Gluetun VPN unhealthy",
        status.public_ip or "no tunnel",
        status.error or "",
        "Check `docker logs --tail 200 " + settings.vpn.container + "`. "
        "If AUTH_FAILED appears, the provider credentials are wrong.",
    )

    leak_verdict = rules.classify_leak(leak)
    readings.append(
        rules.reading_from_verdict(
            "vpn.leak", "VPN leak check",
            "PASS" if leak.passed else ("FAIL" if leak.passed is False else None),
            leak_verdict, source="derived", extra={"leak": leak},
        )
    )
    _append_alert(
        alerts, "vpn.leak", leak_verdict, "VPN", "Possible VPN leak",
        f"VPN {leak.vpn_ip} / WAN {leak.wan_ip}",
        "The download stack is not routing through the tunnel.",
        "Stop the download clients, then verify Gluetun's network_mode bindings.",
    )

    component = score_component(
        key="vpn", label="VPN", readings=readings, alerts=alerts,
        detail="Gluetun tunnel and leak protection",
    )
    return component, raw


def collect_applications(
    settings: Settings,
    history: HistoryStore,
    router: SourceRouter,
    thresholds: Thresholds,
) -> tuple[ComponentHealth, dict[str, Any]]:
    readings: list[Reading] = []
    alerts: list[Alert] = []

    targets = [
        (e.key, e.display, e.url, e.expect_status)
        for e in settings.endpoints
        if e.url
    ]
    results = probes.probe_many(targets, timeout=5.0)
    by_key = {r.key: r for r in results}
    raw: dict[str, Any] = {"probes": by_key}

    for endpoint in settings.endpoints:
        if not endpoint.url:
            # A service with no URL is one that has not been deployed at all
            # (Grafana, Prometheus). That is a known gap, not a fault.
            readings.append(
                Reading.not_configured(
                    f"probe.{endpoint.key}", endpoint.display,
                    f"No URL configured. {endpoint.hosting}", "probe",
                    optional=True,
                )
            )
            continue
        result = by_key.get(endpoint.key)
        verdict = rules.classify_probe(result, endpoint.critical, thresholds)
        readings.append(
            rules.reading_from_verdict(
                f"probe.{endpoint.key}", endpoint.display,
                round(result.latency_ms, 1) if result and result.latency_ms else None,
                verdict, " ms", router.source_for("probes"),
                extra={"probe": result, "endpoint": endpoint},
            )
        )
        _append_alert(
            alerts, f"probe.{endpoint.key}", verdict, endpoint.display,
            f"{endpoint.display} is not responding correctly",
            result.error if result else "",
            endpoint.hosting,
            f"Probe manually: curl -sS -o /dev/null -w '%{{http_code}}' {endpoint.url}",
        )

    # Sports databases
    databases = sportsdb.get_all_databases(settings.sports_databases)
    raw["sports_databases"] = databases
    for database in databases:
        if database.size_bytes is not None:
            history.record(M_DB_SIZE, database.size_bytes, {"db": database.key})
        if not database.exists:
            readings.append(
                Reading.no_data(
                    f"sportsdb.{database.key}", f"{database.display} database",
                    database.error, "local:stat",
                )
            )
            continue
        stale = database.stale
        verdict = (
            rules.Verdict(
                Status.WARNING,
                f"Last updated {human_duration(database.age_seconds)} ago, beyond "
                f"the {database.max_age_hours:.0f}h expectation.",
                f"≤{database.max_age_hours:.0f}h",
            )
            if stale
            else rules.Verdict(
                Status.HEALTHY,
                f"Updated {human_duration(database.age_seconds)} ago "
                f"({human_bytes(database.size_bytes)}).",
            )
        )
        readings.append(
            rules.reading_from_verdict(
                f"sportsdb.{database.key}", f"{database.display} database",
                human_bytes(database.size_bytes), verdict,
                source="local:stat", extra={"database": database},
            )
        )

    component = score_component(
        key="applications", label="Applications", readings=readings, alerts=alerts,
        detail="Synthetic probes and application data freshness",
    )
    return component, raw


# ---------------------------------------------------------------------------
# Backups and security
# ---------------------------------------------------------------------------


def collect_backups(
    settings: Settings, history: HistoryStore, thresholds: Thresholds
) -> tuple[ComponentHealth, dict[str, Any]]:
    readings: list[Reading] = []
    alerts: list[Alert] = []
    statuses: list[backup_service.BackupStatus] = []

    for job in settings.backups:
        status = backup_service.scan_backup_directory(
            key=job.key,
            display=job.display,
            directory=job.directory,
            pattern=job.pattern,
            schedule=job.schedule,
            expected_interval_days=job.expected_interval_days,
            min_plausible_bytes=job.min_plausible_bytes,
        )

        # Reattach the last verification verdict recorded for this job.
        verification = history.get_state(f"backup.{job.key}.integrity")
        if verification is not None:
            status.integrity_ok = verification.value == "ok"
            status.integrity_detail = verification.value
            status.integrity_checked_at = verification.changed_at

        # A missed scheduled run is a sharper signal than raw age: a
        # twice-weekly job that silently skips a run stays inside its age
        # threshold for days before age alone would notice.
        if job.schedule_weekdays:
            status.missed_run_at = backup_service.check_missed_run(
                status,
                job.schedule_weekdays,
                job.schedule_hour,
                grace_hours=job.schedule_grace_hours,
            )
            missed_verdict = rules.classify_missed_run(
                status.missed_run_at, job.schedule, status.age_days
            )
            if missed_verdict.status is not Status.HEALTHY:
                readings.append(
                    rules.reading_from_verdict(
                        f"backup.schedule.{job.key}",
                        f"{job.display} schedule",
                        "missed run",
                        missed_verdict,
                        source="derived",
                    )
                )
                _append_alert(
                    alerts, f"backup.schedule.{job.key}", missed_verdict,
                    f"Backup: {job.display}", "Scheduled backup run was missed",
                    status.latest.name if status.latest else "no backup found",
                    "The scheduled job did not run, or ran and failed before "
                    "writing output.",
                    f"Check the job ({job.source}) and its unit/cron entry, then "
                    f"`journalctl -u backup-nightly.service -n 50`.",
                )

        statuses.append(status)

        verdict = rules.classify_backup_age(
            status.age_days, job.expected_interval_days, thresholds
        )
        readings.append(
            rules.reading_from_verdict(
                f"backup.{job.key}", job.display,
                f"{status.age_days:.1f} days" if status.age_days is not None else None,
                verdict, source="local:stat", extra={"status": status},
            )
        )
        _append_alert(
            alerts, f"backup.{job.key}", verdict, f"Backup: {job.display}",
            f"{job.display} is overdue",
            status.latest.name if status.latest else "no backup found",
            f"Scheduled {job.schedule}. The scheduled run may have failed.",
            f"Check the job: {job.source}. Then `systemctl list-timers` / `crontab -l`.",
        )

        # Only size-check when a backup exists — "nothing to size-check" adds
        # nothing on top of the age alert that already fired.
        size_verdict = rules.classify_backup_size(status, thresholds)
        if status.latest is not None and size_verdict.status is not Status.HEALTHY:
            readings.append(
                rules.reading_from_verdict(
                    f"backup.size.{job.key}", f"{job.display} size", None,
                    size_verdict, source="local:stat",
                )
            )
            _append_alert(
                alerts, f"backup.size.{job.key}", size_verdict,
                f"Backup: {job.display}", "Backup size looks wrong", "", "", "",
            )

        integrity_verdict = rules.classify_backup_integrity(
            status.integrity_ok, status.integrity_detail
        )
        readings.append(
            rules.reading_from_verdict(
                f"backup.integrity.{job.key}", f"{job.display} integrity",
                status.integrity_detail or None, integrity_verdict,
                source="verification",
                extra={"checked_at": status.integrity_checked_at},
            )
        )
        if integrity_verdict.status is Status.CRITICAL:
            _append_alert(
                alerts, f"backup.integrity.{job.key}", integrity_verdict,
                f"Backup: {job.display}", "Backup failed its integrity check", "",
                "The archive is corrupt or truncated.",
                "Re-run the backup, then verify again from the Backups page.",
            )

        if status.destination_used_percent is not None:
            if status.destination_used_percent >= thresholds.backup.destination_full_percent:
                alerts.append(
                    Alert(
                        key=f"backup.destination.{job.key}",
                        status=Status.CRITICAL,
                        title="Backup destination is nearly full",
                        component=f"Backup: {job.display}",
                        detail=(
                            f"{status.directory} is "
                            f"{status.destination_used_percent:.0f}% full "
                            f"({human_bytes(status.destination_free_bytes)} free)."
                        ),
                        threshold=f"≥{thresholds.backup.destination_full_percent:.0f}%",
                        recommended_action="Prune old backups or extend retention policy.",
                    )
                )

    component = score_component(
        key="backups", label="Backups", readings=readings, alerts=alerts,
        detail="Backup recency, size and integrity",
    )
    return component, {"jobs": statuses}


def collect_security(
    settings: Settings, history: HistoryStore, thresholds: Thresholds
) -> tuple[ComponentHealth, dict[str, Any]]:
    readings: list[Reading] = []
    alerts: list[Alert] = []
    raw: dict[str, Any] = {}

    listeners = system.get_listeners(settings.local.command_timeout)
    raw["listeners"] = listeners

    exposed = [listener for listener in listeners if not listener.loopback_only]
    expected_ports = _expected_listener_ports()
    unexpected = [
        listener for listener in exposed if listener.port not in expected_ports
    ]
    raw["unexpected_listeners"] = unexpected

    if not listeners:
        readings.append(
            Reading.no_data(
                "security.listeners", "Listening ports",
                "`ss` is unavailable, so local listeners could not be enumerated.",
                "local:ss",
            )
        )
    elif unexpected:
        readings.append(
            Reading(
                key="security.listeners",
                label="Unexpected listeners",
                value=len(unexpected),
                status=Status.WARNING,
                detail=(
                    "Listening on non-loopback addresses but not in the expected "
                    "inventory: "
                    + ", ".join(f"{l.address}:{l.port}" for l in unexpected[:6])
                ),
                source="local:ss",
                extra={"listeners": unexpected},
            )
        )
        alerts.append(
            Alert(
                key="security.listeners",
                status=Status.WARNING,
                title="Unexpected listening port(s)",
                component="Security",
                detail=", ".join(f"{l.address}:{l.port}" for l in unexpected),
                recommended_action=(
                    "Identify the owner with `sudo ss -lntup`, then add it to "
                    "EXPECTED_LISTENERS in config.py or shut it down."
                ),
            )
        )
    else:
        readings.append(
            Reading(
                key="security.listeners",
                label="Listening ports",
                value=len(exposed),
                status=Status.HEALTHY,
                detail=f"All {len(exposed)} non-loopback listeners are expected.",
                source="local:ss",
                extra={"listeners": exposed},
            )
        )

    # External exposure — a deliberate, explicit, non-aggressive check.
    unifi_available = unifi.availability(settings.unifi)
    raw["unifi"] = unifi_available
    if unifi_available.configured:
        events = unifi.get_ids_events(settings.unifi)
        raw["ids_events"] = events
        readings.append(
            Reading(
                key="security.ids",
                label="UniFi IDS/IPS events",
                value=len(events),
                status=Status.INFO if events else Status.HEALTHY,
                detail=f"{len(events)} recent IDS/IPS events.",
                source="unifi",
                extra={"events": events},
            )
        )
    else:
        readings.append(
            Reading.not_configured(
                "security.ids", "UniFi IDS/IPS events",
                "UniFi is not integrated, so IDS/IPS alerts, blocked WAN traffic "
                "and firewall denials cannot be shown.",
                "unifi",
                optional=True,
            )
        )

    review_ports = [port for port in settings.external_ports if not port.expected]
    readings.append(
        Reading(
            key="security.exposure",
            label="External port exposure",
            value=(
                f"{len(review_ports)} need review"
                if review_ports
                else f"{len(settings.external_ports)} intentional"
            ),
            status=Status.WARNING if review_ports else Status.INFO,
            detail=(
                "Declared Internet-facing ports needing review: "
                + ", ".join(str(port.port) for port in review_ports)
                + ". Verify them in UniFi."
                if review_ports
                else "All declared Internet-facing ports have a documented purpose."
            ),
            source="config",
            extra={"ports": settings.external_ports},
        )
    )

    component = score_component(
        key="security", label="Security", readings=readings, alerts=alerts,
        detail="Listener inventory and external exposure",
    )
    return component, raw


def _expected_listener_ports() -> set[int]:
    from config import EXPECTED_LISTENERS

    return set(EXPECTED_LISTENERS)


# ---------------------------------------------------------------------------
# Top-level snapshot
# ---------------------------------------------------------------------------


def build_snapshot(
    settings: Settings,
    history: HistoryStore,
    prometheus_client=None,
    thresholds: Thresholds | None = None,
) -> Snapshot:
    """Collect everything and produce the scored, correlated snapshot."""
    started = time.perf_counter()
    thresholds = thresholds or get_thresholds()
    router = SourceRouter(settings, prometheus_client)

    components: dict[str, ComponentHealth] = {}
    raw: dict[str, Any] = {}

    raid, raid_raw = collect_raid_and_disks(settings, history, router, thresholds)
    components["raid_disks"] = raid
    raw["raid"] = raid_raw

    storage, storage_raw = collect_storage(settings, history, router, thresholds)
    components["storage"] = storage
    raw["storage"] = storage_raw

    server, server_raw = collect_server(settings, history, router, thresholds)
    components["server"] = server
    raw["server"] = server_raw

    net, net_raw = collect_network(settings, history, router, thresholds)
    components["network"] = net
    raw["network"] = net_raw

    containers, container_raw, container_list = collect_containers(
        settings, history, router, thresholds
    )
    components["containers"] = containers
    raw["containers"] = container_raw

    wan_info = net_raw.get("wan")
    vpn_component, vpn_raw = collect_vpn(
        settings, history, container_list, wan_info.ip if wan_info else None, thresholds
    )
    components["vpn"] = vpn_component
    raw["vpn"] = vpn_raw

    applications, app_raw = collect_applications(settings, history, router, thresholds)
    # Container health is part of "are the applications working", so its
    # readings and alerts fold into the applications component for scoring.
    applications.readings.extend(containers.readings)
    applications.alerts.extend(containers.alerts)
    applications = score_component(
        key="applications",
        label="Applications",
        readings=applications.readings,
        alerts=applications.alerts,
        detail=containers.detail,
    )
    components["applications"] = applications
    raw["applications"] = app_raw

    backups_component, backup_raw = collect_backups(settings, history, thresholds)
    components["backups"] = backups_component
    raw["backups"] = backup_raw

    security, security_raw = collect_security(settings, history, thresholds)
    components["security"] = security
    raw["security"] = security_raw

    scored = [c for c in components.values() if c.weight > 0]
    health = calculate_health_score(scored)

    all_alerts: list[Alert] = []
    for component in components.values():
        all_alerts.extend(component.alerts)
    incidents, uncorrelated = correlate(all_alerts)

    events = history.recent_events(limit=40)
    changes = [
        ChangeEvent(
            timestamp=event["timestamp"],
            category=event["category"],
            summary=event["summary"],
            detail=event["detail"],
            status=Status(event["status"]) if event["status"] in Status.__members__ else Status.INFO,
        )
        for event in events
    ]

    return Snapshot(
        health=health,
        components=components,
        alerts=sorted(all_alerts, key=lambda a: a.status.rank, reverse=True),
        incidents=incidents,
        changes=changes,
        raw=raw,
        duration_seconds=time.perf_counter() - started,
        sources={
            area: router.source_for(area)
            for area in ("host", "storage", "raid", "smart", "containers", "probes", "unifi")
        },
    )


def sample_metrics(settings: Settings) -> list[tuple[str, dict[str, str] | None, float | None]]:
    """Metric samples for the background history sampler.

    Deliberately cheap and independent of the UI: this runs every minute
    whether or not anyone is looking, so the 7-day and 30-day deltas that the
    disk and capacity panels depend on are actually available.
    """
    rows: list[tuple[str, dict[str, str] | None, float | None]] = []

    for filesystem in settings.filesystems:
        usage = system.get_filesystem_usage(filesystem.mountpoint)
        if usage is not None:
            rows.append((M_FS_USED, {"mount": filesystem.mountpoint}, usage.used_bytes))

    cpu = system.get_cpu_usage()
    if cpu is not None:
        rows.append((M_CPU, None, cpu.used_percent))
        rows.append((M_IOWAIT, None, cpu.iowait_percent))

    memory = system.get_memory_info()
    if memory is not None:
        rows.append((M_MEM_AVAIL, None, memory.available_percent))

    if settings.local.enabled:
        try:
            disks = smart.collect_smart_local(
                settings.local.smartctl_path, settings.local.smartctl_via_sudo
            )
            for serial, disk in disks.items():
                labels = {"serial": serial}
                rows.append((M_SMART_CRC, labels, disk.udma_crc_errors))
                rows.append((M_SMART_REALLOC, labels, disk.reallocated_sectors))
                rows.append((M_SMART_PENDING, labels, disk.current_pending_sectors))
                rows.append((M_SMART_TEMP, labels, disk.temperature_celsius))
        except Exception:  # noqa: BLE001 - SMART is optional
            pass

    result = network.ping(network.DEFAULT_INTERNET_TARGET, count=3, timeout=6.0)
    rows.append((M_LATENCY, None, result.latency_ms))
    rows.append((M_LOSS, None, result.packet_loss_percent))

    for database in sportsdb.get_all_databases(settings.sports_databases):
        if database.size_bytes is not None:
            rows.append((M_DB_SIZE, {"db": database.key}, float(database.size_bytes)))

    _warm_slow_caches(settings)
    return rows


def _warm_slow_caches(settings: Settings) -> None:
    """Prime the network-bound TTL caches from the background thread.

    Collection is dominated by outbound work: ICMP, the WAN IP lookup, the
    Gluetun exec and the HTTP probe sweep together cost several seconds. Doing
    them here — on the sampler thread, which starts with the process and runs
    whether or not anyone is watching — means the first page load reads warm
    caches instead of paying that cost in front of a user.

    Failures are ignored: this is opportunistic warming, and every one of these
    is re-attempted with proper error handling during real collection.
    """
    try:
        network.get_public_ip(settings.vpn.wan_ip_check_url)
    except Exception:  # noqa: BLE001
        pass

    try:
        gateway = network.get_default_gateway() or network.DEFAULT_GATEWAY
        network.ping(gateway, count=2, timeout=5.0)
    except Exception:  # noqa: BLE001
        pass

    try:
        probes.probe_dns()
        targets = [
            (e.key, e.display, e.url, e.expect_status)
            for e in settings.endpoints
            if e.url
        ]
        probes.probe_many(targets, timeout=5.0)
    except Exception:  # noqa: BLE001
        pass

    try:
        containers = docker_service.list_containers(settings.local.command_timeout + 3)
        gluetun = docker_service.find_container(containers, settings.vpn.container)
        if gluetun is not None and gluetun.running:
            vpn.get_vpn_status(
                container=gluetun,
                container_name=gluetun.name,
                ip_check_url=settings.vpn.ip_check_url,
                provider=settings.vpn.provider,
                protocol=settings.vpn.protocol,
                read_logs=False,
            )
    except Exception:  # noqa: BLE001
        pass
