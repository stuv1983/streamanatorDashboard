"""VPN — Gluetun state, leak check and diagnosis.

The leak check sits at the top of the page, not behind a menu. If the download
stack's public IP ever matches the home WAN IP, that is the single most
important thing on this dashboard.
"""

from __future__ import annotations

import streamlit as st

from components.alerts import alert_card
from components.cards import metric_card, status_card
from components.layout import page_header, read_only_notice
from config import get_settings
from core.runtime import get_snapshot
from core.status import Status
from services.docker_service import get_container_logs
from utils.formatting import human_duration

settings = get_settings()
snapshot = get_snapshot()
component = snapshot.component("vpn")
raw = snapshot.raw.get("vpn", {})
status = raw.get("status")
leak = raw.get("leak")

page_header(
    "VPN",
    f"{settings.vpn.provider} over {settings.vpn.protocol} via "
    f"{settings.vpn.container}",
    snapshot.collected_at,
)


def _reading(key: str):
    if component is None:
        return None
    return next((r for r in component.readings if r.key == key), None)


# ---------------------------------------------------------------------------
# Leak check — first, always
# ---------------------------------------------------------------------------

leak_reading = _reading("vpn.leak")
if leak_reading is not None:
    if leak_reading.status is Status.CRITICAL:
        st.error(
            f"### POSSIBLE VPN LEAK\n\n{leak_reading.detail}\n\n"
            "Download-client traffic is leaving through the home WAN address.",
            icon=":material/error:",
        )
    elif leak_reading.status is Status.UNKNOWN:
        st.warning(
            f"**Leak check inconclusive.** {leak_reading.detail}\n\n"
            "An inconclusive result is not a pass — it means the dashboard cannot "
            "currently confirm where download traffic is going.",
            icon=":material/help:",
        )
    else:
        st.success(
            f"**Leak check: PASS.** {leak_reading.detail}",
            icon=":material/verified_user:",
        )

if leak is not None:
    columns = st.columns(3)
    with columns[0]:
        metric_card("VPN exit IP", leak.vpn_ip or "unknown")
    with columns[1]:
        metric_card("Home WAN IP", leak.wan_ip or "unknown")
    with columns[2]:
        metric_card(
            "Result",
            "PASS" if leak.passed else ("FAIL" if leak.passed is False else "UNKNOWN"),
            help_text="These two addresses must differ.",
        )

st.divider()

# ---------------------------------------------------------------------------
# Tunnel state
# ---------------------------------------------------------------------------

st.markdown("### Tunnel")

if status is None:
    st.error("Gluetun state could not be determined.", icon=":material/error:")
else:
    left, right = st.columns([1, 2])
    with left:
        tunnel_reading = _reading("vpn.gluetun")
        if tunnel_reading is not None:
            status_card(
                label="Gluetun",
                status=tunnel_reading.status,
                value=status.public_ip or "no tunnel",
                detail=tunnel_reading.detail,
                threshold=tunnel_reading.threshold,
                source=tunnel_reading.source,
                age_seconds=tunnel_reading.age_seconds,
            )

    with right:
        with st.container(border=True):
            st.markdown("**State**")
            checks = {
                "Container present": status.container_present,
                "Container running": status.container_running,
                "Docker healthcheck": status.container_healthy,
                "Tunnel up": status.tunnel_up,
                "DNS resolution": status.dns_ok,
                "Outbound HTTPS": status.https_ok,
            }
            for label, value in checks.items():
                if value is None:
                    st.markdown(f"- :gray[○] {label}: **unknown**")
                elif value:
                    st.markdown(f"- :green[●] {label}: **ok**")
                else:
                    st.markdown(f"- :red[●] {label}: **failed**")

            facts = st.columns(3)
            with facts[0]:
                st.caption("Provider")
                st.markdown(f"**{status.provider or '—'}**")
            with facts[1]:
                st.caption("Uptime")
                st.markdown(
                    f"**{human_duration(status.uptime_seconds)}**"
                    if status.uptime_seconds
                    else "**—**"
                )
            with facts[2]:
                st.caption("Restarts")
                st.markdown(f"**{status.restart_count}**")

            if status.location:
                st.caption(f":gray[Exit location: {status.location} · {status.org}]")

    # -----------------------------------------------------------------
    # Diagnosis
    # -----------------------------------------------------------------
    unhealthy = (
        status.container_healthy is False
        or status.tunnel_up is False
        or status.dns_ok is False
    )
    if unhealthy:
        st.markdown("### Diagnosis")
        with st.container(border=True):
            if status.error:
                st.markdown(f"**Likely cause:** {status.error}")
            if status.auth_failures:
                st.markdown(
                    f"**{status.auth_failures} AUTH_FAILED entries** in recent logs. "
                    "The provider is rejecting the credentials. NordVPN service "
                    "credentials are not the same as the account login."
                )
            if status.reconnects:
                st.markdown(f"**{status.reconnects} reconnect events** in recent logs.")
            if status.recent_errors:
                st.markdown("**Recent errors**")
                st.code("\n".join(status.recent_errors), language="log")

        st.markdown("**Troubleshooting order**")
        st.markdown(
            "1. Gluetun container health\n"
            "2. Gluetun VPN authentication logs\n"
            "3. DNS resolution from inside Gluetun\n"
            "4. DNS from a dependent container (Prowlarr)\n"
            "5. Outbound HTTPS\n"
            "6. Only then, indexer/application configuration"
        )

    with st.expander("Gluetun logs (on demand)"):
        if st.button("Fetch last 150 lines", icon=":material/description:"):
            logs = get_container_logs(settings.vpn.container, lines=150)
            if logs:
                st.code("\n".join(logs), language="log")
            else:
                st.caption("No log output returned.")

# ---------------------------------------------------------------------------
# Dependent services
# ---------------------------------------------------------------------------

st.markdown("### Services depending on this tunnel")
st.caption(
    "These containers share Gluetun's network namespace. A tunnel failure takes "
    "all of them offline simultaneously, which is why their alerts are grouped "
    "under Gluetun rather than reported separately."
)
dependent = [c.display for c in settings.containers if c.behind_vpn]
st.markdown("\n".join(f"- {name}" for name in dependent))

# ---------------------------------------------------------------------------
# Control server
# ---------------------------------------------------------------------------

if not settings.api.gluetun_api_key:
    st.info(
        "**Gluetun control server not configured.** Gluetun v3.40+ requires "
        "authentication on its HTTP control API (listening on :8000 here). "
        "Setting `GLUETUN_CONTROL_URL` and `GLUETUN_API_KEY` would add tunnel "
        "status, the current server endpoint and forwarded-port detail. Without "
        "it, tunnel state is inferred from the exit-IP lookup, which is reliable "
        "but coarser.",
        icon=":material/info:",
    )

st.divider()
for alert in snapshot.alerts:
    if alert.key.startswith("vpn."):
        alert_card(alert)
read_only_notice()
