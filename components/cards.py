"""Status and metric cards.

Built from native Streamlit elements (`st.container(border=True)`,
`st.metric`, `st.badge`) rather than custom HTML, so they inherit the theme,
stack correctly on narrow screens and stay consistent as Streamlit evolves.

Every card follows the same information order the spec asks for:

    current state → delta → trend → threshold → what it means
"""

from __future__ import annotations

from typing import Sequence

import streamlit as st

from components.theme import status_markdown, style
from core.status import DataState, Reading, Status
from utils.formatting import format_delta


def status_pill(status: Status, text: str = "") -> None:
    """Inline status badge with icon and label."""
    entry = style(status)
    label = text or entry.label
    st.badge(label, icon=entry.icon, color=entry.badge_color)


def status_card(
    label: str,
    status: Status,
    value: str,
    detail: str = "",
    threshold: str = "",
    source: str = "",
    age_seconds: float | None = None,
    help_text: str = "",
) -> None:
    """The dashboard's primary building block.

    Shows the state, the value, why the state is what it is, and where the
    number came from — the four things needed to decide whether to act.
    """
    entry = style(status)
    with st.container(border=True):
        header, badge = st.columns([3, 1], vertical_alignment="center")
        with header:
            st.markdown(f"**{label}**", help=help_text or entry.tooltip)
        with badge:
            st.badge(entry.label, icon=entry.icon, color=entry.badge_color)

        st.markdown(f"### {value}")
        if detail:
            st.caption(detail)
        if threshold:
            st.caption(f":gray[Threshold: {threshold}]")

        footer = _provenance(source, age_seconds)
        if footer:
            st.caption(f":gray[{footer}]")


def reading_card(reading: Reading, help_text: str = "") -> None:
    """Render a `Reading` as a status card, honouring its data state."""
    status_card(
        label=reading.label,
        status=reading.status,
        value=reading.display_value,
        detail=reading.detail,
        threshold=reading.threshold,
        source=reading.source,
        age_seconds=reading.age_seconds if reading.state is not DataState.NOT_CONFIGURED else None,
        help_text=help_text,
    )


def metric_card(
    label: str,
    value: str,
    delta: str | None = None,
    help_text: str = "",
    chart_data: Sequence[float] | None = None,
    chart_type: str = "line",
    delta_color: str = "normal",
) -> None:
    """Compact KPI tile, optionally with a sparkline."""
    st.metric(
        label,
        value,
        delta,
        help=help_text or None,
        border=True,
        chart_data=list(chart_data) if chart_data else None,
        chart_type=chart_type if chart_data else None,
        delta_color=delta_color,
    )


def summary_tile(label: str, status: Status, value: str, help_text: str = "") -> None:
    """One tile in the top status strip: INTERNET | RAID | STORAGE | …"""
    entry = style(status)
    with st.container(border=True):
        st.caption(label.upper())
        st.markdown(status_markdown(status, f"**{value}**"), help=help_text or entry.tooltip)


def counter_card(
    label: str,
    status: Status,
    value: str,
    subtitle: str = "",
    help_text: str = "",
) -> None:
    """Small card for counts (containers running, alerts open, streams)."""
    with st.container(border=True):
        st.caption(label)
        st.markdown(status_markdown(status, f"**{value}**"), help=help_text)
        if subtitle:
            st.caption(f":gray[{subtitle}]")


def delta_card(
    label: str,
    status: Status,
    current: str,
    deltas: dict[str, float | None],
    detail: str = "",
    threshold: str = "",
    source: str = "",
) -> None:
    """A card whose point is the *movement*, not the absolute value.

    This is the shape the CRC panel needs: a large historical count is not a
    fault, a rising one is. Missing deltas render as an em dash so "not yet
    comparable" never looks like "+0".
    """
    entry = style(status)
    with st.container(border=True):
        header, badge = st.columns([3, 1], vertical_alignment="center")
        with header:
            st.markdown(f"**{label}**")
        with badge:
            st.badge(entry.label, icon=entry.icon, color=entry.badge_color)

        st.markdown(f"### {current}")

        columns = st.columns(len(deltas)) if deltas else []
        for column, (window, value) in zip(columns, deltas.items()):
            with column:
                st.caption(window)
                if value is None:
                    st.markdown(":gray[—]", help="No baseline sample that old yet.")
                elif value > 0:
                    st.markdown(f":orange[{format_delta(value)}]")
                else:
                    st.markdown(f":green[{format_delta(value)}]")

        if detail:
            st.caption(detail)
        if threshold:
            st.caption(f":gray[Threshold: {threshold}]")
        footer = _provenance(source, None)
        if footer:
            st.caption(f":gray[{footer}]")


def not_configured_card(
    label: str, detail: str, steps: Sequence[str] = (), source: str = ""
) -> None:
    """Explicit NOT CONFIGURED panel with the work required to fix it.

    A missing integration is a gap in observation, not a fault — but it should
    still be actionable rather than a blank space.
    """
    with st.container(border=True):
        header, badge = st.columns([3, 1], vertical_alignment="center")
        with header:
            st.markdown(f"**{label}**")
        with badge:
            st.badge("Not configured", icon=":material/settings:", color="gray")
        st.caption(detail)
        if steps:
            with st.expander("Integration steps"):
                for index, step in enumerate(steps, start=1):
                    st.markdown(f"{index}. {step}")
        if source:
            st.caption(f":gray[Source: {source}]")


def freshness_caption(source: str, age_seconds: float | None, budget: float) -> None:
    """Footer line stating where data came from and how current it is."""
    text = _provenance(source, age_seconds)
    if age_seconds is not None and age_seconds > budget:
        st.caption(f":red[{text} — DATA STALE]")
    else:
        st.caption(f":gray[{text}]")


def _provenance(source: str, age_seconds: float | None) -> str:
    parts: list[str] = []
    if source:
        parts.append(f"Source: {source}")
    if age_seconds is not None:
        parts.append(f"updated {_age(age_seconds)}")
    return " · ".join(parts)


def _age(age_seconds: float) -> str:
    if age_seconds < 45:
        return "just now"
    if age_seconds < 3600:
        return f"{age_seconds / 60:.0f}m ago"
    if age_seconds < 86400:
        return f"{age_seconds / 3600:.0f}h ago"
    return f"{age_seconds / 86400:.0f}d ago"


def readings_grid(readings: Sequence[Reading], columns: int = 3) -> None:
    """Lay out readings in a responsive grid, worst first.

    Sorting by severity is what makes the page scannable: whatever needs
    attention is always at the top-left, regardless of how many panels there
    are below it.
    """
    ordered = sorted(readings, key=lambda r: r.status.rank, reverse=True)
    for index in range(0, len(ordered), columns):
        row = ordered[index : index + columns]
        for column, reading in zip(st.columns(len(row)), row):
            with column:
                reading_card(reading)
