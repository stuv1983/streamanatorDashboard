"""Network — Internet health plus compact, drillable UniFi telemetry."""

from __future__ import annotations

from typing import Any

import pandas as pd
import streamlit as st

from components.cards import metric_card, not_configured_card, status_card
from components.charts import threshold_series, to_table
from components.layout import (
    chart_source_caption,
    health_table,
    page_header,
    read_only_notice,
)
from config import TIME_RANGES, get_settings
from core.collector import M_LATENCY, M_LOSS
from core.runtime import get_snapshot, trend_series
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
    "Internet reachability, WAN state and UniFi infrastructure",
    snapshot.collected_at,
)


def _reading(key: str):
    if network is None:
        return None
    return next((reading for reading in network.readings if reading.key == key), None)


def _safe_unifi_rows(objects: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Flatten every safe scalar returned by UniFi without exposing secrets."""
    rows: list[dict[str, str]] = []
    blocked = ("password", "secret", "token", "credential", "api_key", "apikey")

    def walk(label: str, value: Any, prefix: str = "", depth: int = 0) -> None:
        if depth > 3:
            return
        if isinstance(value, dict):
            for key, nested in sorted(value.items(), key=lambda item: str(item[0])):
                name = str(key)
                if any(term in name.casefold() for term in blocked):
                    continue
                path = f"{prefix}.{name}" if prefix else name
                walk(label, nested, path, depth + 1)
            return
        if isinstance(value, list):
            if all(isinstance(item, (str, int, float, bool, type(None))) for item in value):
                rows.append(
                    {
                        "Interface": label,
                        "Property": prefix,
                        "Value": ", ".join(str(item) for item in value) or "—",
                    }
                )
            return
        if isinstance(value, (str, int, float, bool)) or value is None:
            rows.append(
                {
                    "Interface": label,
                    "Property": prefix,
                    "Value": "—" if value is None or value == "" else str(value),
                }
            )

    for index, item in enumerate(objects, start=1):
        label = str(item.get("name") or item.get("interface") or f"WAN {index}")
        walk(label, item)
    return rows


# ---------------------------------------------------------------------------
# Internet and host-side network measurements
# ---------------------------------------------------------------------------

internet = raw.get("internet_ping")
gateway_ping = raw.get("gateway_ping")
dns = _reading("network.dns")

with st.container(horizontal=True):
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
        "Local gateway",
        f"{gateway_ping.latency_ms:.1f} ms"
        if gateway_ping and gateway_ping.latency_ms is not None
        else "unreachable",
        help_text=f"Default gateway {raw.get('gateway_ip', '?')}",
    )
    metric_card("DNS", dns.display_value if dns else "—")

latency_col, loss_col = st.columns(2)
with latency_col:
    with st.container(border=True):
        st.markdown("**Latency trend**")
        latency_samples = trend_series(M_LATENCY, None, range_seconds)
        latency_chart = threshold_series(
            latency_samples,
            "Latency",
            warning=thresholds.network.latency_warning_ms,
            critical=thresholds.network.latency_critical_ms,
            unit=" (ms)",
        )
        if latency_chart is None:
            st.caption("No latency history yet.")
        else:
            st.altair_chart(latency_chart, width="stretch")
            chart_source_caption(latency_samples)
            with st.expander("Table view"):
                st.dataframe(
                    to_table(latency_samples, "Latency"),
                    hide_index=True,
                    width="stretch",
                )

with loss_col:
    with st.container(border=True):
        st.markdown("**Packet-loss trend**")
        loss_samples = trend_series(M_LOSS, None, range_seconds)
        loss_chart = threshold_series(
            loss_samples,
            "Loss",
            warning=thresholds.network.packet_loss_warning_percent,
            critical=thresholds.network.packet_loss_critical_percent,
            unit=" (%)",
        )
        if loss_chart is None:
            st.caption("No packet-loss history yet.")
        else:
            st.altair_chart(loss_chart, width="stretch")
            chart_source_caption(loss_samples)

# ---------------------------------------------------------------------------
# WAN identity and VLANs
# ---------------------------------------------------------------------------

wan_reading = _reading("network.wan_ip")
wan_info = raw.get("wan")
change = raw.get("wan_ip_change")
wan_label = str(wan_reading.value) if wan_reading and wan_reading.value else "unknown"
with st.expander(f":material/public: WAN public IP · {wan_label}"):
    address_col, history_col = st.columns([1, 2])
    with address_col:
        if wan_reading:
            status_card(
                "Current WAN IP",
                wan_reading.status,
                wan_label,
                detail=wan_reading.detail,
                source=wan_reading.source,
                age_seconds=wan_reading.age_seconds,
            )
        else:
            st.caption("WAN address unavailable.")
    with history_col:
        if change is None:
            st.caption("No address history recorded yet.")
        else:
            st.markdown(
                f"- **Current:** `{change.value}`\n"
                f"- **Previous:** `{change.previous or '—'}`\n"
                f"- **Last change:** {human_age(change.changed_at)}"
            )
        if wan_info is not None and wan_info.ip:
            st.caption(f":gray[{wan_info.org} · {wan_info.location}]")

st.markdown("### VLANs")
vlans = raw.get("vlans") or []
st.dataframe(
    pd.DataFrame(
        {
            "VLAN": [str(vlan.vlan_id) for vlan in vlans],
            "Name": [vlan.name for vlan in vlans],
            "Subnet": [vlan.subnet for vlan in vlans],
            "Clients": [
                f"{vlan.client_count:,}" if vlan.client_count is not None else "—"
                for vlan in vlans
            ],
            "RX": [human_bytes_per_second(vlan.rx_bytes_per_sec) for vlan in vlans],
            "TX": [human_bytes_per_second(vlan.tx_bytes_per_sec) for vlan in vlans],
            "Firewall blocks": [
                f"{vlan.firewall_blocks:,}"
                if vlan.firewall_blocks is not None
                else "—"
                for vlan in vlans
            ],
        }
    ),
    hide_index=True,
    width="stretch",
)
st.caption(
    ":gray[An em dash means UniFi does not expose that measurement; it does not mean zero.]"
)

# ---------------------------------------------------------------------------
# UniFi — compact summary labels, full detail only when opened
# ---------------------------------------------------------------------------

st.markdown("### UniFi")
unifi_state = raw.get("unifi")

if unifi_state is not None and not unifi_state.configured:
    not_configured_card(
        "UniFi telemetry",
        unifi_state.detail,
        steps=unifi_state.steps,
        source="unifi",
    )
    with st.expander("What connecting UniFi would add"):
        st.markdown("**Available through the Integration API:**")
        st.markdown(
            "\n".join(f"- {item}" for item in unifi.PROVIDED_BY_INTEGRATION_API)
        )
        st.markdown("**Not exposed by that API:**")
        st.markdown(
            "\n".join(f"- {item}" for item in unifi.NOT_PROVIDED_BY_INTEGRATION_API)
        )
else:
    gateway_status = raw.get("gateway_status")
    devices = raw.get("unifi_devices") or []
    devices_error = raw.get("unifi_devices_error") or ""
    gateway_device = next((device for device in devices if device.role == "gateway"), None)

    controller_info = None
    live_networks: list = []
    networks_error = ""
    wans: list[dict[str, Any]] = []
    wans_error = ""
    if settings.unifi.controller_url and settings.unifi.api_key:
        controller_info = unifi.get_controller_info(
            settings.unifi.controller_url,
            settings.unifi.api_key,
            settings.unifi.verify_tls,
        )
        live_networks, networks_error = unifi.get_networks(
            settings.unifi.controller_url,
            settings.unifi.api_key,
            settings.unifi.verify_tls,
            settings.unifi.site,
        )
        wans, wans_error = unifi.get_wans(
            settings.unifi.controller_url,
            settings.unifi.api_key,
            settings.unifi.verify_tls,
            settings.unifi.site,
        )

    gateway_name = (
        gateway_device.name
        if gateway_device and gateway_device.name
        else gateway_status.name
        if gateway_status
        else "Gateway"
    )
    gateway_online = bool(
        gateway_device.online
        if gateway_device
        else gateway_status and gateway_status.wan_up
    )
    gateway_icon = ":material/check_circle:" if gateway_online else ":material/error:"
    gateway_cpu = gateway_status.cpu_percent if gateway_status else None
    gateway_ram = gateway_status.memory_percent if gateway_status else None

    with st.expander(
        f"{gateway_icon} UniFi gateway · {gateway_name} · "
        f"{'online' if gateway_online else 'offline or unknown'} · "
        f"CPU {format_percent(gateway_cpu)} · RAM {format_percent(gateway_ram)}",
        expanded=not gateway_online,
    ):
        if gateway_status is None:
            st.caption("Gateway telemetry has not been collected yet.")
        else:
            with st.container(horizontal=True):
                metric_card("CPU", format_percent(gateway_status.cpu_percent))
                metric_card("RAM", format_percent(gateway_status.memory_percent))
                metric_card(
                    "WAN RX",
                    human_bytes_per_second(gateway_status.wan_rx_bytes_per_sec),
                )
                metric_card(
                    "WAN TX",
                    human_bytes_per_second(gateway_status.wan_tx_bytes_per_sec),
                )
                metric_card(
                    "Uptime",
                    human_duration(gateway_status.uptime_seconds)
                    if gateway_status.uptime_seconds is not None
                    else "—",
                )
                if gateway_device:
                    metric_card(
                        "Load (1m)",
                        f"{gateway_device.load_1m:.2f}"
                        if gateway_device.load_1m is not None
                        else "—",
                    )

        identity_rows: list[dict[str, str]] = []
        if gateway_device:
            identity_rows = [
                {"Property": "Name", "Value": gateway_device.name or "—"},
                {"Property": "Model", "Value": gateway_device.model or "—"},
                {"Property": "Type", "Value": gateway_device.device_type or "gateway"},
                {"Property": "State", "Value": gateway_device.state or "—"},
                {"Property": "IP address", "Value": gateway_device.ip_address or "—"},
                {"Property": "MAC address", "Value": gateway_device.mac or "—"},
                {
                    "Property": "Firmware",
                    "Value": (gateway_device.firmware_version or "—")
                    + (" · update available" if gateway_device.firmware_updatable else ""),
                },
            ]
        if controller_info:
            identity_rows.append(
                {
                    "Property": "Network application",
                    "Value": controller_info.version or controller_info.error or "—",
                }
            )
        if identity_rows:
            st.dataframe(pd.DataFrame(identity_rows), hide_index=True, width="stretch")

        st.markdown("**WAN configuration from controller**")
        if wans_error:
            st.caption(f":gray[{wans_error}]")
        elif wans:
            wan_rows = _safe_unifi_rows(wans)
            if wan_rows:
                st.dataframe(pd.DataFrame(wan_rows), hide_index=True, width="stretch")
            else:
                st.caption("UniFi returned no safe display fields for the WAN objects.")
        else:
            st.caption("No WAN interfaces were returned.")

    infrastructure = [device for device in devices if device.role != "gateway"]
    offline_count = sum(not device.online for device in infrastructure)
    update_count = sum(device.firmware_updatable for device in infrastructure)
    with st.container(border=True):
        summary_col, control_col = st.columns([4, 2], vertical_alignment="center")
        with summary_col:
            st.markdown("**UniFi devices**")
            st.caption(
                f"{len(infrastructure)} switches/access points · "
                f"{offline_count} offline · {update_count} firmware update(s)"
            )
        with control_col:
            show_devices = st.toggle(
                "Expand device inventory",
                value=False,
                key="network_show_unifi_devices",
            )

        if devices_error:
            st.warning(f"Device inventory unavailable: {devices_error}")
        elif not infrastructure:
            st.caption("No switches or access points were reported by the controller.")
        elif show_devices:
            for device in sorted(infrastructure, key=lambda item: (item.role, item.name)):
                icon = ":material/check_circle:" if device.online else ":material/error:"
                update = " · update available" if device.firmware_updatable else ""
                with st.expander(
                    f"{icon} {device.name or device.model} · {device.role} · "
                    f"{device.model or 'unknown model'} · {device.ip_address or 'no IP'}"
                    f"{update}",
                    expanded=not device.online,
                ):
                    with st.container(horizontal=True):
                        metric_card("State", device.state.title() or "Unknown")
                        metric_card(
                            "Uptime",
                            human_duration(device.uptime_seconds)
                            if device.uptime_seconds is not None
                            else "—",
                        )
                        metric_card("CPU", format_percent(device.cpu_percent))
                        metric_card("RAM", format_percent(device.memory_percent))
                        metric_card(
                            "Load (1m)",
                            f"{device.load_1m:.2f}"
                            if device.load_1m is not None
                            else "—",
                        )
                        metric_card(
                            "Firmware",
                            device.firmware_version or "—",
                            delta="update available" if device.firmware_updatable else None,
                            delta_color="off",
                        )
                    st.dataframe(
                        pd.DataFrame(
                            [
                                {"Property": "Device ID", "Value": device.device_id or "—"},
                                {"Property": "Type", "Value": device.device_type or device.role},
                                {"Property": "MAC address", "Value": device.mac or "—"},
                                {
                                    "Property": "Uplink RX",
                                    "Value": human_bytes_per_second(
                                        device.uplink_rx_bps / 8.0
                                        if device.uplink_rx_bps is not None
                                        else None
                                    ),
                                },
                                {
                                    "Property": "Uplink TX",
                                    "Value": human_bytes_per_second(
                                        device.uplink_tx_bps / 8.0
                                        if device.uplink_tx_bps is not None
                                        else None
                                    ),
                                },
                            ]
                        ),
                        hide_index=True,
                        width="stretch",
                    )
                    if device.radios:
                        st.markdown("**Radio statistics**")
                        st.dataframe(
                            pd.DataFrame(
                                [
                                    {
                                        "Band": radio.band,
                                        "Frequency": f"{radio.frequency_ghz:g} GHz",
                                        "TX retries": format_percent(radio.tx_retries_percent),
                                    }
                                    for radio in device.radios
                                ]
                            ),
                            hide_index=True,
                            width="stretch",
                        )

    configured_names = {vlan.vlan_id: vlan.name for vlan in settings.vlans}
    network_rows: list[dict[str, object]] = []
    drift: list[str] = []
    for definition in sorted(
        live_networks, key=lambda item: (item.vlan_id is None, item.vlan_id or 0)
    ):
        expected = configured_names.get(definition.vlan_id)
        matches = (
            expected is not None
            and expected.lower().replace("-", " ")
            == definition.name.lower().replace("-", " ")
        )
        if expected is not None and not matches:
            drift.append(
                f"VLAN {definition.vlan_id}: controller `{definition.name}`, "
                f"dashboard `{expected}`"
            )
        network_rows.append(
            {
                "VLAN": definition.vlan_id if definition.vlan_id is not None else "—",
                "Controller name": definition.name,
                "Configured name": expected or "—",
                "Subnet": definition.subnet or "—",
                "Purpose": definition.purpose or "—",
                "Enabled": "yes" if definition.enabled else "no",
            }
        )

    with st.expander(
        f":material/account_tree: Controller networks · {len(live_networks)}",
        expanded=bool(drift),
    ):
        if networks_error:
            st.caption(f":gray[Controller networks unavailable: {networks_error}]")
        elif network_rows:
            st.dataframe(pd.DataFrame(network_rows), hide_index=True, width="stretch")
        else:
            st.caption("No controller networks were returned.")
        if drift:
            st.warning(
                "**Configuration drift:**\n" + "\n".join(f"- {item}" for item in drift),
                icon=":material/difference:",
            )

# ---------------------------------------------------------------------------
# Secondary detail
# ---------------------------------------------------------------------------

with st.expander("Server network interfaces"):
    rates = raw.get("interface_rates") or {}
    if not rates:
        st.caption("No interface rates yet — two samples are needed.")
    else:
        st.dataframe(
            pd.DataFrame(
                {
                    "Interface": list(rates),
                    "RX": [human_bytes_per_second(rate.rx_bytes_per_sec) for rate in rates.values()],
                    "TX": [human_bytes_per_second(rate.tx_bytes_per_sec) for rate in rates.values()],
                    "RX errors": [rate.rx_error_delta for rate in rates.values()],
                    "TX errors": [rate.tx_error_delta for rate in rates.values()],
                    "Drops": [rate.drop_delta for rate in rates.values()],
                }
            ),
            hide_index=True,
            width="stretch",
        )

with st.expander("All network readings"):
    health_table(network.readings if network else [], "Sorted worst-first.")

read_only_notice()
