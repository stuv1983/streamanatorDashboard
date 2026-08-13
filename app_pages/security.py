"""Security — listener inventory, external exposure and IDS/IPS.

The external-exposure section makes a deliberate distinction between "expected"
and "detected". It does not scan the Internet: probing is explicit, configured
and limited to the small list of ports already believed to be published.
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

from components.cards import not_configured_card
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
    "Listening services, external exposure and intrusion events",
    snapshot.collected_at,
)

# ---------------------------------------------------------------------------
# Local listeners
# ---------------------------------------------------------------------------

st.markdown("### Listening services")

listeners = raw.get("listeners") or []
unexpected = raw.get("unexpected_listeners") or []

if not listeners:
    st.warning(
        "`ss` could not be run, so local listeners are unknown.",
        icon=":material/warning:",
    )
else:
    exposed = [entry for entry in listeners if not entry.loopback_only]
    rows = []
    for entry in sorted(exposed, key=lambda e: e.port):
        expected_service = EXPECTED_LISTENERS.get(entry.port)
        is_expected = expected_service is not None
        rows.append(
            {
                "Status": (
                    f"{style(Status.HEALTHY).icon} expected"
                    if is_expected
                    else f"{style(Status.WARNING).icon} unexpected"
                ),
                "Port": entry.port,
                "Address": entry.address,
                "Service": expected_service or (entry.process or "unidentified"),
            }
        )
    st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
    st.caption(
        f":gray[{len(exposed)} non-loopback listeners, "
        f"{len(listeners) - len(exposed)} loopback-only. Process names appear only "
        f"for sockets owned by the dashboard user — the dashboard runs "
        f"unprivileged by design.]"
    )

    if unexpected:
        st.warning(
            "Unexpected listeners: "
            + ", ".join(f"{e.address}:{e.port}" for e in unexpected)
            + ". Identify them with `sudo ss -lntup`, then either add them to "
            "`EXPECTED_LISTENERS` in config.py or shut them down.",
            icon=":material/warning:",
        )

# ---------------------------------------------------------------------------
# External exposure
# ---------------------------------------------------------------------------

st.markdown("### External exposure")

st.caption(
    "Ports believed reachable from the Internet. The dashboard does not perform "
    "outbound port scanning; this is a declared inventory that should be checked "
    "against the UniFi port-forward and NAT rules."
)

exposure_rows = []
for port in settings.external_ports:
    exposure_rows.append(
        {
            "Port": port.port,
            "Expected": "yes" if port.expected else "NEEDS REVIEW",
            "Service": port.service,
            "Note": port.note,
        }
    )
st.dataframe(pd.DataFrame(exposure_rows), hide_index=True, width="stretch")

st.warning(
    "**TCP 80 and 443 need review.** Both were observed open from the Internet, "
    "but the receiving service is undocumented. Audit the UniFi port forwards, "
    "NAT rules, UPnP-created mappings and any reverse proxy before treating them "
    "as intentional.",
    icon=":material/warning:",
)

st.info(
    "**TCP 32400 (Plex) is Internet-facing** and has previously attracted IDS/IPS "
    "scanning traffic from CINS Army, DShield and ET SCAN feeds. Keep Plex "
    "patched and periodically reconsider whether direct exposure is still needed "
    "versus relaying through Plex's own remote access.",
    icon=":material/info:",
)

# ---------------------------------------------------------------------------
# IDS / IPS
# ---------------------------------------------------------------------------

st.markdown("### Intrusion detection")

unifi_state = raw.get("unifi")
if unifi_state is not None and not unifi_state.configured:
    not_configured_card(
        "UniFi IDS/IPS events",
        "Without UniFi integration the dashboard cannot show IDS/IPS alerts, "
        "blocked WAN connections, inter-VLAN firewall denials or per-client "
        "traffic. An empty list here would be misleading, so nothing is shown.",
        steps=unifi_state.steps,
        source="unifi",
    )
elif not unifi.ids_available(settings.unifi):
    not_configured_card(
        "UniFi IDS/IPS events",
        "UniFi is connected, but IDS/IPS alarm history is only exposed by the "
        "legacy controller API, which needs an interactive login that this "
        "account's MFA blocks. Gateway health and client counts work; alarm "
        "history does not. Review IDS/IPS events in the UniFi console itself.",
        steps=(
            "In the UniFi console: Insights → Threat Management, or "
            "Settings → Security, to review IDS/IPS events.",
            "Pay particular attention to traffic aimed at 10.0.40.100:32400 "
            "(Plex), which has previously attracted scanning.",
        ),
        source="unifi",
    )
else:
    events = raw.get("ids_events") or []
    if not events:
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

# ---------------------------------------------------------------------------
# Segmentation
# ---------------------------------------------------------------------------

st.markdown("### Network segmentation")

st.dataframe(
    pd.DataFrame(
        {
            "VLAN": [v.vlan_id for v in settings.vlans],
            "Name": [v.name for v in settings.vlans],
            "Subnet": [v.subnet for v in settings.vlans],
            "Zone": ["trusted" if v.trusted else "restricted" for v in settings.vlans],
        }
    ),
    hide_index=True,
    width="stretch",
)

st.caption(
    ":gray[This server sits in the Media-DMZ (VLAN 40), which hosts the "
    "Internet-reachable services. The intended policy is that Media-DMZ has no "
    "unrestricted path into Management (VLAN 50), while Management retains "
    "administrative access inward.]"
)

# -- Live firewall zones, when UniFi is connected -------------------------
#
# Zones rather than policies: the policies endpoint 500s on the live firmware,
# and zones already answer the question segmentation is *for* — which networks
# share a trust boundary. Reading them from the controller turns "the intended
# policy is…" into "the controller currently reports…".
if settings.unifi.configured:
    from services import unifi as unifi_service

    zones, zones_error = unifi_service.get_firewall_zones(
        settings.unifi.controller_url,
        settings.unifi.api_key or "",
        settings.unifi.verify_tls,
        settings.unifi.site,
    )
    networks, _ = unifi_service.get_networks(
        settings.unifi.controller_url,
        settings.unifi.api_key or "",
        settings.unifi.verify_tls,
        settings.unifi.site,
    )
    id_to_network = {n.network_id: n.name for n in networks}

    st.markdown("#### Live firewall zones")
    if zones_error:
        st.caption(f":gray[Firewall zones unavailable: {zones_error}]")
    elif zones:
        zone_rows = []
        for zone in sorted(zones, key=lambda z: z.name.lower()):
            members = [
                id_to_network.get(nid, nid[:8]) for nid in zone.network_ids
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
            ":gray[Read live from the controller. Confirm Media-DMZ and "
            "Management sit in different zones, and that no zone silently "
            "merges the two. This shows the zone membership, not the "
            "rule-by-rule policy between zones — the policies endpoint is "
            "erroring on the current UniFi firmware.]"
        )
else:
    st.caption(
        ":gray[Connect UniFi (Admin → API keys) to read the live zone-based "
        "firewall configuration and confirm it still matches this intent.]"
    )

st.divider()
health_table(security.readings if security else [])
read_only_notice()
