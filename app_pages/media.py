"""Media — Plex, Immich, and the download/indexer stack."""

from __future__ import annotations

import pandas as pd
import streamlit as st

from components.cards import metric_card, reading_card
from components.layout import page_header, read_only_notice
from components.theme import style
from config import get_settings
from core.runtime import get_snapshot
from core.status import Status
from services.apps import (
    get_arr_status,
    get_immich_status,
    get_plex_status,
    get_qbittorrent_status,
    get_sabnzbd_status,
)
from utils.formatting import human_bytes, human_bytes_per_second

settings = get_settings()
snapshot = get_snapshot()
applications = snapshot.component("applications")

page_header(
    "Media",
    "Plex, Immich, and the VPN-routed download stack",
    snapshot.collected_at,
)


def _probe_reading(key: str):
    if applications is None:
        return None
    return next((r for r in applications.readings if r.key == f"probe.{key}"), None)


def _state_label(reachable: bool | None, configured: bool = True) -> tuple[str, str]:
    if not configured:
        return ":material/settings_alert:", "Not configured"
    if reachable is True:
        return ":material/check_circle:", "Up"
    if reachable is False:
        return ":material/error:", "Down"
    return ":material/help:", "Unknown"


# Plex ----------------------------------------------------------------------

plex_endpoint = settings.endpoint("plex")
plex_base = plex_endpoint.url.replace("/identity", "") if plex_endpoint else ""
plex = get_plex_status(plex_base, settings.api.plex_token)
plex_icon, plex_state = _state_label(plex.reachable, plex.configured)
plex_summary = (
    f"{plex_icon} Plex · {plex_state} · {plex.stream_count or 0} active streams"
    f" · {plex.version or 'version unknown'}"
)

with st.expander(plex_summary, expanded=plex.reachable is False):
    st.caption(
        "Runs as the native `plexmediaserver.service` on this host; the old Plex "
        "container is not the live instance."
    )
    columns = st.columns(5)
    for column, (label, value) in zip(
        columns,
        (
            ("Availability", plex_state),
            ("Version", plex.version or "—"),
            ("Active streams", str(plex.stream_count) if plex.reachable else "—"),
            ("Transcodes", str(plex.transcode_count) if plex.reachable else "—"),
            ("Remote streams", str(plex.remote_count) if plex.reachable else "—"),
        ),
    ):
        with column:
            metric_card(label, value)

    if not plex.configured:
        st.info(
            "PLEX_TOKEN is not set. Availability and version remain visible, but "
            "session, transcode, and bandwidth details are unavailable.",
            icon=":material/settings:",
        )
        st.markdown(
            "**To enable session detail**\n\n"
            "1. Obtain a token from the Plex support instructions.\n"
            "2. Add `PLEX_TOKEN` through the dashboard admin settings."
        )
        st.caption("Source: Plex API")
    elif plex.sessions:
        st.dataframe(
            pd.DataFrame(
                {
                    "User": [session.user for session in plex.sessions],
                    "Title": [session.title for session in plex.sessions],
                    "Player": [session.player for session in plex.sessions],
                    "Decision": [session.decision for session in plex.sessions],
                    "Location": [
                        "local" if session.local else "remote"
                        for session in plex.sessions
                    ],
                    "Bandwidth": [
                        f"{session.bandwidth_kbps:,.0f} kbps"
                        if session.bandwidth_kbps
                        else "—"
                        for session in plex.sessions
                    ],
                }
            ),
            hide_index=True,
            width="stretch",
        )
    elif plex.reachable:
        st.caption("No active streams.")
    if plex.error:
        st.caption(f":gray[{plex.error}]")


# Immich --------------------------------------------------------------------

immich_endpoint = settings.endpoint("immich")
immich_base = (
    immich_endpoint.url.replace("/api/server/ping", "") if immich_endpoint else ""
)
immich = get_immich_status(immich_base)
container_readings = [
    reading
    for reading in (applications.readings if applications else [])
    if reading.key.startswith("container.immich")
]
healthy_containers = sum(
    1 for reading in container_readings if reading.status is Status.HEALTHY
)
immich_icon, immich_state = _state_label(immich.reachable)

with st.expander(
    f"{immich_icon} Immich · {immich_state} · "
    f"{healthy_containers}/{len(container_readings)} containers healthy · "
    f"{immich.version or 'version unknown'}",
    expanded=immich.reachable is False,
):
    storage = immich.detail.get("storage", {})
    columns = st.columns(4)
    values = (
        ("API", immich_state),
        ("Version", immich.version or "—"),
        ("Containers healthy", f"{healthy_containers} / {len(container_readings)}"),
        (
            "Library size",
            human_bytes(storage.get("diskUse"))
            if isinstance(storage, dict) and storage.get("diskUse")
            else "—",
        ),
    )
    for column, (label, value) in zip(columns, values):
        with column:
            metric_card(label, value)
    if container_readings:
        st.dataframe(
            pd.DataFrame(
                {
                    "Status": [
                        f"{style(reading.status).icon} {reading.status.value}"
                        for reading in container_readings
                    ],
                    "Component": [reading.label for reading in container_readings],
                    "State": [str(reading.value) for reading in container_readings],
                    "Detail": [reading.detail for reading in container_readings],
                }
            ),
            hide_index=True,
            width="stretch",
        )


