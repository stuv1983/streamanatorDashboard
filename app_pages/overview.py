"""Overview — the NOC summary screen.

The whole page is built to be readable in about ten seconds: health banner,
status strip, then the four things that can actually hurt (array, storage, VPN,
backups), then alerts and changes. Anything that does not help identify a
problem, understand its impact, or decide what to check next belongs on a
drill-down page instead.

Layout renders top-down with the chrome first and the live panels inside a
fragment, so the auto-refresh updates the values without re-running the whole
script.
"""

from __future__ import annotations

import streamlit as st

from components.alerts import alert_banner, alert_panel, change_feed
from components.cards import (
    counter_card,
    delta_card,
    metric_card,
    not_configured_card,
    status_card,
    summary_tile,
)
from components.charts import threshold_series, time_series
from components.layout import (
    grafana_link,
    health_header,
    read_only_notice,
    source_footer,
)
from config import CRC_WATCH_SERIAL, TIME_RANGES, get_settings
from core.collector import M_CPU, M_FS_USED, M_IOWAIT, M_LATENCY, M_SMART_CRC
from core.runtime import get_snapshot, history_series
from core.status import Status
from health.thresholds import get_thresholds
from services import unifi
from utils.formatting import (
    format_delta,
    format_percent,
    human_bytes,
    human_duration,
    format_date,
)

settings = get_settings()
thresholds = get_thresholds()
refresh_seconds = st.session_state.get("refresh_seconds", 30)
range_label = st.session_state.get("time_range", "24h")
range_seconds = dict(TIME_RANGES).get(range_label, 86400)


