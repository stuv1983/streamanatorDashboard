"""Applications — synthetic probes and Sports Data Lab.

A container being "Up" is not evidence that its application works. Everything
on this page is measured by asking the service a question and checking the
answer.
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

from components.cards import metric_card, not_configured_card, reading_card
from components.charts import magnitude_bar
from components.layout import health_table, page_header, read_only_notice
from components.theme import style
from config import TIME_RANGES, get_settings
from core.collector import M_DB_SIZE
from core.runtime import get_snapshot, trend_series
from core.status import Status
from services.sportsdb import verify_database
from utils.formatting import format_timestamp, human_age, human_bytes, human_duration

settings = get_settings()
snapshot = get_snapshot()
applications = snapshot.component("applications")
raw = snapshot.raw.get("applications", {})
probes = raw.get("probes", {})
range_label = st.session_state.get("time_range", "24h")
range_seconds = dict(TIME_RANGES).get(range_label, 86400)

page_header(
    "Applications",
    "Synthetic HTTP probes and application data freshness",
    snapshot.collected_at,
)

# ---------------------------------------------------------------------------
# Probe table
# ---------------------------------------------------------------------------

st.markdown("### Service probes")

if not settings.blackbox.configured:
    st.info(
        "Probes are being run directly from the dashboard process. Deploying "
        "**Blackbox Exporter** would move them into Prometheus, giving continuous "
        "probing and history rather than point-in-time checks at page load. See "
        "`deploy/monitoring-stack/`.",
        icon=":material/info:",
    )

rows = []
latency_labels: list[str] = []
latency_values: list[float] = []
latency_statuses: list[Status] = []
for endpoint in settings.endpoints:
    reading = next(
        (r for r in (applications.readings if applications else []) if r.key == f"probe.{endpoint.key}"),
        None,
    )
    probe = probes.get(endpoint.key)
    status = reading.status if reading else Status.UNKNOWN
    if probe and probe.latency_ms is not None:
        latency_labels.append(endpoint.display)
        latency_values.append(float(probe.latency_ms))
        latency_statuses.append(status)
    rows.append(
        {
            "_rank": status.rank,
            "Status": f"{style(status).icon} {status.value}",
            "Service": endpoint.display,
            "HTTP": str(probe.status_code) if probe and probe.status_code else "—",
            "Latency": f"{probe.latency_ms:.0f} ms"
            if probe and probe.latency_ms is not None
            else "—",
            "DNS": f"{probe.dns_ms:.0f} ms" if probe and probe.dns_ms is not None else "—",
            "TCP": f"{probe.connect_ms:.0f} ms"
            if probe and probe.connect_ms is not None
            else "—",
            "TLS expiry": f"{probe.tls_days_remaining:.0f} d"
            if probe and probe.tls_days_remaining is not None
            else "—",
            "Hosting": endpoint.hosting,
            "URL": endpoint.url or "not configured",
        }
    )

frame = pd.DataFrame(rows).sort_values("_rank", ascending=False).drop(columns=["_rank"])
st.dataframe(
    frame,
    hide_index=True,
    width="stretch",
    column_config={
        "Hosting": st.column_config.TextColumn(width="medium"),
        "URL": st.column_config.TextColumn(width="medium"),
    },
)

latency_chart = magnitude_bar(
    latency_labels,
    latency_values,
    "HTTP latency",
    " (ms)",
    latency_statuses,
)
if latency_chart is not None:
    st.markdown("#### Current response time")
    st.altair_chart(latency_chart, width="stretch")

st.caption(
    ":gray[Stage timings are separated deliberately: a DNS failure and an "
    "application returning 500 are very different problems, and the download "
    "stack has previously failed at the DNS stage while every container "
    "reported healthy.]"
)

st.divider()

# ---------------------------------------------------------------------------
# Sports Data Lab
# ---------------------------------------------------------------------------

st.markdown("### Sports Data Lab")

sdl_endpoint = settings.endpoint("sports_data_lab")
sdl_reading = next(
    (r for r in (applications.readings if applications else []) if r.key == "probe.sports_data_lab"),
    None,
)

info_col, detail_col = st.columns([1, 2])
with info_col:
    if sdl_reading is not None:
        reading_card(sdl_reading)
with detail_col:
    with st.container(border=True):
        st.markdown("**Deployment**")
        st.markdown(
            f"- **Path:** `{settings.sports_databases[0].path.rsplit('/data', 1)[0]}`\n"
            f"- **Service:** `sports-data-lab.service` (systemd, not tmux)\n"
            f"- **Listener:** port **6969**\n"
            f"- **URL:** {sdl_endpoint.url if sdl_endpoint else '—'}"
        )
        st.caption(
            ":gray[The project README recorded port 8501 for this app. On the live "
            "host 8501 belongs to a different Streamlit service (AquaLog); Sports "
            "Data Lab listens on 6969. The live system is authoritative.]"
        )

# ---------------------------------------------------------------------------
# Sports databases
# ---------------------------------------------------------------------------

st.markdown("#### Sports databases")

databases = raw.get("sports_databases") or []
if not databases:
    st.caption("No sports databases configured.")
else:
    for database in databases:
        with st.container(border=True):
            header, badge = st.columns([3, 1], vertical_alignment="center")
            with header:
                st.markdown(f"**{database.display}** — `{database.path}`")
            with badge:
                if database.stale:
                    st.badge("Stale", icon=":material/warning:", color="orange")
                elif database.exists:
                    st.badge("Current", icon=":material/check_circle:", color="green")
                else:
                    st.badge("Missing", icon=":material/error:", color="red")

            if not database.exists:
                st.caption(database.error)
                continue

            facts = st.columns(5)
            with facts[0]:
                st.caption("Size")
                st.markdown(f"**{human_bytes(database.size_bytes)}**")
            with facts[1]:
                st.caption("Last update")
                st.markdown(f"**{format_timestamp(database.modified_at)}**")
            with facts[2]:
                st.caption("Age")
                st.markdown(f"**{human_duration(database.age_seconds)}**")
            with facts[3]:
                st.caption("Local snapshots")
                st.markdown(f"**{database.backup_count}**")
            with facts[4]:
                st.caption("Latest snapshot")
                st.markdown(
                    f"**{human_age(database.latest_backup_at)}**"
                    if database.latest_backup_at
                    else "**—**"
                )

            # Growth from the history store — a database that stops growing is
            # the actual signal, not its absolute size.
            samples = trend_series(
                M_DB_SIZE, {"db": database.key}, max(range_seconds, 7 * 86400)
            )
            if len(samples) >= 2:
                growth = samples[-1][1] - samples[0][1]
                span = (samples[-1][0] - samples[0][0]) / 86400.0
                st.caption(
                    f":gray[Growth: {human_bytes(growth)} over {span:.1f} days]"
                )

            with st.expander("Verify integrity (PRAGMA integrity_check)"):
                st.caption(
                    "Reads the entire database. Opened read-only, so verification "
                    "cannot modify the file. A 'database is locked' result means "
                    "the application is writing — not that the data is corrupt."
                )
                if st.button(
                    f"Verify {database.display}",
                    key=f"verify_{database.key}",
                    icon=":material/fact_check:",
                ):
                    with st.spinner(f"Checking {database.display}…"):
                        result = verify_database(database.path)
                    if result.ok:
                        st.success(
                            f"Integrity: ok ({result.duration_seconds:.1f}s)",
                            icon=":material/check_circle:",
                        )
                    else:
                        st.error(f"Integrity: {result.detail}", icon=":material/error:")

st.divider()
health_table(applications.readings if applications else [])
read_only_notice()