# Download and indexer stack ------------------------------------------------

st.markdown("### Download & indexer stack")
vpn_component = snapshot.component("vpn")
if vpn_component is not None and vpn_component.status is not Status.HEALTHY:
    st.warning(
        "These services route through Gluetun, and the tunnel is not healthy. "
        "Check the VPN page before troubleshooting them individually.",
        icon=":material/vpn_lock:",
    )

sab_endpoint = settings.endpoint("sabnzbd")
sab = get_sabnzbd_status(
    sab_endpoint.url if sab_endpoint else "", settings.api.sabnzbd_api_key
)
sab_icon, sab_state = _state_label(sab.reachable, sab.configured)
with st.expander(
    f"{sab_icon} SABnzbd · {sab_state} · {sab.queue_size or 0} queued · "
    f"{human_bytes_per_second(sab.speed_bytes_per_sec)}",
    expanded=sab.reachable is False and sab.configured,
):
    if not sab.configured:
        st.caption(
            "SABNZBD_API_KEY is not set. Availability is still probed, but queue, "
            "speed, and disk-space detail are unavailable."
        )
        reading = _probe_reading("sabnzbd")
        if reading:
            reading_card(reading)
    elif not sab.reachable:
        st.error(f"SABnzbd API error: {sab.error}", icon=":material/error:")
    else:
        columns = st.columns(5)
        values = (
            ("State", "Paused" if sab.paused else "Active"),
            ("Speed", human_bytes_per_second(sab.speed_bytes_per_sec)),
            ("Queue", str(sab.queue_size) if sab.queue_size is not None else "—"),
            (
                "Remaining",
                f"{sab.remaining_mb / 1024:.1f} GB" if sab.remaining_mb else "—",
            ),
            ("Free space", f"{sab.disk_free_gb:.0f} GB" if sab.disk_free_gb else "—"),
        )
        for column, (label, value) in zip(columns, values):
            with column:
                metric_card(label, value)
        if sab.current_job:
            st.caption(f"Current job: {sab.current_job}")

qbit_endpoint = settings.endpoint("qbittorrent")
qbit = get_qbittorrent_status(
    qbit_endpoint.url if qbit_endpoint else "",
    settings.api.qbittorrent_user,
    settings.api.qbittorrent_password,
)
qbit_icon, qbit_state = _state_label(qbit.reachable)
with st.expander(
    f"{qbit_icon} qBittorrent · {qbit_state} · {qbit.total_torrents or 0} torrents · "
    f"{qbit.errored or 0} errors",
    expanded=qbit.reachable is False or bool(qbit.errored),
):
    if not qbit.reachable:
        st.caption(qbit.error or "Not reachable.")
        reading = _probe_reading("qbittorrent")
        if reading:
            reading_card(reading)
    else:
        columns = st.columns(6)
        values = (
            ("Download", human_bytes_per_second(qbit.download_bytes_per_sec)),
            ("Upload", human_bytes_per_second(qbit.upload_bytes_per_sec)),
            ("Torrents", str(qbit.total_torrents or 0)),
            ("Downloading", str(qbit.downloading or 0)),
            ("Seeding", str(qbit.seeding or 0)),
            ("Errored", str(qbit.errored or 0)),
        )
        for column, (label, value) in zip(columns, values):
            with column:
                metric_card(label, value)
        if qbit.errored:
            st.warning(f"{qbit.errored} torrent(s) are in an error state.")

for key, display, api_key in (
    ("sonarr", "Sonarr", settings.api.sonarr_api_key),
    ("radarr", "Radarr", settings.api.radarr_api_key),
    ("prowlarr", "Prowlarr", settings.api.prowlarr_api_key),
):
    endpoint = settings.endpoint(key)
    base = endpoint.url.replace("/ping", "") if endpoint else ""
    service = get_arr_status(key, display, base, api_key)
    probe = _probe_reading(key)
    icon, state = _state_label(service.reachable, service.configured)
    warning_count = len(service.health_warnings)
    with st.expander(
        f"{icon} {display} · {state} · {warning_count} health warnings · "
        f"{service.queue_count if service.queue_count is not None else 'queue unknown'}",
        expanded=service.reachable is False or warning_count > 0,
    ):
        columns = st.columns(6)
        values = (
            ("Probe", probe.status.value if probe else "—"),
            ("API", state),
            ("Version", service.version or "—"),
            ("Queue", service.queue_count if service.queue_count is not None else "—"),
            ("Missing", service.missing_count if service.missing_count is not None else "—"),
            (
                "Indexers",
                f"{service.indexers_total - (service.indexers_failing or 0)}/"
                f"{service.indexers_total}"
                if service.indexers_total is not None
                else "—",
            ),
        )
        for column, (label, value) in zip(columns, values):
            with column:
                metric_card(label, str(value))
        for warning in service.health_warnings:
            st.warning(warning, icon=":material/warning:")
        if service.error:
            st.caption(f":gray[{service.error}]")

read_only_notice()
