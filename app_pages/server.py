"""Server — host health for streamanator."""

from __future__ import annotations

import streamlit as st

from components.cards import metric_card, readings_grid
from components.charts import threshold_series, time_series, to_table
from components.layout import (
    chart_source_caption,
    grafana_link,
    health_table,
    page_header,
    read_only_notice,
)
from config import TIME_RANGES, get_settings
from core.collector import M_CPU, M_IOWAIT, M_MEM_AVAIL
from core.runtime import get_snapshot, trend_series
from health.thresholds import get_thresholds
from services.system import get_unit_logs, get_unit_state
from utils.formatting import human_bytes, human_duration

settings = get_settings()
thresholds = get_thresholds()
snapshot = get_snapshot()
server = snapshot.component("server")
raw = snapshot.raw.get("server", {})
host_snapshot = raw.get("snapshot")
range_label = st.session_state.get("time_range", "24h")
range_seconds = dict(TIME_RANGES).get(range_label, 86400)

page_header(
    "Server",
    f"{settings.host.hostname} · {settings.host.cpu_cores} cores · Ubuntu Server",
    snapshot.collected_at,
)

# ---------------------------------------------------------------------------
# KPI row
# ---------------------------------------------------------------------------

memory = host_snapshot.memory if host_snapshot else None
cpu = host_snapshot.cpu if host_snapshot else None
load = host_snapshot.load if host_snapshot else None

kpis = st.container(horizontal=True)
with kpis:
    metric_card(
        "CPU",
        f"{cpu.used_percent:.1f}%" if cpu else "—",
        help_text="Utilisation since the previous sample, excluding iowait.",
    )
    metric_card(
        "iowait",
        f"{cpu.iowait_percent:.1f}%" if cpu else "—",
        help_text="Time the CPU spent waiting on storage.",
    )
    metric_card(
        "RAM available",
        f"{memory.available_percent:.1f}%" if memory else "—",
        help_text=(
            "MemAvailable — the kernel's estimate of memory a new workload could "
            "use without swapping. Free memory would look alarming here because "
            "most of it is legitimately page cache."
        ),
    )
    metric_card(
        "Swap",
        f"{memory.swap_used_percent:.1f}%" if memory else "—",
    )
    metric_card(
        "Load (1/5/15)",
        f"{load.one:.2f} / {load.five:.2f} / {load.fifteen:.2f}" if load else "—",
        help_text=f"Judged against {settings.host.cpu_cores} cores.",
    )
    metric_card(
        "Uptime",
        human_duration(host_snapshot.uptime_seconds, parts=2)
        if host_snapshot and host_snapshot.uptime_seconds
        else "—",
    )
    metric_card(
        "Processes",
        f"{host_snapshot.process_count:,}"
        if host_snapshot and host_snapshot.process_count
        else "—",
    )

if memory is not None:
    with st.container(border=True):
        st.markdown("**Memory breakdown**")
        columns = st.columns(4)
        for column, (label, value) in zip(
            columns,
            (
                ("Total", memory.total_bytes),
                ("Available", memory.available_bytes),
                ("Used", memory.used_bytes),
                ("Cache + buffers", memory.cached_bytes),
            ),
        ):
            with column:
                st.caption(label)
                st.markdown(f"**{human_bytes(value)}**")
        st.caption(
            ":gray[Cache is not pressure. It is reclaimable memory doing useful "
            "work, which is why availability is judged on MemAvailable.]"
        )

# ---------------------------------------------------------------------------
# Trends
# ---------------------------------------------------------------------------

st.markdown("### Trends")
left, right = st.columns(2)

with left:
    with st.container(border=True):
        st.markdown("**CPU utilisation**")
        samples = trend_series(M_CPU, None, range_seconds)
        chart = threshold_series(
            samples,
            "CPU",
            warning=thresholds.host.cpu_warning_percent,
            critical=thresholds.host.cpu_critical_percent,
            unit=" (%)",
        )
        if chart is None:
            st.caption("No history yet.")
        else:
            st.altair_chart(chart, width="stretch")
            chart_source_caption(samples)

    with st.container(border=True):
        st.markdown("**Memory available**")
        samples = trend_series(M_MEM_AVAIL, None, range_seconds)
        chart = time_series(samples, "Available", " (%)", area=True)
        if chart is None:
            st.caption("No history yet.")
        else:
            st.altair_chart(chart, width="stretch")
            chart_source_caption(samples)

with right:
    with st.container(border=True):
        st.markdown("**iowait**")
        samples = trend_series(M_IOWAIT, None, range_seconds)
        chart = threshold_series(
            samples,
            "iowait",
            warning=thresholds.host.iowait_warning_percent,
            critical=thresholds.host.iowait_critical_percent,
            unit=" (%)",
        )
        if chart is None:
            st.caption("No history yet.")
        else:
            st.altair_chart(chart, width="stretch")
            chart_source_caption(samples)
            with st.expander("Table view"):
                st.dataframe(to_table(samples, "iowait"), hide_index=True, width="stretch")

    with st.container(border=True):
        st.markdown("**Temperatures**")
        sensors = host_snapshot.temperatures if host_snapshot else {}
        if not sensors:
            st.caption(
                "No hwmon sensors are exposed. Install lm-sensors and run "
                "`sensors-detect` to enable CPU/board temperature monitoring."
            )
        else:
            import pandas as pd

            frame = pd.DataFrame(
                {
                    "Sensor": list(sensors.keys()),
                    "Temperature": [f"{value:.1f} °C" for value in sensors.values()],
                }
            )
            st.dataframe(frame, hide_index=True, width="stretch")

# ---------------------------------------------------------------------------
# systemd
# ---------------------------------------------------------------------------

st.markdown("### systemd")

failed = host_snapshot.failed_units if host_snapshot else None
if failed is None:
    st.warning("systemd could not be queried.", icon=":material/warning:")
elif not failed:
    st.success("No failed units.", icon=":material/check_circle:")
else:
    st.error(
        f"{len(failed)} failed unit(s): " + ", ".join(u.name for u in failed),
        icon=":material/error:",
    )
    for unit in failed:
        with st.expander(f"{unit.name} — {unit.description or 'no description'}"):
            st.markdown(
                f"- **Load:** {unit.load_state}\n"
                f"- **Active:** {unit.active_state}\n"
                f"- **Sub:** {unit.sub_state}"
            )
            logs = get_unit_logs(unit.name, lines=20)
            if logs:
                st.code("\n".join(logs), language="log")
            else:
                st.caption(
                    "Journal access is unavailable to the dashboard user. Run "
                    f"`journalctl -u {unit.name} -n 50` for detail."
                )

with st.expander("Watched units"):
    from config import WATCHED_UNITS
    import pandas as pd

    rows = []
    for name in WATCHED_UNITS:
        unit = get_unit_state(name, settings.local.command_timeout)
        rows.append(
            {
                "Unit": name,
                "Load": unit.load_state if unit else "—",
                "Active": unit.active_state if unit else "not found",
                "Sub": unit.sub_state if unit else "—",
            }
        )
    st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")

grafana_link("cpu", "Open host dashboard in Grafana")

st.divider()
health_table(server.readings if server else [])
read_only_notice()
