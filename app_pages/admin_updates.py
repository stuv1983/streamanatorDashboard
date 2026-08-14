"""Updates — what the host and its containers are behind on, and the buttons.

Two halves, in this order deliberately: what is true first, what you can do
about it second. The status half needs no privilege at all and is honest about
the difference between "current" and "could not tell" — a registry that could
not be reached renders as UNKNOWN, never as up to date, because the wrong
answer there is the one that stops anyone looking.

The action half reuses the same allowlisted-action machinery as every other
admin page: a fixed argv from `admin/actions.py`, a capability probe first, a
step-up, and an audit record either way.

The Ubuntu upgrade is the one action here that does not run inline. It starts a
systemd unit and returns immediately — an apt upgrade outlives any request it
would be sane to hold open, and the runner reports a timed-out command as
"outcome UNKNOWN", which for dpkg is the worst answer available. Progress is
polled from systemd below instead.
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

from admin import actions as registry
from admin.actions import APT_UPGRADE_UNIT
from admin.runner import unit_log, unit_status
from components.admin_ui import confirm_and_run, require_admin, session_bar
from components.layout import page_header
from config import get_settings
from services.updates import apt_status, container_update_report
from utils.formatting import format_timestamp, human_age

current = require_admin("Updates")
settings = get_settings()

page_header("Updates", "Host packages and container images on streamanator")
session_bar(current)

if st.button("Re-check now", icon=":material/refresh:"):
    # Only the two collectors this page owns. The registry digests keep their
    # own six-hour cache: re-querying eleven manifests on every click is how
    # an anonymous Docker Hub allowance gets spent by lunchtime.
    apt_status.cache_clear()
    container_update_report.cache_clear()
    st.rerun()

st.divider()

# ---------------------------------------------------------------------------
# Ubuntu
# ---------------------------------------------------------------------------

st.markdown("## Ubuntu")

apt = apt_status()

if not apt.available:
    st.warning(apt.reason, icon=":material/help:")
else:
    if apt.reboot_required:
        st.error(
            "A reboot is required to finish applying updates already installed"
            + (
                f" — requested by {', '.join(apt.reboot_packages[:4])}"
                if apt.reboot_packages
                else ""
            )
            + ". Until then the old kernel or library is still the one running.",
            icon=":material/restart_alt:",
        )

    columns = st.columns(4)
    with columns[0]:
        st.metric(
            "Updates pending",
            apt.upgradable if apt.upgradable is not None else "—",
            border=True,
        )
    with columns[1]:
        st.metric(
            "Security updates",
            apt.security if apt.security is not None else "—",
            border=True,
            help="Packages from an archive whose name ends in -security.",
        )
    with columns[2]:
        st.metric(
            "Last upgrade",
            human_age(apt.last_upgrade) if apt.last_upgrade else "never",
            border=True,
            help=(
                f"{format_timestamp(apt.last_upgrade)} · "
                f"{apt.last_upgrade_packages} package(s) · "
                f"`{apt.last_upgrade_command}`"
                if apt.last_upgrade
                else "No completed transaction found in apt's history log."
            ),
        )
    with columns[3]:
        st.metric(
            "Package lists",
            human_age(apt.last_list_refresh) if apt.last_list_refresh else "unknown",
            border=True,
            help=(
                "How long since apt last refreshed its lists. The pending "
                "count is only as current as this."
            ),
        )

    if apt.lists_are_stale:
        st.info(
            "The package lists have not been refreshed for over two days, so "
            "the count above may be understated. Installing updates refreshes "
            "them first; Ubuntu's own `apt-daily.timer` normally does it daily.",
            icon=":material/update_disabled:",
        )

    if apt.unattended_enabled is False:
        st.caption(
            ":gray[`unattended-upgrades` is not enabled, so nothing installs "
            "security updates on its own.]"
        )
    elif apt.unattended_enabled:
        st.caption(
            ":gray[`unattended-upgrades` is enabled — security updates may "
            "install themselves between visits to this page.]"
        )

    if apt.packages:
        with st.expander(f"The {len(apt.packages)} packages waiting"):
            if apt.security_packages:
                st.markdown(
                    "**Security:** " + ", ".join(f"`{p}`" for p in apt.security_packages)
                )
            other = [p for p in apt.packages if p not in set(apt.security_packages)]
            if other:
                st.markdown("**Other:** " + ", ".join(f"`{p}`" for p in other))

# -- The upgrade action, and the unit it starts -----------------------------

upgrade = registry.find("server.apt_upgrade")
status = unit_status(APT_UPGRADE_UNIT)

if status.known and status.running:
    st.info(
        f"An upgrade is running now (started {human_age(status.started_at)}). "
        "It will finish whether or not this page stays open.",
        icon=":material/hourglass_top:",
    )
elif status.known and status.finished_at:
    if status.succeeded:
        st.success(
            f"The last upgrade run finished {human_age(status.finished_at)} and "
            "reported success.",
            icon=":material/check_circle:",
        )
    else:
        st.error(
            f"The last upgrade run finished {human_age(status.finished_at)} with "
            f"result `{status.result}`. Check the log below before retrying.",
            icon=":material/error:",
        )

if upgrade is not None:
    with st.container(border=True):
        st.markdown(f"#### {upgrade.label}")
        st.caption(f"`{upgrade.summary}`")
        if status.known and status.running:
            st.caption(
                ":gray[Already running — starting it again would do nothing "
                "until this run finishes.]"
            )
        confirm_and_run(upgrade, current)

if status.known:
    lines = unit_log(APT_UPGRADE_UNIT)
    with st.expander("Upgrade log", expanded=status.running):
        if lines:
            st.code("\n".join(lines), language="text")
        else:
            st.caption(
                "The journal is not readable by the dashboard account. Read it "
                "over SSH:"
            )
        st.code(f"journalctl -u {APT_UPGRADE_UNIT} -n 200 --no-pager", language="bash")
elif upgrade is not None:
    st.caption(
        f":gray[The `{APT_UPGRADE_UNIT}` unit is not installed. See "
        "`deploy/streamanator-apt-upgrade.service` for the two commands that "
        "install it.]"
    )

st.divider()

# ---------------------------------------------------------------------------
# Containers
# ---------------------------------------------------------------------------

st.markdown("## Containers")

report = container_update_report()

if report.error:
    st.error(
        f"Docker could not be queried, so no image can be checked: {report.error}",
        icon=":material/error:",
    )
elif not report.images:
    st.warning(
        "None of the expected containers exist, so there is nothing to check.",
        icon=":material/help:",
    )
else:
    outdated, unknown = report.outdated, report.unknown
    current_count = len([i for i in report.images if i.state == "current"])

    columns = st.columns(3)
    with columns[0]:
        st.metric("Updates available", len(outdated), border=True)
    with columns[1]:
        st.metric("Up to date", current_count, border=True)
    with columns[2]:
        st.metric(
            "Could not tell",
            len(unknown),
            border=True,
            help=(
                "Not the same as up to date. A registry that could not be "
                "reached, an image with no repository digest, or a rate limit."
            ),
        )

    if unknown and not settings.updates.check_registry:
        st.info(
            "Registry checks are switched off (`UPDATES_CHECK_REGISTRY=false`), "
            "so nothing below can report an available update.",
            icon=":material/cloud_off:",
        )

    _LABEL = {
        "outdated": "Update available",
        "current": "Up to date",
        "pinned": "Digest-pinned",
        "unknown": "Unknown",
    }
    rows = [
        {
            "Container": image.display,
            "Stack": image.stack,
            "Image": image.reference,
            "Status": _LABEL.get(image.state, image.state),
            "Last updated": human_age(image.container_created)
            if image.container_created
            else "—",
            "Image built": format_timestamp(image.image_created, "%d %b %Y")
            if image.image_created
            else "—",
            "Note": image.detail,
        }
        # Anything actionable or unexplained sorts above the things that are
        # fine — the question this table answers is "which one needs me?".
        for image in sorted(
            report.images,
            key=lambda i: ({"outdated": 0, "unknown": 1, "pinned": 2, "current": 3}
                           .get(i.state, 4), i.display),
        )
    ]
    st.dataframe(
        pd.DataFrame(rows), width="stretch", hide_index=True
    )
    st.caption(
        f":gray[Checked {human_age(report.checked_at)}. "
        "“Last updated” is when the container was last recreated, which is when "
        "an image change actually took effect — not when it was last "
        "restarted.]"
    )

# -- Stack update actions ---------------------------------------------------

st.markdown("### Update a stack")
st.caption(
    "Pulls new images and recreates only the containers whose image changed. "
    "Containers already on the current image are left running."
)

stack_actions = {
    action.key.rsplit(".", 1)[-1]: action for action in registry.stack_actions()
}

for stack in settings.stacks:
    with st.container(border=True):
        st.markdown(f"#### {stack.display}")
        action = stack_actions.get(stack.key)
        if action is None:
            discovered = report.discovered_stack_dirs.get(stack.key, "")
            st.warning(
                f"`{stack.env_var}` is not set, so this stack cannot be "
                "updated from here.",
                icon=":material/settings:",
            )
            if discovered:
                st.caption(
                    "Compose recorded this project as coming from the "
                    "directory below. Add the line to `.env` and reload "
                    "settings, or run the command over SSH."
                )
                st.code(f"{stack.env_var}={discovered}", language="bash")
                st.code(
                    f"cd {discovered} && docker compose up -d --pull always",
                    language="bash",
                )
            else:
                st.caption(
                    "No running container carries a Compose working-directory "
                    "label for this project, so there is nothing to suggest. "
                    f"Set `{stack.env_var}` to the directory holding its "
                    "compose file."
                )
            continue

        pending = [i for i in report.outdated if i.stack == stack.key]
        if pending:
            st.info(
                f"{len(pending)} container(s) in this stack have a newer image: "
                + ", ".join(i.display for i in pending),
                icon=":material/upgrade:",
            )
        confirm_and_run(action, current)

prune = registry.find("docker.prune_images")
if prune is not None:
    with st.container(border=True):
        st.markdown(f"#### {prune.label}")
        st.caption(f"`{prune.summary}`")
        confirm_and_run(prune, current)

st.divider()

with st.expander("What this page will not do"):
    st.markdown(
        f"""
**It will not upgrade the Ubuntu release.** `apt-get upgrade` upgrades
installed packages in place. A release upgrade (`do-release-upgrade`) removes
and replaces packages, can leave third-party repositories disabled, and wants
a console attached when it goes wrong. That is an SSH job.

**It will not install or remove packages.** The unit runs `update` then
`upgrade` and nothing else, so a package held back stays held back and shows
in the pending count above rather than dragging in a transition unasked.

**It will not restart services that an upgrade touched.** The unit sets
`NEEDRESTART_MODE=l`, which lists them without acting. Deciding that Plex or
the VPN stack restarts is not something an upgrade should do behind your back —
the reboot-required banner tells you when it matters.

**It will not roll a container back.** `docker compose up -d --pull always`
moves a tag forward. Going back means pinning the previous tag or digest in
the stack's compose file and bringing it up again; there is no button for that
because the right previous version is a decision, not a default. Note that
**Remove unused container images** deletes the version you upgraded away from,
so run it only once the new images have proved themselves.

**It will not schedule anything.** `{APT_UPGRADE_UNIT}` ships with no
`[Install]` section and must never be enabled — an upgrade on every boot is a
different feature, and `unattended-upgrades` already implements it properly.
"""
    )
