"""Security — listener inventory, exposure, IDS/IPS, and segmentation."""

from __future__ import annotations

import json
from typing import Any

import pandas as pd
import streamlit as st

from components.charts import magnitude_bar
from components.layout import health_table, page_header, read_only_notice
from components.theme import style
from config import EXPECTED_LISTENERS, get_settings
from core.runtime import get_snapshot
from core.status import Status
from services import unifi

settings = get_settings()
snapshot = get_snapshot()
security = snapshot.component("security")
raw = snapshot.raw.get("security", {})

page_header(
    "Security",
    "Listening services, external exposure, and network boundaries",
    snapshot.collected_at,
)

# Gather the read-only controller views once. These helpers are cached, so the
# five compact UI sections do not create duplicate controller requests.
controller_networks = []
network_error = ""
firewall_zones = []
zones_error = ""
firewall_policies = []
policies_error = ""
if settings.unifi.configured:
    unifi_args = (
        settings.unifi.controller_url,
        settings.unifi.api_key or "",
        settings.unifi.tls_verify,
        settings.unifi.site,
    )
    controller_networks, network_error = unifi.get_networks(*unifi_args)
    firewall_zones, zones_error = unifi.get_firewall_zones(*unifi_args)
    firewall_policies, policies_error = unifi.get_firewall_policies(*unifi_args)


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


def _show_api_collection(
    items: list[dict[str, Any]],
    error: str,
    columns: dict[str, str],
    *,
    key: str,
    empty: str,
) -> None:
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
        key=f"security_unifi_payload_{key}",
    ):
        st.json(safe_items, expanded=1)


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
        key=f"security_unifi_{key}_detail_selection",
    )
    if st.toggle(
        f"Load selected {label} detail",
        key=f"security_unifi_{key}_detail_load",
    ):
        detail, error = _api_detail(resource, selected)
        if error:
            st.warning(error)
        else:
            st.json(unifi.safe_for_display(detail), expanded=1)


# Listening services --------------------------------------------------------

listeners = raw.get("listeners") or []
unexpected = raw.get("unexpected_listeners") or []
exposed_listeners = [entry for entry in listeners if not entry.loopback_only]
listener_icon = ":material/warning:" if unexpected or not listeners else ":material/check_circle:"

with st.expander(
    f"{listener_icon} Listening services · {len(exposed_listeners)} network-facing · "
    f"{len(unexpected)} unexpected",
    expanded=bool(unexpected) or not listeners,
):
    if not listeners:
        st.warning(
            "`ss` could not be run, so local listeners are unknown.",
            icon=":material/warning:",
        )
    else:
        rows = []
        for entry in sorted(exposed_listeners, key=lambda item: item.port):
            expected_service = EXPECTED_LISTENERS.get(entry.port)
            rows.append(
                {
                    "Status": (
                        f"{style(Status.HEALTHY).icon} expected"
                        if expected_service is not None
                        else f"{style(Status.WARNING).icon} unexpected"
                    ),
                    "Port": entry.port,
                    "Address": entry.address,
                    "Service": expected_service or entry.process or "unidentified",
                }
            )
        st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
        st.caption(
            f"{len(exposed_listeners)} non-loopback listeners and "
            f"{len(listeners) - len(exposed_listeners)} loopback-only. Process "
            "names appear only for sockets owned by the unprivileged dashboard user."
        )
        if unexpected:
            st.warning(
                "Unexpected listeners: "
                + ", ".join(f"{entry.address}:{entry.port}" for entry in unexpected)
                + ". Identify them with `sudo ss -lntup`, then document or stop them.",
                icon=":material/warning:",
            )


# External exposure ---------------------------------------------------------

