"""Storage — capacity, growth and forecasting.

Percentage used is the least interesting number here. `/mnt/media` sits at 78%
and will stay in that neighbourhood for a long time; what actually informs a
decision is how fast it is growing and when it crosses 90%. So each filesystem
leads with usage, then growth rate, then projected crossing dates — and says
plainly when there is not enough history to project.
"""

from __future__ import annotations

import streamlit as st

from components.cards import status_card
from components.charts import capacity_projection, time_series, to_table
from components.layout import grafana_link, health_table, page_header, read_only_notice
from config import TIME_RANGES, get_settings
from core.collector import M_FS_USED
from core.runtime import get_snapshot, history_series
from services.system import get_disk_io_rates
from utils.formatting import format_date, human_bytes, human_bytes_per_second

settings = get_settings()
snapshot = get_snapshot()
storage = snapshot.component("storage")
raw = snapshot.raw.get("storage", {})
range_label = st.session_state.get("time_range", "24h")
range_seconds = dict(TIME_RANGES).get(range_label, 86400)

page_header(
    "Storage",
    "Filesystem capacity, growth rate and projected fill dates",
    snapshot.collected_at,
)

for filesystem in settings.filesystems:
    reading = next(
        (r for r in storage.readings if r.key == f"storage.{filesystem.mountpoint}"),
        None,
    )
    if reading is None:
        continue

    usage = reading.extra.get("usage")
    forecast = reading.extra.get("forecast")

    with st.container(border=True):
        st.markdown(f"### {filesystem.mountpoint}")
        st.caption(filesystem.label)

        summary, detail_col = st.columns([1, 2])
        with summary:
            status_card(
                label="Usage",
                status=reading.status,
                value=f"{reading.value}%" if reading.value is not None else "—",
                detail=reading.detail,
                threshold=reading.threshold,
                source=reading.source,
                age_seconds=reading.age_seconds,
            )

        with detail_col:
            if usage is not None:
                facts = st.columns(4)
                with facts[0]:
                    st.caption("Total")
                    st.markdown(f"**{human_bytes(usage.total_bytes)}**")
                with facts[1]:
                    st.caption("Used")
                    st.markdown(f"**{human_bytes(usage.used_bytes)}**")
                with facts[2]:
                    st.caption("Free")
                    st.markdown(f"**{human_bytes(usage.free_bytes)}**")
                with facts[3]:
                    st.caption("Inodes used")
                    st.markdown(
                        f"**{usage.inodes_used_percent:.1f}%**"
                        if usage.inodes_used_percent is not None
                        else "**—**"
                    )

            if forecast is None:
                st.caption(":gray[Forecasting is disabled for this filesystem.]")
            elif not forecast.available:
                st.info(
                    f"**Forecast unavailable** — {forecast.reason}",
                    icon=":material/info:",
                )
                if forecast.growth_bytes_per_day is not None:
                    st.caption(
                        f"Observed growth so far: "
                        f"{human_bytes(forecast.growth_bytes_per_day)}/day over "
                        f"{forecast.history_days:.1f} days."
                    )
            else:
                projections = st.columns(4)
                with projections[0]:
                    st.caption("Growth")
                    st.markdown(
                        f"**{human_bytes(forecast.growth_bytes_per_day)}/day**"
                    )
                    if forecast.growth_tb_per_month is not None:
                        st.caption(f"{forecast.growth_tb_per_month:.2f} TiB/month")
                with projections[1]:
                    st.caption("Reaches 80%")
                    st.markdown(f"**{format_date(forecast.date_80_percent)}**")
                with projections[2]:
                    st.caption("Reaches 90%")
                    st.markdown(f"**{format_date(forecast.date_90_percent)}**")
                with projections[3]:
                    st.caption("Full")
                    st.markdown(f"**{format_date(forecast.date_full)}**")
                st.caption(
                    f":gray[Linear fit over {forecast.history_days:.1f} days, "
                    f"{forecast.sample_count} samples, R²={forecast.r_squared:.2f}]"
                )

        samples = history_series(
            M_FS_USED, {"mount": filesystem.mountpoint}, max(range_seconds, 7 * 86400)
        )
        if usage is not None and samples:
            chart = capacity_projection(samples, usage.total_bytes, forecast)
            if chart is not None:
                st.altair_chart(chart, width="stretch")
                with st.expander("Table view"):
                    st.dataframe(
                        to_table(
                            [(ts, value / (1024**4)) for ts, value in samples],
                            "Used (TiB)",
                        ),
                        hide_index=True,
                        width="stretch",
                    )
        else:
            st.caption(
                ":gray[No usage history yet. The background sampler records every "
                "filesystem once a minute; growth and forecasts appear once a few "
                "days of history exist.]"
            )

        # Observed growth windows are measured differences, shown even when the
        # regression was rejected as unreliable.
        if forecast is not None:
            windows = st.columns(3)
            for column, (label, value) in zip(
                windows,
                (
                    ("7-day growth", forecast.growth_bytes_7d),
                    ("30-day growth", forecast.growth_bytes_30d),
                    ("90-day growth", forecast.growth_bytes_90d),
                ),
            ):
                with column:
                    st.caption(label)
                    st.markdown(
                        f"**{human_bytes(value)}**" if value is not None else "**—**",
                        help="Measured difference, not a projection."
                        if value is not None
                        else "Not enough history to measure this window.",
                    )

st.divider()

# ---------------------------------------------------------------------------
# Disk I/O
# ---------------------------------------------------------------------------

st.markdown("### Disk performance")
st.caption(
    "Rates are measured between page renders, so the first view after a restart "
    "shows nothing rather than a since-boot average."
)

rates = get_disk_io_rates()
if not rates:
    st.info(
        "No I/O rates yet — two samples are needed to compute a rate. Refresh to "
        "populate.",
        icon=":material/info:",
    )
else:
    import pandas as pd

    interesting = {
        name: rate
        for name, rate in rates.items()
        if name == settings.raid.device or not name.startswith("md")
    }
    frame = pd.DataFrame(
        {
            "Device": list(interesting.keys()),
            "Read": [human_bytes_per_second(r.read_bytes_per_sec) for r in interesting.values()],
            "Write": [human_bytes_per_second(r.write_bytes_per_sec) for r in interesting.values()],
            "Read IOPS": [f"{r.read_iops:,.0f}" for r in interesting.values()],
            "Write IOPS": [f"{r.write_iops:,.0f}" for r in interesting.values()],
            "Read latency": [
                f"{r.read_latency_ms:.1f} ms" if r.read_latency_ms is not None else "—"
                for r in interesting.values()
            ],
            "Write latency": [
                f"{r.write_latency_ms:.1f} ms" if r.write_latency_ms is not None else "—"
                for r in interesting.values()
            ],
            "Utilisation": [f"{r.utilisation_percent:.0f}%" for r in interesting.values()],
        }
    )
    st.dataframe(frame, hide_index=True, width="stretch")
    st.caption(
        ":gray[Sustained 100% utilisation on the array members explains Plex "
        "buffering and slow imports more often than CPU does.]"
    )

grafana_link("/d/storage/storage-io", "Open storage dashboard in Grafana")

st.divider()
health_table(storage.readings if storage else [])
read_only_notice()
