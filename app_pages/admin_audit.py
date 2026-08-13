"""The audit log: who did what, when, and whether it worked.

Break-glass events are pulled out and shown first regardless of the filter.
They are the entries most likely to matter and least likely to be looked for.
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

from components.admin_ui import require_admin, session_bar
from components.layout import page_header
from config import get_settings
from core.runtime import audit_log

current = require_admin("Audit log")
settings = get_settings()
audit = audit_log()

page_header("Audit log", "Every privileged action, recorded")
session_bar(current)
st.divider()

entries = audit.read(limit=1000)

if not entries:
    st.info(
        "No entries yet. Sign-ins, credential changes and actions all appear here.",
        icon=":material/history:",
    )
    st.stop()

# ---------------------------------------------------------------------------
# Break-glass first
# ---------------------------------------------------------------------------

emergencies = [e for e in entries if e.breakglass]
if emergencies:
    st.error(
        f"**{len(emergencies)} break-glass event(s) recorded.** "
        f"Most recent: {emergencies[0].when} by `{emergencies[0].actor}`.",
        icon=":material/e911_emergency:",
    )
    with st.expander("Show break-glass events", expanded=len(emergencies) <= 5):
        st.dataframe(
            pd.DataFrame(
                [
                    {
                        "When": e.when,
                        "Actor": e.actor,
                        "Action": e.action,
                        "Outcome": e.outcome,
                        "Target": e.target,
                        "Detail": e.detail,
                    }
                    for e in emergencies
                ]
            ),
            width="stretch",
            hide_index=True,
        )

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

failures = [e for e in entries if e.outcome in {"failure", "blocked"}]
signin_failures = [e for e in failures if e.action == "auth.signin"]

columns = st.columns(4)
with columns[0]:
    st.metric("Entries", len(entries), border=True)
with columns[1]:
    st.metric("Failures", len(failures), border=True)
with columns[2]:
    st.metric(
        "Failed sign-ins",
        len(signin_failures),
        border=True,
        help="A run of these on an account you do not recognise is worth a look.",
    )
with columns[3]:
    st.metric("Break-glass", len(emergencies), border=True)

st.divider()

# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------

filters = st.columns([2, 1, 1])
with filters[0]:
    action_names = sorted({e.action for e in entries})
    chosen = st.multiselect("Action", action_names, default=[])
with filters[1]:
    severity = st.selectbox(
        "Minimum severity", ["info", "notice", "warning", "critical"], index=0
    )
with filters[2]:
    outcome = st.selectbox("Outcome", ["all", "success", "failure", "blocked", "started"])

order = {"info": 0, "notice": 1, "warning": 2, "critical": 3}
visible = [
    e
    for e in entries
    if (not chosen or e.action in chosen)
    and order.get(e.severity, 0) >= order[severity]
    and (outcome == "all" or e.outcome == outcome)
]

st.caption(f"Showing {len(visible)} of {len(entries)} entries, newest first.")

frame = pd.DataFrame(
    [
        {
            "When": e.when,
            "Severity": e.severity,
            "Actor": e.actor,
            "Role": e.role,
            "Action": e.action,
            "Outcome": e.outcome,
            "Target": e.target,
            "Detail": e.detail,
            "BG": "yes" if e.breakglass else "",
        }
        for e in visible
    ]
)

st.dataframe(
    frame,
    width="stretch",
    hide_index=True,
    column_config={
        "Detail": st.column_config.TextColumn(width="large"),
        "BG": st.column_config.TextColumn("Break-glass", width="small"),
    },
)

st.divider()

with st.expander("What is recorded, and what is not"):
    st.markdown(
        f"""
Entries are written to `{settings.auth.audit_path}` as one JSON object per
line at mode `0600`, and mirrored to the application log so they also reach
journald — two copies matter, because a file inside the project directory is
the one thing an attacker holding the service account could trim.

**Secret values are never recorded.** Setting a credential writes the key
name, its length, and an eight-character fingerprint — enough to answer "is
this the same key I set last week?" and nothing more. The writer also scans
every detail string for credential-shaped text and redacts it before the line
reaches disk, rather than trusting each caller to remember.

`action.start` and `action.finish` are written as a pair, so an action that
hung or took the server down with it still leaves a record that it began.
"""
    )
