"""Streamanator Dashboard — entry point.

A single-screen NOC console for the `streamanator` home server. It answers one
question quickly: is everything healthy, what changed, and what needs
attention?

The monitoring pages are read-only: they observe and explain, and never change
the system. Control lives in a separate, authenticated Admin section — sign-in
required, allowlisted commands only, every action written to an audit log.

Run with:
    streamlit run app.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# The package directory must be importable before the local modules load, so
# pages can use absolute imports (`from services import ...`) regardless of the
# working directory Streamlit was launched from.
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import streamlit as st  # noqa: E402

from auth import session as auth_session  # noqa: E402
from components.layout import (  # noqa: E402
    grafana_url,
    refresh_controls,
    time_range_selector,
)
from config import get_settings  # noqa: E402
from core.runtime import (  # noqa: E402
    init_session_state,
    notification_worker,
    sampler,
    settings,
)

st.set_page_config(
    page_title="Streamanator Dashboard",
    page_icon=":material/monitor_heart:",
    layout="wide",
    initial_sidebar_state="expanded",
)

# Initialise settings/logging and start the background history sampler before
# anything renders, so deltas and forecasts keep accruing whether or not a
# browser tab is open.
settings()
init_session_state()
sampler()
notification_worker()

config = get_settings()

signed_in = auth_session.is_authenticated()

# The admin group is built rather than merely disabled when signed out. A page
# registered with st.navigation is reachable by URL whether or not it is drawn
# in the sidebar, so hiding it in the menu would not be a control — each admin
# page also calls require_admin(), which stops the script before any privileged
# widget is created. Two independent gates, because either one alone is a
# single point of failure.
pages = {
    "": [
        st.Page(
            "app_pages/overview.py",
            title="Overview",
            icon=":material/dashboard:",
            default=True,
        ),
    ],
    "Infrastructure": [
        st.Page("app_pages/network.py", title="Network", icon=":material/lan:"),
        st.Page("app_pages/server.py", title="Server", icon=":material/dns:"),
        st.Page("app_pages/storage.py", title="Storage", icon=":material/hard_drive:"),
        st.Page("app_pages/raid.py", title="RAID & disks", icon=":material/storage:"),
    ],
    "Services": [
        st.Page("app_pages/docker.py", title="Docker", icon=":material/deployed_code:"),
        st.Page("app_pages/vpn.py", title="VPN", icon=":material/vpn_lock:"),
        st.Page("app_pages/media.py", title="Media", icon=":material/movie:"),
        st.Page(
            "app_pages/applications.py", title="Applications", icon=":material/apps:"
        ),
    ],
    "Operations": [
        st.Page("app_pages/backups.py", title="Backups", icon=":material/backup:"),
        st.Page("app_pages/security.py", title="Security", icon=":material/shield:"),
        st.Page(
            "app_pages/diagnostics.py",
            title="Diagnostics",
            icon=":material/troubleshoot:",
        ),
    ],
}

if signed_in:
    pages["Admin"] = [
        st.Page(
            "app_pages/admin_actions.py",
            title="Admin jobs",
            icon=":material/play_circle:",
        ),
        st.Page(
            "app_pages/admin_updates.py",
            title="Updates",
            icon=":material/system_update_alt:",
        ),
        st.Page("app_pages/admin_keys.py", title="API keys", icon=":material/key:"),
        st.Page(
            "app_pages/admin_notifications.py",
            title="Email reports",
            icon=":material/mail:",
        ),
        st.Page(
            "app_pages/admin_smart.py",
            title="Disk health setup",
            icon=":material/monitor_heart:",
        ),
        st.Page(
            "app_pages/admin_probes.py",
            title="Service probes",
            icon=":material/network_ping:",
        ),
        st.Page(
            "app_pages/admin_accounts.py",
            title="Accounts",
            icon=":material/manage_accounts:",
        ),
        st.Page(
            "app_pages/admin_audit.py", title="Audit log", icon=":material/history:"
        ),
        st.Page(
            "app_pages/admin_signin.py", title="Session", icon=":material/logout:"
        ),
    ]
else:
    pages["Admin"] = [
        st.Page(
            "app_pages/admin_signin.py", title="Sign in", icon=":material/lock:"
        ),
    ]

if config.auth.require_auth_for_all and not signed_in:
    # Everything collapses to the sign-in page. Registering the monitoring
    # pages and relying on the sidebar to hide them would not be a control —
    # a registered page is reachable by URL regardless of what is drawn.
    pages = {
        "Admin": [
            st.Page(
                "app_pages/admin_signin.py", title="Sign in", icon=":material/lock:"
            )
        ]
    }

page = st.navigation(pages, position="sidebar")

with st.sidebar:
    st.markdown(f"### {config.host.hostname}")
    st.caption(f"{config.host.address} · {config.host.vlan}")
    st.divider()

refresh_controls()
time_range_selector()

with st.sidebar:
    st.divider()
    if signed_in:
        current_session = auth_session.current_session()
        if current_session is not None:
            icon = (
                ":material/e911_emergency:"
                if current_session.breakglass
                else ":material/badge:"
            )
            minutes = current_session.seconds_remaining() // 60
            st.caption(
                f"{icon} Signed in as **{current_session.username}** · "
                f"{minutes}m left"
            )
    else:
        st.caption(
            ":gray[Read-only monitoring. Sign in under Admin for configuration "
            "and control actions.]"
        )
    sidebar_grafana_url = grafana_url()
    if sidebar_grafana_url:
        st.link_button(
            "Grafana",
            sidebar_grafana_url,
            icon=":material/open_in_new:",
            width="stretch",
        )

# A pending reboot and any use of break-glass are surfaced on every page, not
# only in the admin section — they are facts about the whole system, and the
# person who needs to see them is often not the one who caused them. The
# banner reads from the audit log, so it appears in every tab and for every
# viewer, not just the session that performed the emergency login.
from core.runtime import audit_log as _audit_log  # noqa: E402

auth_session.render_breakglass_banner(
    _audit_log(), auth_session.current_session()
)

page.run()