@st.fragment(run_every=refresh_seconds if refresh_seconds else None)
def overview() -> None:
    snapshot = get_snapshot()
    health = snapshot.health

    health_header(health, snapshot.collected_at, snapshot.duration_seconds)

    # ---- Status strip ---------------------------------------------------
    strip = st.container(horizontal=True)
    with strip:
        _tile("Internet", snapshot, "network", "network.internet")
        _tile("RAID", snapshot, "raid_disks", f"raid.{settings.raid.device}")
        _tile("Storage", snapshot, "storage", "storage./mnt/media")
        _tile("VPN", snapshot, "vpn", "vpn.gluetun")
        _tile("Backup", snapshot, "backups", "backup.sports_data_lab")
        _tile("Services", snapshot, "applications", None)
        _tile("Security", snapshot, "security", None)

    alert_banner(snapshot.alerts)

    # ---- Internet and host ---------------------------------------------
    st.markdown("#### Internet & host")
    internet_col, host_col = st.columns([1, 1])

    with internet_col:
        with st.container(border=True):
            st.markdown("**Internet latency**")
            samples = history_series(M_LATENCY, None, range_seconds)
            chart = threshold_series(
                samples,
                "Latency",
                warning=thresholds.network.latency_warning_ms,
                critical=thresholds.network.latency_critical_ms,
                unit=" (ms)",
            )
            if chart is None:
                st.caption(
                    "No latency history yet — the sampler needs a few minutes of "
                    "runtime before a trend can be drawn."
                )
            else:
                st.altair_chart(chart, width="stretch")
            ping = snapshot.raw.get("network", {}).get("internet_ping")
            if ping is not None:
                st.caption(
                    f"Current: {ping.latency_ms:.0f} ms, "
                    f"{format_percent(ping.packet_loss_percent)} loss"
                    if ping.latency_ms is not None
                    else "Current: no response"
                )

    with host_col:
        with st.container(border=True):
            st.markdown("**CPU & iowait**")
            cpu_samples = history_series(M_CPU, None, range_seconds)
            chart = time_series(cpu_samples, "CPU", " (%)", area=True, zero=True)
            if chart is None:
                st.caption("No CPU history yet.")
            else:
                st.altair_chart(chart, width="stretch")
            iowait_samples = history_series(M_IOWAIT, None, range_seconds)
            iowait_chart = time_series(
                iowait_samples, "iowait", " (%)", height=90, zero=True
            )
            if iowait_chart is not None:
                st.altair_chart(iowait_chart, width="stretch")

    # ---- Host KPI row ---------------------------------------------------
    server = snapshot.component("server")
    if server:
        kpis = st.container(horizontal=True)
        with kpis:
            _kpi(server, "server.cpu", "CPU", "%")
            _kpi(server, "server.memory", "RAM available", "%")
            _kpi(server, "server.load", "Load (1m)", "")
            _kpi(server, "server.iowait", "iowait", "%")
            uptime = _reading(server, "server.uptime")
            if uptime is not None:
                metric_card("Uptime", str(uptime.value or "—"))
            temperature = _reading(server, "server.temperature")
            if temperature is not None:
                metric_card(
                    "Temperature",
                    temperature.display_value,
                    help_text=temperature.detail,
                )

    # ---- RAID and disks -------------------------------------------------
    st.markdown("#### RAID & physical disks")
    raid_col, disk_col = st.columns([1, 1])
    raid = snapshot.component("raid_disks")

    with raid_col:
        array_reading = _reading(raid, f"raid.{settings.raid.device}")
        if array_reading is None:
            st.warning("RAID array state is unavailable.", icon=":material/warning:")
        else:
            extra = array_reading.extra
            status_card(
                label=f"RAID {settings.raid.device}",
                status=array_reading.status,
                value=f"{array_reading.value}  [{extra.get('state_string', '')}]",
                detail=array_reading.detail,
                threshold=array_reading.threshold,
                source=array_reading.source,
                age_seconds=array_reading.age_seconds,
            )
            if extra.get("sync_action"):
                st.caption(
                    f"Sync: {extra['sync_action']} at {extra.get('sync_percent', 0):.1f}% "
                    f"— {extra.get('sync_speed_kbps', 0) / 1024:.0f} MB/s, "
                    f"about {extra.get('sync_finish_minutes', 0):.0f} min remaining"
                )
            grafana_link("/d/raid/raid-health", "RAID detail in Grafana")

    with disk_col:
        crc_reading = _crc_reading(raid)
        if crc_reading is not None:
            extra = crc_reading.extra
            delta_card(
                label=f"{_serial_from(crc_reading)} UDMA CRC errors",
                status=crc_reading.status,
                current=f"{crc_reading.value:,}" if crc_reading.value is not None else "—",
                deltas={
                    "1 hour": extra.get("delta_1h"),
                    "24 hours": extra.get("delta_24h"),
                    "7 days": extra.get("delta_7d"),
                    "30 days": extra.get("delta_30d"),
                },
                detail=crc_reading.detail,
                threshold=crc_reading.threshold,
                source=crc_reading.source,
            )
        else:
            smart_error = snapshot.raw.get("raid", {}).get("smart_error", "")
            not_configured_card(
                "Physical disk SMART health",
                smart_error
                or "No SMART source is available, so disk-level health cannot be shown.",
                steps=(
                    "Deploy smartctl_exporter (see deploy/monitoring-stack/), or",
                    "install deploy/sudoers-smartctl and set SMARTCTL_SUDO=true.",
                ),
                source="smartctl",
            )

    # ---- Storage --------------------------------------------------------
    st.markdown("#### Storage")
    storage = snapshot.component("storage")
    storage_columns = st.columns(3)
    critical_mounts = [f.mountpoint for f in settings.filesystems if f.critical]
    for column, mount in zip(storage_columns, critical_mounts[:3]):
        reading = _reading(storage, f"storage.{mount}")
        with column:
            if reading is None:
                st.caption(f"{mount}: unavailable")
                continue
            usage = reading.extra.get("usage")
            forecast = reading.extra.get("forecast")
            status_card(
                label=mount,
                status=reading.status,
                value=f"{reading.value}%" if reading.value is not None else "—",
                detail=(
                    f"{human_bytes(usage.free_bytes)} free of "
                    f"{human_bytes(usage.total_bytes)}"
                    if usage
                    else reading.detail
                ),
                threshold=reading.threshold,
                source=reading.source,
                age_seconds=reading.age_seconds,
            )
            _forecast_caption(forecast)

    # ---- Services -------------------------------------------------------
    st.markdown("#### Services")
    applications = snapshot.component("applications")
    container_raw = snapshot.raw.get("containers", {})

    service_row = st.container(horizontal=True)
    with service_row:
        counter_card(
            "Containers",
            Status.HEALTHY
            if container_raw.get("running_count") == container_raw.get("expected_count")
            else Status.WARNING,
            f"{container_raw.get('running_count', '—')} / "
            f"{container_raw.get('expected_count', '—')}",
            "expected containers running",
        )
        for key in ("plex", "immich", "sports_data_lab"):
            reading = _reading(applications, f"probe.{key}")
            if reading is not None:
                counter_card(
                    reading.label,
                    reading.status,
                    reading.display_value if reading.value is not None else "—",
                    reading.detail[:60],
                )
        vpn_reading = _reading(snapshot.component("vpn"), "vpn.gluetun")
        if vpn_reading is not None:
            counter_card(
                "Gluetun",
                vpn_reading.status,
                vpn_reading.value or "no tunnel",
                "VPN exit IP",
            )
        leak_reading = _reading(snapshot.component("vpn"), "vpn.leak")
        if leak_reading is not None:
            counter_card(
                "VPN leak check",
                leak_reading.status,
                leak_reading.value or "UNKNOWN",
                leak_reading.threshold,
            )

    # ---- Backups --------------------------------------------------------
    st.markdown("#### Backups")
    backups = snapshot.component("backups")
    backup_columns = st.columns(len(settings.backups) or 1)
    for column, job in zip(backup_columns, settings.backups):
        reading = _reading(backups, f"backup.{job.key}")
        integrity = _reading(backups, f"backup.integrity.{job.key}")
        with column:
            if reading is None:
                continue
            status_obj = reading.extra.get("status")
            status_card(
                label=job.display,
                status=reading.status,
                value=str(reading.value or "no backup"),
                detail=reading.detail,
                threshold=reading.threshold,
                source=reading.source,
            )
            if status_obj is not None and status_obj.latest is not None:
                st.caption(
                    f"{status_obj.latest.name} · "
                    f"{human_bytes(status_obj.latest.size_bytes)} · "
                    f"{status_obj.retained_count} retained"
                )
            if integrity is not None:
                st.caption(f"Integrity: {integrity.display_value} — {integrity.detail}")

    # ---- Alerts and changes --------------------------------------------
    alerts_col, changes_col = st.columns([3, 2])
    with alerts_col:
        st.markdown("#### Active alerts")
        alert_panel(snapshot.alerts, snapshot.incidents, limit=8)
    with changes_col:
        st.markdown("#### Recent changes")
        change_feed(snapshot.changes, limit=12)

    st.divider()
    source_footer(snapshot.sources)
    read_only_notice()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _reading(component, key: str):
    if component is None:
        return None
    return next((r for r in component.readings if r.key == key), None)