review_ports = [port for port in settings.external_ports if not port.expected]
exposure_icon = ":material/warning:" if review_ports else ":material/check_circle:"
with st.expander(
    f"{exposure_icon} External exposure · {len(settings.external_ports)} declared ports · "
    f"{len(review_ports)} need review",
    expanded=bool(review_ports),
):
    st.caption(
        "Declared Internet-facing ports. The dashboard does not scan the Internet; "
        "compare this inventory with UniFi NAT, port-forward, and UPnP rules."
    )
    exposure_rows = [
        {
            "Port": port.port,
            "Expected": "yes" if port.expected else "NEEDS REVIEW",
            "Service": port.service,
            "Note": port.note,
        }
        for port in settings.external_ports
    ]
    st.dataframe(pd.DataFrame(exposure_rows), hide_index=True, width="stretch")

    if review_ports:
        st.warning(
            "TCP 80 and 443 need review. Confirm the receiving service in UniFi "
            "port forwards, NAT rules, UPnP mappings, and the reverse proxy.",
            icon=":material/warning:",
        )
    st.info(
        "TCP 32400 (Plex) is Internet-facing and has previously attracted IDS/IPS "
        "scan traffic. Keep Plex patched and periodically reconsider direct exposure.",
        icon=":material/info:",
    )

    st.markdown("#### Live UniFi firewall policies")
    if not settings.unifi.configured:
        st.caption("Connect UniFi to compare the declared inventory with live rules.")
    elif policies_error:
        st.info(policies_error, icon=":material/cloud_off:")
    elif firewall_policies:
        st.dataframe(
            pd.DataFrame(
                [
                    {
                        "Name": policy.name,
                        "Action": policy.action or "—",
                        "Enabled": policy.enabled,
                        "Predefined": policy.predefined,
                        "Source": policy.source or "—",
                        "Destination": policy.destination or "—",
                    }
                    for policy in firewall_policies
                ]
            ),
            hide_index=True,
            width="stretch",
        )
        st.caption(
            "Rules are configuration, not traffic counters. The Integration API "
            "does not expose per-rule hit or block counts."
        )
    else:
        st.caption("The controller returned no firewall policies.")
    if settings.unifi.configured and st.toggle(
        "Load complete firewall-policy payload",
        key="security_firewall_policy_payload",
    ):
        raw_policies, raw_policies_error = _api_collection("firewall_policies")
        if raw_policies_error:
            st.warning(raw_policies_error)
        else:
            st.json(unifi.safe_for_display(raw_policies), expanded=1)
            _show_detail_selector(
                raw_policies,
                "firewall_policy",
                "firewall policy",
                key="firewall_policy",
            )


acl_panel = st.expander(
    ":material/rule: Access control rules",
    key="unifi_acl_panel",
    on_change="rerun",
)
if acl_panel.open:
    with acl_panel:
        if not settings.unifi.configured:
            st.caption("Connect UniFi to read live ACL rules.")
        else:
            acl_rules, acl_error = _api_collection("acl_rules")
            _show_api_collection(
                acl_rules,
                acl_error,
                {
                    "Order": "index",
                    "Name": "name",
                    "Description": "description",
                    "Type": "type",
                    "Enabled": "enabled",
                    "Action": "action",
                    "Protocols": "protocolFilter",
                    "Network": "networkId",
                    "Source": "sourceFilter",
                    "Destination": "destinationFilter",
                    "Enforcing devices": "enforcingDeviceFilter",
                },
                key="acl_rules",
                empty="The controller returned no ACL rules.",
            )
            _show_detail_selector(
                acl_rules,
                "acl_rule",
                "ACL rule",
                key="acl_rule",
            )


# Intrusion detection -------------------------------------------------------

unifi_state = raw.get("unifi")
events = raw.get("ids_events") or []
ids_supported = settings.unifi.configured and unifi.ids_available(settings.unifi)
if events:
    ids_icon, ids_summary = ":material/warning:", f"{len(events)} recent events"
elif ids_supported:
    ids_icon, ids_summary = ":material/check_circle:", "no recent events"
else:
    ids_icon, ids_summary = ":material/info:", "controller history unavailable"

