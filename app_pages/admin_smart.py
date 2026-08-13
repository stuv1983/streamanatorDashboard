"""Set up SMART disk health.

Disk health is the one component the dashboard currently cannot see. That is
not a bug in the collector — `smartctl` needs `CAP_SYS_RAWIO` to talk to a
drive, so it must run as root, and the dashboard account has no passwordless
sudo. The health score is being held back honestly rather than showing a green
tick it cannot justify.

This page fixes that, and it presents the two routes in order of preference
rather than as equal options, because they are not equal.
"""

from __future__ import annotations

import streamlit as st

from admin import actions as registry
from components.admin_ui import confirm_and_run, require_admin, session_bar
from components.layout import page_header
from config import CRC_WATCH_SERIAL, get_settings
from core.runtime import audit_log
from services import smart
from utils.cache import clear_all

current = require_admin("Disk health setup")
settings = get_settings()
audit = audit_log()

page_header("Disk health setup", "Give the dashboard access to SMART data")
session_bar(current)
st.divider()

# ---------------------------------------------------------------------------
# Current state
# ---------------------------------------------------------------------------

st.markdown("### Current access")

prometheus_configured = settings.prometheus.configured
local_error: str | None = None
disks: dict[str, smart.SmartDisk] = {}

try:
    disks = smart.collect_smart_local(
        settings.local.smartctl_path, settings.local.smartctl_via_sudo
    )
except smart.SmartUnavailable as exc:
    local_error = str(exc)
except Exception as exc:  # noqa: BLE001 - a setup page must never crash
    local_error = f"{type(exc).__name__}: {exc}"

left, right = st.columns(2)
with left:
    if disks:
        st.success(
            f"SMART is readable — {len(disks)} disk(s) reporting.",
            icon=":material/check_circle:",
        )
    else:
        st.error(
            "SMART is not readable. Disk health shows NOT CONFIGURED and the "
            "health score is held back accordingly.",
            icon=":material/block:",
        )
        if local_error:
            st.caption(f":gray[{local_error}]")
with right:
    st.metric(
        "smartctl_exporter",
        "configured" if prometheus_configured else "not deployed",
        border=True,
        help="Prometheus is the preferred source: it gives history, not just "
        "an instantaneous reading.",
    )

if st.button("Re-check now", icon=":material/refresh:"):
    clear_all()
    st.rerun()

st.divider()

# ---------------------------------------------------------------------------
# Route 1 — the exporter
# ---------------------------------------------------------------------------

st.markdown("### Route 1 — run the smartctl exporter :green-badge[recommended]")

st.markdown(
    """
Starts a container that reads SMART and publishes it to Prometheus. Preferred
for two reasons that matter more than convenience:

**Privilege stays in one place.** The container gets raw device access; the
dashboard account gets nothing new. Compare that with granting sudo to a
long-running web application, where every future bug in that application is
adjacent to a root capability.

**You get history, not a snapshot.** This is the difference between "CRC count
is 5670" and "CRC count has not moved in nine days" — and only the second one
answers whether `WPV2E6LL` has an active fault or a healed one. The dashboard's
CRC classification is built around the delta; without history it can only ever
say UNKNOWN.
"""
)

exporter = registry.find("smart.deploy_exporter")
if exporter is not None:
    with st.container(border=True):
        confirm_and_run(exporter, current)

st.caption(
    "After it starts, set `PROMETHEUS_URL=http://127.0.0.1:9090` in the "
    "credentials page — the exporter feeds Prometheus, and the dashboard "
    "reads Prometheus. The exporter alone is not enough."
)

st.divider()

# ---------------------------------------------------------------------------
# Route 2 — sudoers
# ---------------------------------------------------------------------------

st.markdown("### Route 2 — grant the dashboard read-only smartctl via sudo")

st.markdown(
    """
Permits exactly two `smartctl` invocations — `-j -a` (JSON, all read-only
attributes) and `-j -H` (health) — with the device argument constrained to
`/dev/sd?`. The forms that can *write* to a drive (`-t` self-tests, `-s`
setting changes, `--set`) are explicitly denied.

Use this if you are not deploying the exporter. It gives instantaneous values
with no history, so CRC trend analysis stays limited to whatever the
dashboard's own sampler has accumulated since it started.
"""
)

st.warning(
    "This step is SSH-only and always will be. The sudoers file lives in the "
    "project directory, which the dashboard account can write — so letting "
    "the dashboard install it would be a one-step path from this account to "
    "root: rewrite the file, then ask the dashboard to install it.",
    icon=":material/security:",
)

st.code(
    "cd /home/arm/projects/streamanator_dashboard\n"
    "sudo install -m 0440 -o root -g root \\\n"
    "    deploy/sudoers-smartctl \\\n"
    "    /etc/sudoers.d/streamanator-dashboard-smartctl\n"
    "sudo visudo -c        # must report 'parsed OK'\n"
    "\n"
    "# then set SMARTCTL_SUDO=true in .env and restart the dashboard",
    language="bash",
)

st.caption(
    "Keep a second root shell open until `visudo -c` passes — a malformed "
    "file in `/etc/sudoers.d` disables sudo for every user on the host."
)

st.divider()

# ---------------------------------------------------------------------------
# The disk that matters
# ---------------------------------------------------------------------------

st.markdown(f"### Why this matters for `{CRC_WATCH_SERIAL}`")

watched = disks.get(CRC_WATCH_SERIAL)
if watched is not None:
    columns = st.columns(3)
    with columns[0]:
        st.metric(
            "UDMA CRC errors",
            f"{watched.udma_crc_errors:,.0f}"
            if watched.udma_crc_errors is not None
            else "—",
            border=True,
        )
    with columns[1]:
        st.metric(
            "Self-assessment",
            "PASSED" if watched.passed else ("FAILED" if watched.passed is False else "—"),
            border=True,
        )
    with columns[2]:
        st.metric(
            "Temperature",
            f"{watched.temperature_celsius:.0f} °C"
            if watched.temperature_celsius is not None
            else "—",
            border=True,
        )
    st.caption(f"{watched.model} at {watched.device}")

st.markdown(
    f"""
`{CRC_WATCH_SERIAL}` carries a CRC error count in the thousands, and the array
kicked it as non-fresh on 11 August. The absolute number is close to useless
on its own — CRC counters never reset, so a fault that was fixed a year ago
looks identical to one happening now.

What distinguishes them is movement. The dashboard classifies this disk on the
**delta**, not the total: a large but static count reads HEALTHY with the note
that it reflects a past fault, and only a rising count raises a warning. That
warning points at the cable, connector, backplane and controller port before
the disk media, because UDMA CRC errors are transmission errors on the link —
replacing a healthy drive because of them is a common and expensive mistake.

None of that works without SMART access. Right now this disk reports
{"data" if watched else "**nothing at all**"}.
"""
)