def _crc_reading(component):
    """CRC reading for the watched disk, else whichever disk looks worst.

    WPV2E6LL is the one with the documented SATA-path history, so it gets the
    Overview slot by default — but if another disk starts climbing, that one
    is more urgent and takes the space.
    """
    if component is None:
        return None
    candidates = [r for r in component.readings if r.key.endswith(".crc")]
    if not candidates:
        return None
    preferred = next(
        (r for r in candidates if r.key == f"disk.{CRC_WATCH_SERIAL}.crc"), None
    )
    worst = max(candidates, key=lambda r: r.status.rank)
    if worst.status.rank > (preferred.status.rank if preferred else -1):
        return worst
    return preferred or worst


def _serial_from(reading) -> str:
    parts = reading.key.split(".")
    return parts[1] if len(parts) > 2 else "Disk"


def _tile(label: str, snapshot, component_key: str, reading_key: str | None) -> None:
    component = snapshot.component(component_key)
    if component is None:
        summary_tile(label, Status.UNKNOWN, "No data")
        return
    if reading_key:
        reading = _reading(component, reading_key)
        if reading is not None:
            summary_tile(
                label,
                reading.status,
                reading.status.label,
                help_text=reading.detail,
            )
            return
    summary_tile(label, component.status, component.status.label, help_text=component.detail)


def _kpi(component, key: str, label: str, unit: str) -> None:
    reading = _reading(component, key)
    if reading is None:
        metric_card(label, "—")
        return
    metric_card(
        label,
        f"{reading.value}{unit}" if reading.value is not None else reading.display_value,
        help_text=reading.detail,
    )


def _forecast_caption(forecast) -> None:
    if forecast is None:
        return
    if not forecast.available:
        st.caption(f":gray[Forecast unavailable — {forecast.reason}]")
        return
    growth = forecast.growth_bytes_per_day
    parts = [f"Growth {human_bytes(growth)}/day"]
    if forecast.growth_bytes_30d is not None:
        parts.append(f"30-day {format_delta(forecast.growth_bytes_30d / 1e9, ' GB', 0)}")
    if forecast.date_90_percent:
        parts.append(f"90% about {format_date(forecast.date_90_percent)}")
    st.caption(":gray[" + " · ".join(parts) + "]")


overview()
