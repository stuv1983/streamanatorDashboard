"""RAID & physical disks — the highest-priority drill-down.

Two ideas drive this page:

* The array's member count is stated plainly and prominently. A degraded RAID5
  has no remaining redundancy, so it is never buried inside a chart.
* Physical disks are keyed by **serial**, and their counters are presented as
  deltas. `/dev/sdX` moved between boots on this host, and a large static CRC
  count is a scar rather than a live fault — the trend is the signal.
"""

from __future__ import annotations

import streamlit as st

from components.cards import delta_card, not_configured_card, reading_card, status_card
from components.charts import time_series, to_table
from components.layout import grafana_link, health_table, page_header, read_only_notice
from config import CRC_WATCH_SERIAL, TIME_RANGES, get_settings
from core.collector import M_SMART_CRC, M_SMART_TEMP
from core.runtime import get_snapshot, history_series
from core.status import Status
from services.system import get_md_detail
from utils.formatting import human_bytes, human_duration

settings = get_settings()
snapshot = get_snapshot()
raid = snapshot.component("raid_disks")
raw = snapshot.raw.get("raid", {})
range_label = st.session_state.get("time_range", "24h")
range_seconds = dict(TIME_RANGES).get(range_label, 86400)

page_header(
    "RAID & physical disks",
    f"Array {settings.raid.device} · {settings.raid.required_members} × 8 TB IronWolf "
    f"· identified by serial, never by /dev/sdX",
    snapshot.collected_at,
)

# ---------------------------------------------------------------------------
# Array state
# ---------------------------------------------------------------------------

array_reading = next(
    (r for r in raid.readings if r.key.startswith("raid.")), None
) if raid else None

if array_reading is None:
    st.error("RAID state could not be read.", icon=":material/error:")
else:
    extra = array_reading.extra
    left, right = st.columns([1, 1])
    with left:
        status_card(
            label=f"Array {settings.raid.device}",
            status=array_reading.status,
            value=f"{array_reading.value}   [{extra.get('state_string', '')}]",
            detail=array_reading.detail,
            threshold=array_reading.threshold,
            source=array_reading.source,
            age_seconds=array_reading.age_seconds,
        )
    with right:
        with st.container(border=True):
            st.markdown("**Array detail**")
            facts = {
                "Level": extra.get("level", "—"),
                "Members (kernel names)": ", ".join(extra.get("members", [])) or "—",
                "Sync action": extra.get("sync_action") or "idle",
            }
            if extra.get("sync_percent") is not None:
                facts["Sync progress"] = f"{extra['sync_percent']:.1f}%"
                facts["Sync speed"] = f"{(extra.get('sync_speed_kbps') or 0) / 1024:.0f} MB/s"
                facts["Estimated completion"] = human_duration(
                    (extra.get("sync_finish_minutes") or 0) * 60
                )
            for key, value in facts.items():
                st.markdown(f"- **{key}:** {value}")
            st.caption(
                ":gray[Kernel device names are shown for reference only. They have "
                "changed across reboots on this host — always confirm a physical "
                "disk by its serial before acting on it.]"
            )

    if array_reading.status is Status.CRITICAL:
        st.error(
            "**The array has lost redundancy.** Identify the missing member by "
            "serial with `lsblk -o NAME,SIZE,MODEL,SERIAL`, check `dmesg` for ATA "
            "errors on that port, and re-add with `mdadm --re-add`. Do not replace "
            "a disk purely because its device letter changed.",
            icon=":material/error:",
        )

    grafana_link("/d/raid/raid-health", "Open RAID dashboard in Grafana")

with st.expander("mdadm --detail output"):
    detail = get_md_detail(settings.raid.device, settings.local.command_timeout)
    if detail:
        st.dataframe(
            {"Property": list(detail.keys()), "Value": list(detail.values())},
            hide_index=True,
            width="stretch",
        )
    else:
        st.caption(
            "`mdadm --detail` returned nothing — it usually needs root. The array "
            "state above comes from /proc/mdstat, which is world readable and is "
            "the authoritative source for member counts."
        )

st.divider()

# ---------------------------------------------------------------------------
# Physical disks
# ---------------------------------------------------------------------------

st.markdown("### Physical disks")

smart_disks = raw.get("smart") or {}
smart_error = raw.get("smart_error", "")

