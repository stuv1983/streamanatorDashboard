"""Network — Internet, WAN, gateway, switches, access points and VLANs.

Everything gateway-side (real WAN throughput, per-VLAN client counts, firewall
drops, IDS/IPS) needs UniFi telemetry. Where it is not configured those panels
say NOT CONFIGURED and list the exact work required, rather than approximating
the numbers from host-side counters — the server's NIC throughput is not WAN
throughput, and presenting it as such would be wrong.

Where it *is* configured, the whole inventory is shown, not just the gateway:
a switch or an access point going down presents to a user as "the internet is
broken", and a healthy gateway is not the answer to that.
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

from components.cards import metric_card, not_configured_card, status_card
from components.charts import threshold_series, time_series, to_table
from components.layout import (
    chart_source_caption,
    health_table,
    page_header,
    read_only_notice,
)
from config import TIME_RANGES, get_settings
from core.collector import M_LATENCY, M_LOSS
from core.runtime import get_snapshot, trend_series
from core.status import Status
from health.thresholds import get_thresholds
from services import unifi
from utils.formatting import (
    format_percent,
    human_age,
    human_bytes_per_second,
    human_duration,
)

settings = get_settings()
thresholds = get_thresholds()
snapshot = get_snapshot()
network = snapshot.component("network")
raw = snapshot.raw.get("network", {})
range_label = st.session_state.get("time_range", "24h")
range_seconds = dict(TIME_RANGES).get(range_label, 86400)

page_header(
    "Network",
    "Internet reachability, WAN address and VLAN layout",
    snapshot.collected_at,
)


def _reading(key: str):
    if network is None:
        return None
    return next((r for r in network.readings if r.key == key), None)


# ---------------------------------------------------------------------------
# Internet
# ---------------------------------------------------------------------------

internet = raw.get("internet_ping")
gateway = raw.get("gateway_ping")

kpis = st.container(horizontal=True)
with kpis:
    metric_card(
        "Internet latency",
        f"{internet.latency_ms:.0f} ms"
        if internet and internet.latency_ms is not None
        else "—",
        help_text=f"ICMP to {internet.target}" if internet else "",
    )
    metric_card(
        "Packet loss",
        format_percent(internet.packet_loss_percent)
        if internet and internet.packet_loss_percent is not None
        else "—",
    )
    metric_card(
        "Jitter",
        f"{internet.jitter_ms:.1f} ms"
        if internet and internet.jitter_ms is not None
        else "—",
    )
    metric_card(
        "Gateway",
        f"{gateway.latency_ms:.1f} ms"
        if gateway and gateway.latency_ms is not None
        else "unreachable",
        help_text=f"Default gateway {raw.get('gateway_ip', '?')}",
    )
    dns = _reading("network.dns")
    metric_card("DNS", dns.display_value if dns else "—")

trend_left, trend_right = st.columns(2)
with trend_left:
    with st.container(border=True):
        st.markdown("**Latency**")
        samples = trend_series(M_LATENCY, None, range_seconds)
        chart = threshold_series(
            samples,
            "Latency",
            warning=thresholds.network.latency_warning_ms,
            critical=thresholds.network.latency_critical_ms,
            unit=" (ms)",
        )
        if chart is None:
            st.caption("No latency history yet.")
        else:
            st.altair_chart(chart, width="stretch")
            chart_source_caption(samples)
            with st.expander("Table view"):
                st.dataframe(
                    to_table(samples, "Latency"), hide_index=True, width="stretch"
                )

with trend_right:
    with st.container(border=True):
        st.markdown("**Packet loss**")
        samples = trend_series(M_LOSS, None, range_seconds)
        chart = threshold_series(
            samples,
            "Loss",
            warning=thresholds.network.packet_loss_warning_percent,
            critical=thresholds.network.packet_loss_critical_percent,
            unit=" (%)",
        )
        if chart is None:
            st.caption("No packet-loss history yet.")
        else:
            st.altair_chart(chart, width="stretch")
            chart_source_caption(samples)

# ---------------------------------------------------------------------------
# WAN IP
# ---------------------------------------------------------------------------

st.markdown("### WAN public IP")

wan_reading = _reading("network.wan_ip")
wan_info = raw.get("wan")
change = raw.get("wan_ip_change")

address_col, detail_col = st.columns([1, 2])
with address_col:
    if wan_reading is None:
        st.caption("WAN address unavailable.")
    else:
        status_card(
            label="Current WAN IP",
            status=wan_reading.status,
            value=str(wan_reading.value or "unknown"),
            detail=wan_reading.detail,
            source=wan_reading.source,
            age_seconds=wan_reading.age_seconds,
        )

with detail_col:
    with st.container(border=True):
        st.markdown("**Address history**")
        if change is None:
            st.caption("No address history recorded yet.")
        else:
            st.markdown(
                f"- **Current:** `{change.value}`\n"
                f"- **Previous:** `{change.previous or '—'}`\n"
                f"- **Last change:** {human_age(change.changed_at)}"
                f" ({human_duration(__import__('time').time() - change.changed_at)} stable)"
            )
        if wan_info is not None and wan_info.ip:
            st.caption(f":gray[{wan_info.org} · {wan_info.location}]")

# ---------------------------------------------------------------------------
# VLANs
# ---------------------------------------------------------------------------

st.markdown("### VLANs")

vlans = raw.get("vlans") or []
unifi_state = raw.get("unifi")

frame = pd.DataFrame(
    {
        "VLAN": [f"{v.vlan_id}" for v in vlans],
        "Name": [v.name for v in vlans],
        "Subnet": [v.subnet for v in vlans],
        "Clients": [
            f"{v.client_count:,}" if v.client_count is not None else "—" for v in vlans
        ],
        "RX": [
            human_bytes_per_second(v.rx_bytes_per_sec)
            if v.rx_bytes_per_sec is not None
            else "—"
            for v in vlans
        ],
        "TX": [
            human_bytes_per_second(v.tx_bytes_per_sec)
            if v.tx_bytes_per_sec is not None
            else "—"
            for v in vlans
        ],
        "Firewall blocks": [
            f"{v.firewall_blocks:,}" if v.firewall_blocks is not None else "—"
            for v in vlans
        ],
    }
)
st.dataframe(frame, hide_index=True, width="stretch")
st.caption(
    ":gray[Em dashes mean the value is not measurable without UniFi telemetry — "
    "not that it is zero. Inter-VLAN flow data is deliberately left blank rather "
    "than inferred.]"
)

# ---------------------------------------------------------------------------
# UniFi
# ---------------------------------------------------------------------------

st.markdown("### UniFi gateway")

if unifi_state is not None and not unifi_state.configured:
    not_configured_card(
        "UniFi telemetry",
        unifi_state.detail,
        steps=unifi_state.steps,
        source="unifi",
    )
    with st.expander("What connecting UniFi would add"):
        st.markdown("**Available via the Integration API (API key, MFA-safe):**")
        st.markdown(
            "\n".join(f"- {item}" for item in unifi.PROVIDED_BY_INTEGRATION_API)
        )
        st.markdown("**Still unavailable even once connected:**")
        st.markdown(
            "\n".join(f"- {item}" for item in unifi.NOT_PROVIDED_BY_INTEGRATION_API)
        )
        st.caption(
            "The Integration API authenticates with an API key rather than a "
            "login, so MFA on the account stays enabled. IDS/IPS history and "
            "firewall counters live only on the legacy API, which requires an "
            "interactive login that MFA blocks — so they stay unavailable "
            "rather than being approximated from something else."
        )
else:
    gateway_status = raw.get("gateway_status")
    if gateway_status is None:
        st.caption("Gateway telemetry not yet collected.")
    else:
        columns = st.columns(4)
        with columns[0]:
            metric_card(
                "Gateway CPU",
                f"{gateway_status.cpu_percent:.0f}%"
                if gateway_status.cpu_percent is not None
                else "—",
            )
        with columns[1]:
            metric_card(
                "Gateway RAM",
                f"{gateway_status.memory_percent:.0f}%"
                if gateway_status.memory_percent is not None
                else "—",
            )
        with columns[2]:
            metric_card(
                "WAN RX",
                human_bytes_per_second(gateway_status.wan_rx_bytes_per_sec),
            )
        with columns[3]:
            metric_card(
                "WAN TX",
                human_bytes_per_second(gateway_status.wan_tx_bytes_per_sec),
            )

    # -- Switches and access points ---------------------------------------
    #
    # The inventory is fetched for the gateway panel above and used to be
    # discarded, which meant the switch and both APs were polled on every
    # collection and never shown. They are the rest of the network path: if an
    # AP is down, "the internet is broken" is what gets reported, and the
    # gateway looking healthy is not the answer.
    st.markdown("### UniFi devices")

    devices = raw.get("unifi_devices") or []
    devices_error = raw.get("unifi_devices_error") or ""
    infrastructure = [d for d in devices if d.role != "gateway"]

    if devices_error:
        st.caption(f":gray[Device inventory unavailable: {devices_error}]")
    elif not infrastructure:
        st.caption(
            ":gray[No switches or access points reported by the controller.]"
        )
    else:
        for device in sorted(infrastructure, key=lambda d: (d.role, d.name)):
            with st.container(border=True):
                heading, badge = st.columns([3, 1], vertical_alignment="center")
                with heading:
                    st.markdown(
                        f"**{device.name or device.model}** "
                        f":gray[{device.role} · {device.model}]"
                    )
                with badge:
                    status_card(
                        "State",
                        Status.HEALTHY if device.online else Status.CRITICAL,
                        device.state.title() or "Unknown",
                        source="unifi",
                    )
                stats = st.columns(5)
                with stats[0]:
                    metric_card("IP", device.ip_address or "—")
                with stats[1]:
                    metric_card(
                        "Uptime",
                        human_duration(device.uptime_seconds)
                        if device.uptime_seconds
                        else "—",
                    )
                with stats[2]:
                    metric_card(
                        "CPU",
                        format_percent(device.cpu_percent)
                        if device.cpu_percent is not None
                        else "—",
                    )
                with stats[3]:
                    metric_card(
                        "RAM",
                        format_percent(device.memory_percent)
                        if device.memory_percent is not None
                        else "—",
                    )
                with stats[4]:
                    # Not clients: the Integration API's statistics payload
                    # carries no client count for a device, so a "Clients" tile
                    # here could only ever show "—". Firmware state is
                    # something it does report, and is actionable.
                    metric_card(
                        "Firmware",
                        device.firmware_version or "—",
                        delta="update available"
                        if device.firmware_updatable
                        else None,
                        delta_color="off",
                    )
                # Uplink rates are reported in bits per second; the dashboard
                # speaks bytes everywhere else, so convert rather than mixing
                # units between panels.
                if device.uplink_rx_bps is not None or device.uplink_tx_bps is not None:
                    st.caption(
                        ":gray[Uplink "
                        f"RX {human_bytes_per_second((device.uplink_rx_bps or 0) / 8.0)} · "
                        f"TX {human_bytes_per_second((device.uplink_tx_bps or 0) / 8.0)}]"
                    )

                # Radio retries are the one wifi-quality number the API gives.
                # A rising retry rate is interference or clients at the edge of
                # range, and it shows here before anyone reports "wifi is slow".
                if device.radios:
                    radio_columns = st.columns(len(device.radios))
                    for column, radio in zip(radio_columns, device.radios):
                        with column:
                            metric_card(
                                f"{radio.band} retries",
                                format_percent(radio.tx_retries_percent)
                                if radio.tx_retries_percent is not None
                                else "—",
                            )

        with st.expander("All UniFi devices"):
            st.dataframe(
                pd.DataFrame(
                    [
                        {
                            "Name": d.name or "—",
                            "Role": d.role,
                            "Model": d.model or "—",
                            "IP": d.ip_address or "—",
                            "MAC": d.mac or "—",
                            "State": d.state.title() or "—",
                            "Uptime": human_duration(d.uptime_seconds)
                            if d.uptime_seconds
                            else "—",
                        }
                        for d in sorted(devices, key=lambda d: (d.role, d.name))
                    ]
                ),
                hide_index=True,
                width="stretch",
            )

    # -- Networks as the controller defines them --------------------------
    #
    # The VLAN table above is a transcription of the documentation. This one
    # is the controller's own answer, and the comparison between the two is
    # the point: a VLAN renamed or renumbered on the console would otherwise
    # leave the dashboard silently matching clients against the wrong rows.
    st.markdown("### Networks (from the controller)")
    live_networks, networks_error = unifi.get_networks(
        settings.unifi.controller_url,
        settings.unifi.api_key or "",
        settings.unifi.verify_tls,
        settings.unifi.site,
    )
    if networks_error:
        st.caption(f":gray[Controller networks unavailable: {networks_error}]")
    elif live_networks:
        configured_names = {v.vlan_id: v.name for v in settings.vlans}
        rows = []
        drift: list[str] = []
        for network_definition in sorted(
            live_networks, key=lambda n: (n.vlan_id is None, n.vlan_id or 0)
        ):
            expected = (
                configured_names.get(network_definition.vlan_id)
                if network_definition.vlan_id is not None
                else None
            )
            matches = (
                expected is not None
                and expected.lower().replace("-", " ")
                == network_definition.name.lower().replace("-", " ")
            )
            if expected is not None and not matches:
                drift.append(
                    f"VLAN {network_definition.vlan_id} is "
                    f"`{network_definition.name}` on the controller but "
                    f"`{expected}` in the dashboard's configuration"
                )
            rows.append(
                {
                    "VLAN": network_definition.vlan_id
                    if network_definition.vlan_id is not None
                    else "—",
                    "Controller name": network_definition.name,
                    "Configured name": expected or "—",
                    "Subnet": network_definition.subnet or "—",
                    "Enabled": "yes" if network_definition.enabled else "no",
                }
            )
        st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
        if drift:
            st.warning(
                "**Configuration drift** — the controller disagrees with the "
                "dashboard's VLAN table:\n"
                + "\n".join(f"- {item}" for item in drift)
                + "\n\nThe controller is authoritative. Update the `VLANS` "
                "table in `config.py` (and the network documentation) to "
                "match it.",
                icon=":material/difference:",
            )

# ---------------------------------------------------------------------------
# Host interfaces
# ---------------------------------------------------------------------------

with st.expander("Server network interfaces"):
    rates = raw.get("interface_rates") or {}
    if not rates:
        st.caption(
            "No interface rates yet — two samples are needed to compute a rate."
        )
    else:
        st.dataframe(
            pd.DataFrame(
                {
                    "Interface": list(rates.keys()),
                    "RX": [human_bytes_per_second(r.rx_bytes_per_sec) for r in rates.values()],
                    "TX": [human_bytes_per_second(r.tx_bytes_per_sec) for r in rates.values()],
                    "RX errors": [r.rx_error_delta for r in rates.values()],
                    "TX errors": [r.tx_error_delta for r in rates.values()],
                    "Drops": [r.drop_delta for r in rates.values()],
                }
            ),
            hide_index=True,
            width="stretch",
        )
        st.caption(
            ":gray[These are the server's own interfaces, not the gateway's WAN "
            "link.]"
        )

st.divider()
health_table(network.readings if network else [])
read_only_notice()
