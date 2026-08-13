"""Docker — container inventory, health and change detection.

Problems sort to the top. The table is the primary view because the question
here is comparative ("which one is wrong?"), and a grid of twelve identical
cards answers that worse than a sorted list.
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

from components.alerts import alert_card
from components.charts import status_bar
from components.layout import page_header, read_only_notice
from components.theme import style
from config import GLUETUN_PUBLISHED_PORTS, get_settings
from core.runtime import docker_versions, get_snapshot
from core.status import Status
from services.docker_service import find_container, get_container_logs
from utils.formatting import format_delta, human_duration

settings = get_settings()
snapshot = get_snapshot()
raw = snapshot.raw.get("containers", {})
applications = snapshot.component("applications")
containers = raw.get("containers") or []

page_header(
    "Docker",
    f"{raw.get('running_count', '—')} of {raw.get('expected_count', '—')} expected "
    f"containers running",
    snapshot.collected_at,
)

if not containers:
    st.error(
        "Docker could not be queried. Container health, restart tracking and "
        "image-change detection are all unavailable.",
        icon=":material/error:",
    )
    for alert in snapshot.alerts:
        if alert.key == "server.docker":
            alert_card(alert)
    st.stop()

# ---------------------------------------------------------------------------
# Expected container table
# ---------------------------------------------------------------------------

rows = []
chart_labels: list[str] = []
chart_statuses: list[Status] = []
for expected in settings.containers:
    container = find_container(containers, expected.name)
    reading = next(
        (r for r in applications.readings if r.key == f"container.{expected.name}"),
        None,
    ) if applications else None
    status = reading.status if reading else Status.UNKNOWN
    restart_delta = reading.extra.get("restart_delta") if reading else None
    chart_labels.append(expected.display)
    chart_statuses.append(status)

    rows.append(
        {
            "_rank": status.rank,
            "Status": f"{style(status).icon} {status.value}",
            "Container": expected.display,
            "Name": container.name if container else expected.name,
            "State": container.state if container else "missing",
            "Health": (container.health or "no healthcheck") if container else "—",
            "Image": container.image if container else "—",
            "Version": (container.version or "—") if container else "—",
            "Uptime": human_duration(container.uptime_seconds)
            if container and container.uptime_seconds
            else "—",
            "Restarts": container.restart_count if container else "—",
            "Recent restarts": format_delta(restart_delta)
            if restart_delta is not None
            else "—",
            "Behind VPN": "yes" if expected.behind_vpn else "no",
        }
    )

st.markdown("### Container health map")
health_chart = status_bar(
    chart_labels,
    chart_statuses,
    height=max(150, min(440, len(chart_labels) * 27)),
)
if health_chart is not None:
    st.altair_chart(health_chart, width="stretch")

frame = pd.DataFrame(rows).sort_values("_rank", ascending=False).drop(columns=["_rank"])
st.dataframe(
    frame,
    hide_index=True,
    width="stretch",
    column_config={
        "Image": st.column_config.TextColumn(width="medium"),
        "Status": st.column_config.TextColumn(width="small"),
    },
)
st.caption(
    ":gray[Sorted worst-first. 'Behind VPN' containers share Gluetun's network "
    "namespace — when it fails, they lose connectivity while still reporting Up.]"
)

# ---------------------------------------------------------------------------
# Port publications
# ---------------------------------------------------------------------------

st.markdown("### Published ports")
st.info(
    "Every media-stack port is published by the **gluetun** container, not by the "
    "application container itself. This is why `docker ps` shows no ports against "
    "Sonarr or SABnzbd, and why host port 8080 is SABnzbd rather than cAdvisor as "
    "the project README assumed.",
    icon=":material/info:",
)

port_frame = pd.DataFrame(
    {
        "Host port": list(GLUETUN_PUBLISHED_PORTS.keys()),
        "Service": list(GLUETUN_PUBLISHED_PORTS.values()),
    }
)
st.dataframe(port_frame, hide_index=True, width="stretch")

# ---------------------------------------------------------------------------
# Unexpected containers
# ---------------------------------------------------------------------------

unexpected = raw.get("unexpected") or []
if unexpected:
    st.markdown("### Unexpected containers")
    st.caption(
        "Running but not in the expected inventory. Add them to "
        "`EXPECTED_CONTAINERS` in config.py if they are intentional."
    )
    st.dataframe(
        pd.DataFrame(
            {
                "Name": [c.name for c in unexpected],
                "Image": [c.image for c in unexpected],
                "State": [c.state for c in unexpected],
                "Uptime": [human_duration(c.uptime_seconds) for c in unexpected],
            }
        ),
        hide_index=True,
        width="stretch",
    )

# ---------------------------------------------------------------------------
# Logs for unhealthy containers
# ---------------------------------------------------------------------------

problem_names = [
    row["Name"]
    for row in rows
    if not row["Status"].endswith("HEALTHY") and row["State"] != "—"
]
if problem_names:
    st.markdown("### Logs for containers needing attention")
    st.caption("Read-only. Logs are fetched on demand, never on every refresh.")
    chosen = st.selectbox("Container", problem_names, key="docker_log_container")
    if st.button("Fetch last 100 lines", icon=":material/description:"):
        logs = get_container_logs(chosen, lines=100)
        if logs:
            st.code("\n".join(logs), language="log")
        else:
            st.caption("No log output returned.")

# ---------------------------------------------------------------------------
# Engine versions
# ---------------------------------------------------------------------------

with st.expander("Docker engine and Compose versions"):
    versions = docker_versions()
    if not versions:
        st.caption("Version information unavailable.")
    else:
        for key, value in versions.items():
            st.markdown(f"- **{key}:** `{value}`")
        if "compose_v1" in versions:
            st.warning(
                "Legacy docker-compose v1 is installed. It is the source of the "
                "`KeyError: 'ContainerConfig'` failures recorded in the project "
                "README — prefer `docker compose` (v2) for any recreate.",
                icon=":material/warning:",
            )
    st.caption(
        ":gray[Container names on this host mix Compose v1 and v2 conventions "
        "(`media-vpn_sonarr_1` vs `media-vpn-sabnzbd-1`) because SABnzbd was "
        "recreated under v2. The dashboard matches both.]"
    )

read_only_notice()