with st.expander(
    f"{ids_icon} Intrusion detection · {ids_summary}",
    expanded=bool(events),
):
    if unifi_state is not None and not unifi_state.configured:
        st.info(
            "Without UniFi integration, IDS/IPS alerts, WAN blocks, and inter-VLAN "
            "denials cannot be shown. An empty list would be misleading.",
            icon=":material/settings:",
        )
        if unifi_state.steps:
            st.markdown("**Integration steps**")
            for index, step in enumerate(unifi_state.steps, start=1):
                st.markdown(f"{index}. {step}")
        st.caption("Source: UniFi")
    elif not ids_supported:
        st.info(
            "The Integration API does not expose IDS/IPS alarm history. Gateway, "
            "network, firewall-zone, and policy configuration remain available.",
            icon=":material/info:",
        )
        st.markdown(
            "**Review manually**\n\n"
            "1. Open Insights → Threat Management in the UniFi console.\n"
            "2. Pay particular attention to traffic targeting Plex on port 32400."
        )
        st.caption("Source: UniFi")
    elif not events:
        st.success("No recent IDS/IPS events.", icon=":material/check_circle:")
    else:
        st.dataframe(
            pd.DataFrame(
                [
                    {
                        "Time": event.get("datetime", ""),
                        "Source": event.get("src_ip", ""),
                        "Destination": event.get("dest_ip", ""),
                        "Port": event.get("dest_port", ""),
                        "Signature": event.get("signature", ""),
                        "Action": event.get("inner_alert_action", ""),
                    }
                    for event in events
                ]
            ),
            hide_index=True,
            width="stretch",
        )


# Network segmentation ------------------------------------------------------

configured_by_vlan = {vlan.vlan_id: vlan for vlan in settings.vlans}
controller_by_vlan = {
    network.vlan_id: network
    for network in controller_networks
    if network.vlan_id is not None
}
drifted_vlans = [
    vlan_id
    for vlan_id, configured in configured_by_vlan.items()
    if vlan_id in controller_by_vlan
    and controller_by_vlan[vlan_id].name != configured.name
]
segmentation_icon = ":material/warning:" if drifted_vlans else ":material/lan:"
with st.expander(
    f"{segmentation_icon} Network segmentation · {len(settings.vlans)} documented VLANs · "
    f"{len(controller_networks)} live networks · {len(drifted_vlans)} name drifts",
    expanded=bool(drifted_vlans),
):
    st.dataframe(
        pd.DataFrame(
            {
                "VLAN": [vlan.vlan_id for vlan in settings.vlans],
                "Documented name": [vlan.name for vlan in settings.vlans],
                "Live name": [
                    controller_by_vlan[vlan.vlan_id].name
                    if vlan.vlan_id in controller_by_vlan
                    else "—"
                    for vlan in settings.vlans
                ],
                "Subnet": [
                    controller_by_vlan[vlan.vlan_id].subnet
                    if vlan.vlan_id in controller_by_vlan
                    and controller_by_vlan[vlan.vlan_id].subnet
                    else vlan.subnet
                    for vlan in settings.vlans
                ],
                "Purpose": [
                    controller_by_vlan[vlan.vlan_id].purpose or "—"
                    if vlan.vlan_id in controller_by_vlan
                    else "—"
                    for vlan in settings.vlans
                ],
                "Intent": [
                    "trusted" if vlan.trusted else "restricted"
                    for vlan in settings.vlans
                ],
            }
        ),
        hide_index=True,
        width="stretch",
    )
    if network_error:
        st.caption(f"Live controller networks unavailable: {network_error}")
    if drifted_vlans:
        st.warning(
            "Controller names differ from the documented configuration for VLAN(s): "
            + ", ".join(str(vlan_id) for vlan_id in drifted_vlans),
            icon=":material/warning:",
        )
    st.caption(
        "This server sits in Media-DMZ (VLAN 40). It should have no unrestricted "
        "path into Management (VLAN 50), while Management retains access inward."
    )


