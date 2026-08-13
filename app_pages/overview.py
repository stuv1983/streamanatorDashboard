"""Overview — a concise operational summary, not a duplicate of every page."""

from __future__ import annotations

import streamlit as st

from components.alerts import alert_banner, change_feed
from components.cards import counter_card, metric_card, status_card
from components.charts import status_bar, threshold_series, time_series
from components.layout import (
    chart_source_caption,
    health_header,
    page_header,
    read_only_notice,
    source_footer,
)
from config import TIME_RANGES, get_settings
from core.collector import M_CPU, M_LATENCY
from core.runtime import get_snapshot, trend_series
from core.status import Status
from health.thresholds import get_thresholds
from utils.formatting import format_percent, human_bytes

settings = get_settings()
thresholds = get_thresholds()
refresh_seconds = st.session_state.get("refresh_seconds", 30)
range_label = st.session_state.get("time_range", "24h")
range_seconds = dict(TIME_RANGES).get(range_label, 86400)


@st.fragment(run_every=refresh_seconds if refresh_seconds else None)
def overview() -> None:
    snapshot = get_snapshot()
    health = snapshot.health

    page_header(
        "Overview",
        "What needs attention, what is healthy, and what is changing",
        snapshot.collected_at,
    )
    health_header(health, snapshot.collected_at, snapshot.duration_seconds)
    alert_banner(snapshot.alerts)

    # Problems are one click from the headline, but their full diagnostic cards
    # no longer push every useful overview signal below the fold.
    if snapshot.alerts or snapshot.incidents:
        problem_count = len(snapshot.alerts)
        with st.expander(
            f"Active finding details · {problem_count}",
            expanded=health.status is Status.CRITICAL,
            icon=":material/notification_important:",
        ):
            if snapshot.incidents:
                st.markdown("**Correlated incidents**")
                for incident in snapshot.incidents:
                    st.markdown(
                        f":material/{incident.status.icon}: **{incident.title}** — "
                        f"{incident.cause.title}"
                    )
                    st.caption(incident.explanation)
            if snapshot.alerts:
                ordered_alerts = sorted(
                    snapshot.alerts,
                    key=lambda alert: alert.status.rank,
                    reverse=True,
                )
                st.dataframe(
                    [
                        {
                            "Severity": alert.status.label,
                            "Finding": alert.title,
                            "Component": alert.component,
                            "Current": alert.current_value or "—",
                            "Threshold": alert.threshold or "—",
                            "Next check": alert.recommended_action or "—",
                        }
                        for alert in ordered_alerts
                    ],
                    hide_index=True,
                    width="stretch",
                    column_config={
                        "Finding": st.column_config.TextColumn(width="medium"),
                        "Next check": st.column_config.TextColumn(width="large"),
                    },
                )

    st.markdown("### System at a glance")
    health_col, snapshot_col = st.columns([3, 2], vertical_alignment="top")

    with health_col:
        with st.container(border=True):
            st.markdown("**Component health**")
            components = health.worst_components
            chart = status_bar(
                [component.label for component in components],
                [component.status for component in components],
                height=max(180, len(components) * 27),
            )
            if chart is not None:
                st.altair_chart(chart, width="stretch")
            st.caption(
                ":gray[Worst states sort first. Open a subsystem page for its "
                "measurements and troubleshooting detail.]"
            )

    with snapshot_col:
        st.markdown("**Live snapshot**")
        internet = snapshot.raw.get("network", {}).get("internet_ping")
        media = _reading(snapshot.component("storage"), "storage./mnt/media")
        media_usage = media.extra.get("usage") if media else None
        containers = snapshot.raw.get("containers", {})
        backup = _worst_reading(snapshot.component("backups"), "backup.")

        first, second = st.columns(2)
        with first:
            metric_card(
                "Internet",
                f"{internet.latency_ms:.0f} ms"
                if internet and internet.latency_ms is not None
                else "No response",
                help_text=(
                    f"{format_percent(internet.packet_loss_percent)} packet loss"
                    if internet and internet.packet_loss_percent is not None
                    else "Latency unavailable"
                ),
            )
            metric_card(
                "Containers",
                f"{containers.get('running_count', '—')} / "
                f"{containers.get('expected_count', '—')}",
                help_text="Expected containers running",
            )
        with second:
            metric_card(
                "Media storage",
                f"{media.value}% used" if media and media.value is not None else "—",
                help_text=(
                    f"{human_bytes(media_usage.free_bytes)} free"
                    if media_usage
                    else "Capacity unavailable"
                ),
            )
            metric_card(
                "Oldest backup",
                str(backup.value) if backup and backup.value is not None else "—",
                help_text=backup.detail if backup else "Backup status unavailable",
            )

    st.markdown("### Key trends")
    latency_col, cpu_col = st.columns(2)
    with latency_col:
        with st.container(border=True):
            st.markdown("**Internet latency**")
            latency_samples = trend_series(M_LATENCY, None, range_seconds)
            latency_chart = threshold_series(
                latency_samples,
                "Latency",
                warning=thresholds.network.latency_warning_ms,
                critical=thresholds.network.latency_critical_ms,
                unit=" (ms)",
            )
            if latency_chart is None:
                st.caption("No latency history yet.")
            else:
                st.altair_chart(latency_chart, width="stretch")
                chart_source_caption(latency_samples)

    with cpu_col:
        with st.container(border=True):
            st.markdown("**Host CPU**")
            cpu_samples = trend_series(M_CPU, None, range_seconds)
            cpu_chart = time_series(
                cpu_samples, "CPU", " (%)", area=True, zero=True
            )
            if cpu_chart is None:
                st.caption("No CPU history yet.")
            else:
                st.altair_chart(cpu_chart, width="stretch")
                chart_source_caption(cpu_samples)

    st.markdown("### Resilience")
    raid_col, storage_col, backup_col = st.columns(3)
    with raid_col:
        array = _reading(
            snapshot.component("raid_disks"), f"raid.{settings.raid.device}"
        )
        if array:
            state = array.extra.get("state_string", "")
            status_card(
                "RAID array",
                array.status,
                f"{array.value} [{state}]",
                detail=array.detail,
                source=array.source,
            )
        else:
            status_card("RAID array", Status.UNKNOWN, "Unavailable")

    with storage_col:
        worst_storage = _worst_reading(snapshot.component("storage"), "storage.")
        if worst_storage:
            usage = worst_storage.extra.get("usage")
            status_card(
                worst_storage.label,
                worst_storage.status,
                worst_storage.display_value,
                detail=(
                    f"{human_bytes(usage.free_bytes)} free of "
                    f"{human_bytes(usage.total_bytes)}"
                    if usage
                    else worst_storage.detail
                ),
                source=worst_storage.source,
            )
        else:
            status_card("Storage", Status.UNKNOWN, "Unavailable")

    with backup_col:
        if backup:
            status_card(
                backup.label,
                backup.status,
                backup.display_value,
                detail=backup.detail,
                source=backup.source,
            )
        else:
            status_card("Backups", Status.UNKNOWN, "Unavailable")

    st.markdown("### Essential services")
    applications = snapshot.component("applications")
    vpn = snapshot.component("vpn")
    service_row = st.container(horizontal=True)
    with service_row:
        for key in ("plex", "immich", "sports_data_lab"):
            reading = _reading(applications, f"probe.{key}")
            if reading:
                counter_card(
                    reading.label,
                    reading.status,
                    reading.display_value,
                    reading.detail[:70],
                )
        tunnel = _reading(vpn, "vpn.gluetun")
        if tunnel:
            counter_card(
                "Media VPN",
                tunnel.status,
                str(tunnel.value or "No tunnel"),
                "Gluetun exit",
            )
        leak = _reading(vpn, "vpn.leak")
        if leak:
            counter_card(
                "VPN leak check",
                leak.status,
                str(leak.value or "Unknown"),
                leak.detail[:70],
            )

    with st.expander(
        f"Recent changes · {len(snapshot.changes)}",
        icon=":material/history:",
    ):
        change_feed(snapshot.changes, limit=15)

    source_footer(snapshot.sources)
    read_only_notice()


def _reading(component, key: str):
    if component is None:
        return None
    return next((reading for reading in component.readings if reading.key == key), None)


def _worst_reading(component, prefix: str):
    if component is None:
        return None
    candidates = [
        reading
        for reading in component.readings
        if reading.key.startswith(prefix)
        and ".integrity." not in reading.key
        and ".size." not in reading.key
    ]
    return max(candidates, key=lambda reading: reading.status.rank, default=None)


overview()
