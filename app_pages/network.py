"""Network — Internet health plus compact, drillable UniFi telemetry."""

from __future__ import annotations

import json
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

    safe_objects = unifi.safe_for_display(objects)
    for index, item in enumerate(safe_objects, start=1):
        label = str(item.get("name") or item.get("interface") or f"WAN {index}")
        walk(label, item)
    return rows


def _nested_value(item: dict[str, Any], path: str) -> Any:
    value: Any = item
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _display_value(value: Any) -> Any:
    if value is None or value == "":
        return "—"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return value


def _show_api_collection(
    items: list[dict[str, Any]],
    error: str,
    columns: dict[str, str],
    *,
    key: str,
    empty: str,
) -> None:
    """Render a safe summary plus the complete credential-redacted payload."""
    if error:
        st.warning(error, icon=":material/cloud_off:")
        return
    if not items:
        st.caption(empty)
        return
    safe_items = unifi.safe_for_display(items)
    st.dataframe(
        pd.DataFrame(
            [
                {
                    label: _display_value(_nested_value(item, path))
                    for label, path in columns.items()
                }
                for item in safe_items
            ]
        ),
        hide_index=True,
        width="stretch",
    )
    if st.toggle(
        "Show complete API payload (credentials redacted)",
        key=f"unifi_payload_{key}",
    ):
        st.json(safe_items, expanded=1)


def _api_collection(resource: str) -> tuple[list[dict[str, Any]], str]:
    return unifi.get_api_collection(
        settings.unifi.controller_url,
        settings.unifi.api_key or "",
        settings.unifi.tls_verify,
        settings.unifi.site,
        resource,
    )


def _api_detail(resource: str, resource_id: str) -> tuple[dict[str, Any], str]:
    return unifi.get_api_detail(
        settings.unifi.controller_url,
        settings.unifi.api_key or "",
        settings.unifi.tls_verify,
        settings.unifi.site,
        resource,
        resource_id,
    )