policy_panel = st.expander(
    ":material/policy: DNS and traffic policies",
    key="unifi_dns_traffic_panel",
    on_change="rerun",
)
if policy_panel.open:
    with policy_panel:
        if not settings.unifi.configured:
            st.caption("Connect UniFi to read DNS and traffic-matching policies.")
        else:
            dns_policies, dns_error = _api_collection("dns_policies")
            st.markdown("**DNS policies**")
            _show_api_collection(
                dns_policies,
                dns_error,
                {
                    "Type": "type",
                    "Enabled": "enabled",
                    "Domain": "domain",
                    "IPv4": "ipv4Address",
                    "IPv6": "ipv6Address",
                    "Target": "targetDomain",
                    "Server": "serverDomain",
                    "Port": "port",
                    "TTL": "ttlSeconds",
                },
                key="dns_policies",
                empty="The controller returned no DNS policies.",
            )
            _show_detail_selector(
                dns_policies,
                "dns_policy",
                "DNS policy",
                key="dns_policy",
            )

            matching_lists, matching_error = _api_collection(
                "traffic_matching_lists"
            )
            st.markdown("**Traffic matching lists**")
            _show_api_collection(
                matching_lists,
                matching_error,
                {"Name": "name", "Type": "type", "ID": "id"},
                key="traffic_matching_lists",
                empty="The controller returned no traffic matching lists.",
            )
            matching_options = {
                str(item.get("id")): str(item.get("name") or item.get("id"))
                for item in matching_lists
                if item.get("id")
            }
            if matching_options:
                selected_matching_list = st.selectbox(
                    "Inspect traffic matching list",
                    list(matching_options),
                    format_func=matching_options.get,
                    key="unifi_matching_list_selection",
                )
                if st.toggle(
                    "Load selected matching-list detail",
                    key="unifi_matching_list_detail_load",
                ):
                    matching_detail, matching_detail_error = unifi.get_api_detail(
                        settings.unifi.controller_url,
                        settings.unifi.api_key or "",
                        settings.unifi.tls_verify,
                        settings.unifi.site,
                        "traffic_matching_list",
                        selected_matching_list,
                    )
                    if matching_detail_error:
                        st.warning(matching_detail_error)
                    else:
                        st.json(
                            unifi.safe_for_display(matching_detail),
                            expanded=1,
                        )


# Live firewall zones -------------------------------------------------------

zone_icon = ":material/shield:" if firewall_zones else ":material/info:"
with st.expander(
    f"{zone_icon} Live firewall zones · "
    f"{len(firewall_zones) if settings.unifi.configured else 'UniFi not connected'}",
    expanded=False,
):
    if not settings.unifi.configured:
        st.caption(
            "Connect UniFi in Admin → API keys to verify live zone membership."
        )
    elif zones_error:
        st.warning(f"Firewall zones unavailable: {zones_error}")
    elif firewall_zones:
        id_to_network = {
            network.network_id: network.name for network in controller_networks
        }
        zone_rows = []
        for zone in sorted(firewall_zones, key=lambda item: item.name.lower()):
            members = [
                id_to_network.get(network_id, network_id[:8])
                for network_id in zone.network_ids
            ]
            zone_rows.append(
                {
                    "Zone": zone.name,
                    "Networks": ", ".join(members) if members else "—",
                    "Count": len(zone.network_ids),
                }
            )
        st.dataframe(pd.DataFrame(zone_rows), hide_index=True, width="stretch")
        zone_chart = magnitude_bar(
            [row["Zone"] for row in zone_rows],
            [float(row["Count"]) for row in zone_rows],
            "Networks in zone",
        )
        if zone_chart is not None:
            st.altair_chart(zone_chart, width="stretch")
        st.caption(
            "Confirm that Media-DMZ and Management remain in separate zones. "
            "Zone membership is live controller data, not a rule-hit counter."
        )
    else:
        st.caption("The controller returned no firewall zones.")
    if settings.unifi.configured and st.toggle(
        "Load complete firewall-zone payload",
        key="security_firewall_zone_payload",
    ):
        raw_zones, raw_zones_error = _api_collection("firewall_zones")
        if raw_zones_error:
            st.warning(raw_zones_error)
        else:
            st.json(unifi.safe_for_display(raw_zones), expanded=1)
            _show_detail_selector(
                raw_zones,
                "firewall_zone",
                "firewall zone",
                key="firewall_zone",
            )


with st.expander("All security readings"):
    health_table(security.readings if security else [])
read_only_notice()
