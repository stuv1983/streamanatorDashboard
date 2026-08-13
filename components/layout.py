"""Shared page chrome: header, refresh controls, tables and Grafana links."""

from __future__ import annotations

from typing import Sequence

import pandas as pd
import streamlit as st

from components.theme import style
from config import REFRESH_CHOICES, TIME_RANGES, get_settings
from core.status import Reading, Status
from health.scoring import HealthScore
from utils.formatting import format_clock, human_duration


def page_header(
    title: str, subtitle: str = "", collected_at: float | None = None
) -> None:
    """Consistent page title row with the collection timestamp."""
    left, right = st.columns([3, 1], vertical_alignment="bottom")
    with left:
        st.markdown(f"## {title}")
        if subtitle:
            st.caption(subtitle)
    with right:
        if collected_at:
            st.caption(f"Collected {format_clock(collected_at)}")


def health_header(health: HealthScore, collected_at: float, duration: float) -> None:
    """The NOC banner: hostname, score, status and freshness.

    Score and status are shown side by side deliberately. The number says how
    much is affected; the label says how bad the worst thing is. A CRITICAL
    label beside a score in the 80s is the intended, honest combination.
    """
    settings = get_settings()
    entry = style(health.status)

    with st.container(border=True):
        name_col, score_col, status_col, time_col = st.columns(
            [3, 1.4, 1.6, 2], vertical_alignment="center"
        )
        with name_col:
            st.markdown(f"### {settings.host.hostname.upper()}")
            st.caption(f"{settings.host.address} · {settings.host.vlan}")
        with score_col:
            st.metric("Health score", f"{health.score:.0f} / 100")
        with status_col:
            st.caption("STATUS")
            st.markdown(f"{entry.icon} :{entry.color_token}[**{health.label}**]")
        with time_col:
            st.caption("LAST REFRESHED")
            st.markdown(f"**{format_clock(collected_at)}**")
            st.caption(f":gray[collected in {duration * 1000:.0f} ms]")

        if health.status is not Status.HEALTHY:
            st.caption(f":gray[Reason: {health.reason}]")


def refresh_controls(location=None) -> int:
    """Auto-refresh selector plus a manual refresh button.

    Returns the chosen interval in seconds (0 = off). The interval drives an
    `st.fragment(run_every=...)`, so refreshing re-runs only the live panels
    rather than the whole script.
    """
    container = location or st.sidebar
    with container:
        st.caption("REFRESH")
        labels = [label for label, _ in REFRESH_CHOICES]
        values = {label: seconds for label, seconds in REFRESH_CHOICES}
        current = st.session_state.get("refresh_seconds", 30)
        default_label = next(
            (label for label, seconds in REFRESH_CHOICES if seconds == current),
            "30 sec",
        )
        chosen = st.segmented_control(
            "Auto refresh",
            labels,
            default=default_label,
            key="refresh_choice",
            label_visibility="collapsed",
        )
        seconds = values.get(chosen or default_label, 30)
        st.session_state["refresh_seconds"] = seconds

        if st.button(
            "Refresh now", icon=":material/refresh:", width="stretch", key="manual_refresh"
        ):
            from core.runtime import clear_caches

            clear_caches()
            st.rerun()

        if seconds:
            st.caption(f":gray[Auto-refreshing every {human_duration(seconds)}]")
        else:
            st.caption(":gray[Auto refresh off]")
    return seconds


def time_range_selector(key: str = "time_range", location=None) -> tuple[str, int]:
    """Trend window selector. Returns (label, seconds)."""
    container = location or st.sidebar
    with container:
        st.caption("TREND WINDOW")
        labels = [label for label, _ in TIME_RANGES]
        mapping = dict(TIME_RANGES)
        current = st.session_state.get(key, "24h")
        chosen = st.selectbox(
            "Time range",
            labels,
            index=labels.index(current) if current in labels else 2,
            key=f"{key}_select",
            label_visibility="collapsed",
        )
        st.session_state[key] = chosen
    return chosen, mapping[chosen]


def grafana_link(dashboard_path: str, label: str = "Open in Grafana") -> None:
    """Deep link into Grafana for detailed investigation.

    Rendered only when GRAFANA_URL is set. The intended workflow is: spot it
    here, investigate there.
    """
    settings = get_settings()
    if not settings.grafana.configured:
        return
    url = f"{settings.grafana.url.rstrip('/')}{dashboard_path}"
    st.link_button(label, url, icon=":material/open_in_new:")


def health_table(readings: Sequence[Reading], caption: str = "") -> None:
    """Sorted status table — problems first, then everything else.

    A table view exists alongside every card grid so values are never
    reachable only by hovering or scanning colour.
    """
    if not readings:
        st.caption("Nothing to display.")
        return

    ordered = sorted(readings, key=lambda r: (r.status.rank, r.label), reverse=True)
    frame = pd.DataFrame(
        {
            "Status": [f"{style(r.status).icon} {r.status.value}" for r in ordered],
            "Component": [r.label for r in ordered],
            "Value": [r.display_value for r in ordered],
            "Detail": [r.detail for r in ordered],
            "Threshold": [r.threshold or "—" for r in ordered],
            "Source": [r.source or "—" for r in ordered],
        }
    )
    st.dataframe(
        frame,
        hide_index=True,
        width="stretch",
        column_config={
            "Status": st.column_config.TextColumn(width="small"),
            "Detail": st.column_config.TextColumn(width="large"),
        },
    )
    if caption:
        st.caption(caption)


def source_footer(sources: dict[str, str]) -> None:
    """Show which source answered for each data area."""
    with st.expander("Data sources for this view"):
        frame = pd.DataFrame(
            {"Area": list(sources.keys()), "Source": list(sources.values())}
        )
        st.dataframe(frame, hide_index=True, width="stretch")
        st.caption(
            "Prometheus is preferred wherever it is deployed. Areas showing a "
            "`local:` source are being read directly from the host because the "
            "corresponding exporter is not running."
        )


def read_only_notice() -> None:
    """State the tool's contract plainly.

    Reworded when the admin console was added. The old text promised the
    dashboard never changes anything, which stopped being true — and a
    reassurance that is no longer accurate is worse than none, because it is
    the sentence someone quotes when working out what could have restarted a
    service at 3am.
    """
    st.caption(
        ":gray[Monitoring pages are read-only — they observe and explain, and "
        "never change the system. Control actions live in the Admin section, "
        "require sign-in, and are written to the audit log.]"
    )


def empty_state(message: str, icon: str = ":material/info:") -> None:
    st.info(message, icon=icon)