if not smart_disks:
    not_configured_card(
        "SMART disk health",
        smart_error
        or "No SMART source is available, so physical disk health is unknown.",
        steps=(
            "Preferred: deploy smartctl_exporter — see deploy/monitoring-stack/docker-compose.yml.",
            "Alternative: install deploy/sudoers-smartctl (read-only smartctl via sudo),",
            "then set SMARTCTL_SUDO=true in the dashboard .env and restart the service.",
        ),
        source="smartctl",
    )
    st.info(
        "Until a SMART source exists, the array's member count is still monitored "
        "from /proc/mdstat — but pending sectors, temperature and CRC trends "
        "cannot be seen. This is the highest-value missing integration.",
        icon=":material/info:",
    )
else:
    # The watched disk goes first: it carries the documented CRC history.
    watched = [s for s in smart_disks if s == CRC_WATCH_SERIAL]
    others = sorted(s for s in smart_disks if s != CRC_WATCH_SERIAL)

    for serial in watched + others:
        disk = smart_disks[serial]
        config_entry = settings.disk(serial)
        is_watched = serial == CRC_WATCH_SERIAL

        with st.container(border=True):
            header, badge = st.columns([3, 1], vertical_alignment="center")
            with header:
                st.markdown(f"#### {serial}")
                st.caption(
                    f"{disk.model or (config_entry.model if config_entry else '')} · "
                    f"{config_entry.role if config_entry else 'unknown role'}"
                    + (f" · currently {disk.device}" if disk.device else "")
                )
            with badge:
                if is_watched:
                    st.badge(
                        "Watched", icon=":material/visibility:", color="orange"
                    )

            crc_reading = next(
                (r for r in raid.readings if r.key == f"disk.{serial}.crc"), None
            )
            if crc_reading is not None:
                crc_extra = crc_reading.extra
                delta_card(
                    label="UDMA CRC error count",
                    status=crc_reading.status,
                    current=f"{crc_reading.value:,}"
                    if crc_reading.value is not None
                    else "—",
                    deltas={
                        "1 hour": crc_extra.get("delta_1h"),
                        "24 hours": crc_extra.get("delta_24h"),
                        "7 days": crc_extra.get("delta_7d"),
                        "30 days": crc_extra.get("delta_30d"),
                    },
                    detail=crc_reading.detail,
                    threshold=crc_reading.threshold,
                    source=crc_reading.source,
                )
                coverage = crc_extra.get("coverage_seconds", 0)
                if coverage < 7 * 86400:
                    st.caption(
                        f":gray[History covers {human_duration(coverage)}. Longer "
                        f"windows fill in as the sampler accumulates data.]"
                    )

                crc_samples = history_series(
                    M_SMART_CRC, {"serial": serial}, range_seconds
                )
                chart = time_series(crc_samples, "CRC errors", zero=False)
                if chart is not None:
                    st.altair_chart(chart, width="stretch")
                    with st.expander("Table view"):
                        st.dataframe(
                            to_table(crc_samples, "CRC errors"),
                            hide_index=True,
                            width="stretch",
                        )

            attribute_readings = [
                r
                for r in raid.readings
                if r.key.startswith(f"disk.{serial}.") and not r.key.endswith(".crc")
            ]
            columns = st.columns(min(4, len(attribute_readings)) or 1)
            for column, reading in zip(columns * 2, attribute_readings):
                with column:
                    reading_card(reading)

            facts = st.columns(4)
            with facts[0]:
                st.caption("Power-on hours")
                st.markdown(
                    f"**{disk.power_on_hours:,.0f}**"
                    if disk.power_on_hours is not None
                    else "**—**"
                )
            with facts[1]:
                st.caption("Power cycles")
                st.markdown(
                    f"**{disk.power_cycle_count:,.0f}**"
                    if disk.power_cycle_count is not None
                    else "**—**"
                )
            with facts[2]:
                st.caption("Command timeouts")
                st.markdown(
                    f"**{disk.command_timeouts:,.0f}**"
                    if disk.command_timeouts is not None
                    else "**—**"
                )
            with facts[3]:
                st.caption("Reported uncorrectable")
                st.markdown(
                    f"**{disk.reported_uncorrectable:,.0f}**"
                    if disk.reported_uncorrectable is not None
                    else "**—**"
                )

            temp_samples = history_series(M_SMART_TEMP, {"serial": serial}, range_seconds)
            temp_chart = time_series(temp_samples, "Temperature", " (°C)", height=120)
            if temp_chart is not None:
                st.altair_chart(temp_chart, width="stretch")

st.divider()
st.markdown("### All disk readings")
health_table(raid.readings if raid else [], "Sorted worst-first.")
read_only_notice()
