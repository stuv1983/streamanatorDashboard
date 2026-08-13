"""Admin jobs: server reboot, service restarts, container restarts, stack deploys.

Every button here maps to a fixed command declared in `admin/actions.py`.
Nothing on this page assembles a command from what you type — the only free
text is a confirmation phrase, and the only variable is a container name
chosen from a list that comes out of configuration.

Each action is probed against the live system before it is offered, so an
action that cannot run says why and shows the command to paste into SSH
instead of failing at the moment you press it.
"""

from __future__ import annotations

import streamlit as st

from admin import actions as registry
from admin.runner import (
    actions_enabled,
    capability_summary,
    check_action,
    pending_shutdown,
    sudo_available,
)
from components.admin_ui import (
    confirm_and_run,
    require_admin,
    risk_badge,
    session_bar,
)
from components.layout import page_header

current = require_admin("Admin jobs")

page_header("Admin jobs", "Allowlisted privileged actions on streamanator")
session_bar(current)
st.divider()

# ---------------------------------------------------------------------------
# Standing state: a pending reboot outranks everything else on this page
# ---------------------------------------------------------------------------

scheduled, when = pending_shutdown()
if scheduled:
    st.error(when, icon=":material/schedule:")
    cancel = registry.find("server.cancel_shutdown")
    if cancel is not None:
        with st.container(border=True):
            st.markdown("### Cancel it")
            confirm_and_run(cancel, current, key_suffix="_banner")
    st.divider()

# ---------------------------------------------------------------------------
# Capability overview
# ---------------------------------------------------------------------------

if not actions_enabled():
    st.warning(
        "Control actions are disabled (`ADMIN_ACTIONS_ENABLED=false`). Every "
        "action below shows its command so you can run it over SSH.",
        icon=":material/pause_circle:",
    )

tally = capability_summary()
ready, ssh, blocked = tally["ready"], tally["ssh"], tally["blocked"]

columns = st.columns(3)
with columns[0]:
    st.metric("Runnable here", ready, border=True)
with columns[1]:
    st.metric("Need SSH", ssh, border=True)
with columns[2]:
    st.metric("Unavailable", blocked, border=True)

if ssh and sudo_available():
    st.info(
        f"{ssh} action(s) need a sudo password, which this dashboard does not "
        "have and should not hold. Install the sudoers drop-in to make them "
        "run directly, or use the SSH command each one shows.",
        icon=":material/terminal:",
    )
    with st.expander("Install the sudoers drop-in"):
        st.markdown(
            "This grants the dashboard account passwordless sudo for exactly "
            "the commands listed below — no wildcards, no scripts under "
            "`/home`, nothing that can be widened by argument."
        )
        st.code(
            "cd /home/arm/projects/streamanator_dashboard\n"
            "sudo install -m 0440 -o root -g root \\\n"
            "    deploy/sudoers-streamanator-admin \\\n"
            "    /etc/sudoers.d/streamanator-dashboard-admin\n"
            "sudo visudo -c   # must report 'parsed OK' before you log out",
            language="bash",
        )
        st.markdown("**Commands this grants:**")
        st.code("\n".join(registry.grantable_sudo_rules()), language="text")
        st.caption(
            "Keep a second root shell open until `visudo -c` passes. A "
            "malformed file in `/etc/sudoers.d` disables sudo for everyone."
        )

st.divider()

# ---------------------------------------------------------------------------
# Actions by group
# ---------------------------------------------------------------------------

groups = registry.by_group()
tabs = st.tabs(list(groups.keys()))

for tab, (group_name, group_actions) in zip(tabs, groups.items()):
    with tab:
        for action in group_actions:
            # The cancel action is already offered in the banner when a
            # shutdown is pending; showing it twice invites a double-click on
            # the wrong one.
            if scheduled and action.key == "server.cancel_shutdown":
                continue

            with st.container(border=True):
                header, badge = st.columns([4, 1], vertical_alignment="center")
                with header:
                    st.markdown(f"#### {action.label}")
                    st.caption(f"`{action.summary}`")
                with badge:
                    risk_badge(action.risk)

                if action.parameter is not None:
                    choices = action.parameter.choices()
                    if not choices:
                        st.info(
                            "No eligible targets are configured.",
                            icon=":material/info:",
                        )
                        continue
                    selected = st.selectbox(
                        action.parameter.label.title(),
                        choices,
                        key=f"param_{action.key}",
                        help=action.parameter.help,
                    )
                    confirm_and_run(
                        action, current, parameter_value=selected,
                        key_suffix=f"_{selected}",
                    )
                else:
                    confirm_and_run(action, current)

                if action.undo_key:
                    undo = registry.find(action.undo_key)
                    if undo is not None:
                        st.caption(
                            f":gray[Reversible with **{undo.label}** "
                            f"(`{undo.summary}`).]"
                        )

st.divider()

with st.expander("What is deliberately not here"):
    st.markdown(
        """
There is no button to remove a disk, fail a RAID member, delete a backup, or
run an arbitrary command. Those were excluded from the registry rather than
hidden from the page — there is no code path to them.

The reasoning differs by case:

- **Array operations** are rare, irreversible, and need the full context of
  `mdadm --detail` in front of you. A button is the wrong interface.
- **Backup deletion** has no safe undo, and the failure mode is silent: you
  find out at restore time.
- **Arbitrary commands** would make this a remote shell with a web front end.
  If that is what is needed, SSH already exists and is better at it.

Installing the SMART sudoers rule is also permanently SSH-only. It reads a
file from the project directory, which the dashboard account can write — so
granting the dashboard permission to install it would be a one-step path from
this account to root.
"""
    )
