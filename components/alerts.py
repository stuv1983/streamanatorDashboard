"""Alert panel, incident cards and the recent-changes feed.

The alert panel is where the dashboard earns its keep. Each entry answers:
what happened, to what, when, what the value is, what the limit was, why it
probably happened, and what to check next. An alert without a next step is
just a colour.

Correlated incidents render as one card with the cause on top and its effects
nested underneath — three symptoms of one Gluetun failure should read as one
problem, not three.
"""

from __future__ import annotations

from typing import Sequence

import streamlit as st

from components.theme import style
from core.status import Alert, ChangeEvent, Status
from health.correlation import Incident
from utils.formatting import format_clock, format_timestamp, human_age


def alert_banner(alerts: Sequence[Alert]) -> None:
    """Single prominent line summarising the worst outstanding condition."""
    criticals = [a for a in alerts if a.status is Status.CRITICAL]
    warnings = [a for a in alerts if a.status is Status.WARNING]

    if criticals:
        titles = ", ".join(a.title for a in criticals[:3])
        extra = "" if len(criticals) <= 3 else f" (+{len(criticals) - 3} more)"
        st.error(f"**{len(criticals)} critical:** {titles}{extra}", icon=":material/error:")
    elif warnings:
        titles = ", ".join(a.title for a in warnings[:3])
        extra = "" if len(warnings) <= 3 else f" (+{len(warnings) - 3} more)"
        st.warning(
            f"**{len(warnings)} warning:** {titles}{extra}", icon=":material/warning:"
        )
    else:
        st.success(
            "No active warnings. All monitored components are within thresholds.",
            icon=":material/check_circle:",
        )


def alert_card(alert: Alert, nested: bool = False) -> None:
    """One alert, with its full reasoning."""
    entry = style(alert.status)
    with st.container(border=not nested):
        header, badge = st.columns([4, 1], vertical_alignment="center")
        with header:
            prefix = "↳ " if nested else ""
            st.markdown(f"{prefix}**{alert.title}**")
        with badge:
            st.badge(entry.label, icon=entry.icon, color=entry.badge_color)

        st.caption(alert.component)
        if alert.detail:
            st.markdown(alert.detail)

        facts: list[tuple[str, str]] = []
        if alert.current_value:
            facts.append(("Current", alert.current_value))
        if alert.threshold:
            facts.append(("Threshold", alert.threshold))
        if alert.since:
            facts.append(("Since", format_timestamp(alert.since)))
        if facts:
            columns = st.columns(len(facts))
            for column, (label, value) in zip(columns, facts):
                with column:
                    st.caption(label)
                    st.markdown(f"`{value}`")

        if alert.probable_cause:
            st.markdown(f"**Probable cause** — {alert.probable_cause}")
        if alert.recommended_action:
            st.markdown(f"**Next check** — {alert.recommended_action}")


def incident_card(incident: Incident) -> None:
    """A correlated incident: one cause, its explained effects."""
    entry = style(incident.status)
    with st.container(border=True):
        header, badge = st.columns([4, 1], vertical_alignment="center")
        with header:
            st.markdown(f"### {incident.title}")
        with badge:
            st.badge(entry.label, icon=entry.icon, color=entry.badge_color)

        st.markdown(f"**Primary cause:** {incident.cause.title}")
        if incident.cause.detail:
            st.markdown(incident.cause.detail)
        st.caption(incident.explanation)

        if incident.cause.recommended_action:
            st.markdown(f"**Next check** — {incident.cause.recommended_action}")

        with st.expander(f"{len(incident.effects)} downstream effect(s)"):
            for effect in incident.effects:
                st.markdown(
                    f"- {style(effect.status).icon} **{effect.title}** — {effect.component}"
                )


def alert_panel(
    alerts: Sequence[Alert],
    incidents: Sequence[Incident] = (),
    limit: int = 12,
    show_unknown: bool = True,
) -> None:
    """The Active Alerts panel, sorted CRITICAL → WARNING → UNKNOWN → INFO."""
    for incident in incidents:
        incident_card(incident)

    # Effects already shown inside their incident are not repeated here.
    standalone = [a for a in alerts if a.caused_by is None and not a.effects]
    if not show_unknown:
        standalone = [a for a in standalone if a.status is not Status.UNKNOWN]

    ordered = sorted(standalone, key=lambda a: a.status.rank, reverse=True)

    if not ordered and not incidents:
        st.success("Nothing requires attention.", icon=":material/check_circle:")
        return

    for alert in ordered[:limit]:
        alert_card(alert)

    if len(ordered) > limit:
        with st.expander(f"{len(ordered) - limit} more"):
            for alert in ordered[limit:]:
                alert_card(alert, nested=True)


def change_feed(changes: Sequence[ChangeEvent], limit: int = 15) -> None:
    """Recent Changes: what materially changed, not a log tail."""
    if not changes:
        st.caption(
            "No changes recorded yet. The feed fills as the dashboard observes "
            "image updates, WAN IP changes, restarts and completed backups."
        )
        return

    for event in list(changes)[:limit]:
        entry = style(event.status)
        with st.container(border=False):
            columns = st.columns([1, 6], vertical_alignment="top")
            with columns[0]:
                st.caption(format_clock(event.timestamp))
            with columns[1]:
                st.markdown(f"{entry.icon} **{event.summary}**")
                if event.detail:
                    st.caption(event.detail)
                st.caption(f":gray[{event.category} · {human_age(event.timestamp)}]")


def alerts_dataframe(alerts: Sequence[Alert]):
    """Table view of alerts, so nothing is reachable only through a card."""
    import pandas as pd

    if not alerts:
        return pd.DataFrame(
            columns=["Severity", "Alert", "Component", "Current", "Threshold"]
        )
    ordered = sorted(alerts, key=lambda a: a.status.rank, reverse=True)
    return pd.DataFrame(
        {
            "Severity": [a.status.value for a in ordered],
            "Alert": [a.title for a in ordered],
            "Component": [a.component for a in ordered],
            "Current": [a.current_value or "—" for a in ordered],
            "Threshold": [a.threshold or "—" for a in ordered],
        }
    )