def _show_detail_selector(
    items: list[dict[str, Any]],
    resource: str,
    label: str,
    *,
    key: str,
) -> None:
    options = {
        str(item.get("id")): str(item.get("name") or item.get("id"))
        for item in items
        if item.get("id")
    }
    if not options:
        return
    selected = st.selectbox(
        f"Inspect {label}",
        list(options),
        format_func=options.get,
        key=f"unifi_{key}_detail_selection",
    )
    if st.toggle(
        f"Load selected {label} detail",
        key=f"unifi_{key}_detail_load",
    ):
        detail, error = _api_detail(resource, selected)
        if error:
            st.warning(error)
        else:
            st.json(unifi.safe_for_display(detail), expanded=1)


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
            settings.unifi.tls_verify,
        )
        live_networks, networks_error = unifi.get_networks(
            settings.unifi.controller_url,
            settings.unifi.api_key,
            settings.unifi.tls_verify,
            settings.unifi.site,
        )
        wans, wans_error = unifi.get_wans(
            settings.unifi.controller_url,
            settings.unifi.api_key,
            settings.unifi.tls_verify,
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

        if gateway_device and gateway_device.ports:
            st.markdown("**Gateway ports**")
            st.dataframe(
                pd.DataFrame(
                    [
                        {
                            "Port": port.index,
                            "State": port.state or "—",
                            "Connector": port.connector or "—",
                            "Speed": (
                                f"{port.speed_mbps:,} Mbps"
                                if port.speed_mbps is not None
                                else "—"
                            ),
                            "PoE": port.poe_state or "—",
                        }
                        for port in gateway_device.ports
                    ]
                ),
                hide_index=True,
                width="stretch",
            )
        if gateway_device and gateway_device.device_id:
            if st.toggle(
                "Load complete gateway API detail",
                key="unifi_gateway_detail",
            ):
                gateway_detail, gateway_detail_error = _api_detail(
                    "device", gateway_device.device_id
                )
                if gateway_detail_error:
                    st.caption(f"Gateway detail unavailable: {gateway_detail_error}")
                elif gateway_detail:
                    st.json(unifi.safe_for_display(gateway_detail), expanded=1)

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
                device_panel = st.expander(
                    f"{icon} {device.name or device.model} · {device.role} · "
                    f"{device.model or 'unknown model'} · {device.ip_address or 'no IP'}"
                    f"{update}",
                    expanded=not device.online,
                    key=f"unifi_device_{device.device_id or device.mac}",
                    on_change="rerun",
                )
                if device_panel.open:
                    with device_panel:
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
                                delta=(
                                    "update available"
                                    if device.firmware_updatable
                                    else None
                                ),
                                delta_color="off",
                            )
                        st.dataframe(
                            pd.DataFrame(
                                [
                                    {
                                        "Property": "Device ID",
                                        "Value": device.device_id or "—",
                                    },
                                    {
                                        "Property": "Type",
                                        "Value": device.device_type or device.role,
                                    },
                                    {
                                        "Property": "MAC address",
                                        "Value": device.mac or "—",
                                    },
                                    {
                                        "Property": "Supported",
                                        "Value": (
                                            "yes"
                                            if device.supported is True
                                            else "no"
                                            if device.supported is False
                                            else "—"
                                        ),
                                    },
                                    {
                                        "Property": "Adopted",
                                        "Value": device.adopted_at or "—",
                                    },
                                    {
                                        "Property": "Provisioned",
                                        "Value": device.provisioned_at or "—",
                                    },
                                    {
                                        "Property": "Configuration ID",
                                        "Value": device.configuration_id or "—",
                                    },
                                    {
                                        "Property": "Uplink device",
                                        "Value": device.uplink_device_id or "—",
                                    },
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
                        if device.ports:
                            st.markdown("**Physical ports**")
                            st.dataframe(
                                pd.DataFrame(
                                    [
                                        {
                                            "Port": port.index,
                                            "State": port.state or "—",
                                            "Connector": port.connector or "—",
                                            "Speed": (
                                                f"{port.speed_mbps:,} Mbps"
                                                if port.speed_mbps is not None
                                                else "—"
                                            ),
                                            "Maximum": (
                                                f"{port.max_speed_mbps:,} Mbps"
                                                if port.max_speed_mbps is not None
                                                else "—"
                                            ),
                                            "PoE": (
                                                "enabled"
                                                if port.poe_enabled is True
                                                else "disabled"
                                                if port.poe_enabled is False
                                                else "—"
                                            ),
                                            "PoE state": port.poe_state or "—",
                                            "PoE standard": port.poe_standard or "—",
                                        }
                                        for port in device.ports
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
                                            "Standard": radio.wlan_standard or "—",
                                            "Channel": radio.channel or "—",
                                            "Width": (
                                                f"{radio.channel_width_mhz} MHz"
                                                if radio.channel_width_mhz is not None
                                                else "—"
                                            ),
                                            "TX retries": format_percent(
                                                radio.tx_retries_percent
                                            ),
                                        }
                                        for radio in device.radios
                                    ]
                                ),
                                hide_index=True,
                                width="stretch",
                            )
                        if device.device_id:
                            if st.toggle(
                                "Load complete device API detail",
                                key=f"unifi_device_detail_{device.device_id}",
                            ):
                                detail, detail_error = _api_detail(
                                    "device", device.device_id
                                )
                                if detail_error:
                                    st.caption(
                                        f"Device detail unavailable: {detail_error}"
                                    )
                                elif detail:
                                    st.json(
                                        unifi.safe_for_display(detail),
                                        expanded=1,
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
        selectable_networks = {
            definition.network_id: (
                f"{definition.name} · VLAN {definition.vlan_id}"
                if definition.vlan_id is not None
                else definition.name
            )
            for definition in live_networks
            if definition.network_id
        }
        if selectable_networks:
            selected_network = st.selectbox(
                "Inspect network",
                list(selectable_networks),
                format_func=selectable_networks.get,
                key="unifi_network_detail_selection",
            )
            if st.toggle(
                "Load selected network detail and references",
                key="unifi_network_detail_load",
            ):
                network_detail, detail_error = _api_detail(
                    "network", selected_network
                )
                references, references_error = _api_detail(
                    "network_references", selected_network
                )
                if detail_error:
                    st.warning(detail_error)
                else:
                    st.markdown("**Network detail**")
                    st.json(unifi.safe_for_display(network_detail), expanded=1)
                if references_error:
                    st.caption(f"Network references unavailable: {references_error}")
                elif references:
                    st.markdown("**Network references**")
                    st.json(unifi.safe_for_display(references), expanded=1)

    pending_panel = st.expander(
        ":material/add_to_queue: Devices pending adoption",
        key="unifi_pending_devices_panel",
        on_change="rerun",
    )
    if pending_panel.open:
        with pending_panel:
            pending_devices, pending_error = _api_collection("pending_devices")
            _show_api_collection(
                pending_devices,
                pending_error,
                {
                    "Model": "model",
                    "State": "state",
                    "IP address": "ipAddress",
                    "MAC address": "macAddress",
                    "Supported": "supported",
                    "Firmware": "firmwareVersion",
                    "Update available": "firmwareUpdatable",
                    "Features": "features",
                },
                key="pending_devices",
                empty="No devices are waiting for adoption.",
            )

    clients_panel = st.expander(
        ":material/devices: Connected clients",
        key="unifi_clients_panel",
        on_change="rerun",
    )
    if clients_panel.open:
        with clients_panel:
            clients, clients_error = _api_collection("clients")
            _show_api_collection(
                clients,
                clients_error,
                {
                    "Name": "name",
                    "Type": "type",
                    "IP address": "ipAddress",
                    "MAC address": "macAddress",
                    "Connected at": "connectedAt",
                    "Access": "access.type",
                    "Authorized": "access.authorized",
                    "Uplink device": "uplinkDeviceId",
                },
                key="clients",
                empty="The controller reports no connected clients.",
            )
            st.caption(
                "The official client endpoint exposes identity, connection type, "
                "access state, and uplink. It does not expose per-client bandwidth "
                "counters on this API version."
            )
            client_options = {
                str(client.get("id")): str(
                    client.get("name")
                    or client.get("ipAddress")
                    or client.get("macAddress")
                    or client.get("id")
                )
                for client in clients
                if client.get("id")
            }
            if client_options:
                selected_client = st.selectbox(
                    "Inspect client",
                    list(client_options),
                    format_func=client_options.get,
                    key="unifi_client_detail_selection",
                )
                if st.toggle(
                    "Load selected client detail",
                    key="unifi_client_detail_load",
                ):
                    client_detail, client_detail_error = _api_detail(
                        "client", selected_client
                    )
                    if client_detail_error:
                        st.warning(client_detail_error)
                    else:
                        st.json(
                            unifi.safe_for_display(client_detail),
                            expanded=1,
                        )

    wifi_panel = st.expander(
        ":material/wifi: WiFi broadcasts",
        key="unifi_wifi_panel",
        on_change="rerun",
    )
    if wifi_panel.open:
        with wifi_panel:
            broadcasts, broadcasts_error = _api_collection("wifi_broadcasts")
            _show_api_collection(
                broadcasts,
                broadcasts_error,
                {
                    "Name": "name",
                    "Type": "type",
                    "Enabled": "enabled",
                    "Frequencies": "broadcastingFrequenciesGHz",
                    "Network": "network",
                    "Security": "securityConfiguration.type",
                    "Device filter": "broadcastingDeviceFilter",
                    "Hotspot": "hotspotConfiguration.type",
                },
                key="wifi_broadcasts",
                empty="No WiFi broadcasts were returned.",
            )
            broadcast_options = {
                str(item.get("id")): str(item.get("name") or item.get("id"))
                for item in broadcasts
                if item.get("id")
            }
            if broadcast_options:
                selected_broadcast = st.selectbox(
                    "Inspect WiFi broadcast",
                    list(broadcast_options),
                    format_func=broadcast_options.get,
                    key="unifi_wifi_detail_selection",
                )
                if st.toggle(
                    "Load selected WiFi detail",
                    key="unifi_wifi_detail_load",
                ):
                    wifi_detail, wifi_detail_error = _api_detail(
                        "wifi_broadcast", selected_broadcast
                    )
                    if wifi_detail_error:
                        st.warning(wifi_detail_error)
                    else:
                        st.json(unifi.safe_for_display(wifi_detail), expanded=1)

    switching_panel = st.expander(
        ":material/cable: Switching topology",
        key="unifi_switching_panel",
        on_change="rerun",
    )
    if switching_panel.open:
        with switching_panel:
            for resource, title, columns in (
                (
                    "lags",
                    "Link aggregation groups",
                    {"ID": "id", "Type": "type", "Members": "members"},
                ),
                (
                    "mc_lag_domains",
                    "MC-LAG domains",
                    {"Name": "name", "Peers": "peers", "LAGs": "lags"},
                ),
                (
                    "switch_stacks",
                    "Switch stacks",
                    {"Name": "name", "Members": "members", "LAGs": "lags"},
                ),
            ):
                st.markdown(f"**{title}**")
                items, error = _api_collection(resource)
                _show_api_collection(
                    items,
                    error,
                    columns,
                    key=resource,
                    empty=f"No {title.lower()} were returned.",
                )
                detail_resource = {
                    "lags": "lag",
                    "mc_lag_domains": "mc_lag_domain",
                    "switch_stacks": "switch_stack",
                }[resource]
                _show_detail_selector(
                    items,
                    detail_resource,
                    title.removesuffix("s").lower(),
                    key=resource,
                )

    vpn_panel = st.expander(
        ":material/vpn_lock: UniFi VPN configuration",
        key="unifi_vpn_panel",
        on_change="rerun",
    )
    if vpn_panel.open:
        with vpn_panel:
            for resource, title in (
                ("vpn_servers", "VPN servers"),
                ("site_to_site_vpn_tunnels", "Site-to-site VPN tunnels"),
            ):
                st.markdown(f"**{title}**")
                items, error = _api_collection(resource)
                _show_api_collection(
                    items,
                    error,
                    {
                        "Name": "name",
                        "Type": "type",
                        "Enabled": "enabled",
                        "Origin": "metadata.origin",
                        "Source": "metadata.source",
                    },
                    key=resource,
                    empty=f"No {title.lower()} were returned.",
                )

    resources_panel = st.expander(
        ":material/category: Controller resources",
        key="unifi_resources_panel",
        on_change="rerun",
    )
    if resources_panel.open:
        with resources_panel:
            for resource, title, columns in (
                (
                    "sites",
                    "Local sites",
                    {
                        "Name": "name",
                        "Internal reference": "internalReference",
                        "ID": "id",
                    },
                ),
                (
                    "device_tags",
                    "Device tags",
                    {"Name": "name", "Devices": "deviceIds", "Origin": "metadata.origin"},
                ),
                (
                    "radius_profiles",
                    "RADIUS profiles",
                    {"Name": "name", "Origin": "metadata.origin"},
                ),
                (
                    "dpi_categories",
                    "DPI application categories",
                    {"ID": "id", "Name": "name"},
                ),
                (
                    "dpi_applications",
                    "DPI applications",
                    {"ID": "id", "Name": "name", "Category": "categoryId"},
                ),
            ):
                st.markdown(f"**{title}**")
                items, error = _api_collection(resource)
                _show_api_collection(
                    items,
                    error,
                    columns,
                    key=resource,
                    empty=f"No {title.lower()} were returned.",
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
