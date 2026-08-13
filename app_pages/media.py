"""Media — Plex, Immich and the download/indexer stack."""

from __future__ import annotations

import pandas as pd
import streamlit as st

from components.cards import metric_card, not_configured_card, reading_card
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
probes = snapshot.raw.get("applications", {}).get("probes", {})

page_header(
    "Media",
    "Plex, Immich and the VPN-routed download stack",
    snapshot.collected_at,
)


def _probe_reading(key: str):
    if applications is None:
        return None
    return next((r for r in applications.readings if r.key == f"probe.{key}"), None)


# ---------------------------------------------------------------------------
# Plex
# ---------------------------------------------------------------------------

st.markdown("### Plex")
st.caption(
    "Runs as a native systemd service (`plexmediaserver.service`) on this host, "
    "not in Docker — the `plex` container exited months ago and is not the live "
    "instance."
)

plex_endpoint = settings.endpoint("plex")
plex_base = (plex_endpoint.url.replace("/identity", "") if plex_endpoint else "")
plex = get_plex_status(plex_base, settings.api.plex_token)

columns = st.columns(5)
with columns[0]:
    metric_card(
        "Availability",
        "Up" if plex.reachable else ("Down" if plex.reachable is False else "Unknown"),
    )
with columns[1]:
    metric_card("Version", plex.version or "—")
with columns[2]:
    metric_card(
        "Active streams",
        str(plex.stream_count) if plex.configured and plex.reachable else "—",
    )
with columns[3]:
    metric_card(
        "Transcodes",
        str(plex.transcode_count) if plex.configured and plex.reachable else "—",
    )
with columns[4]:
    metric_card(
        "Remote streams",
        str(plex.remote_count) if plex.configured and plex.reachable else "—",
    )

if not plex.configured:
    not_configured_card(
        "Plex session detail",
        "PLEX_TOKEN is not set, so availability and version are shown but active "
        "sessions, transcode decisions and bandwidth are not.",
        steps=(
            "Obtain a token: https://support.plex.tv/articles/204059436",
            "Add PLEX_TOKEN to the dashboard .env (never to source control).",
            "Optionally deploy Tautulli and set TAUTULLI_URL / TAUTULLI_API_KEY "
            "for richer session history.",
        ),
        source="plex api",
    )
elif plex.sessions:
    st.dataframe(
        pd.DataFrame(
            {
                "User": [s.user for s in plex.sessions],
                "Title": [s.title for s in plex.sessions],
                "Player": [s.player for s in plex.sessions],
                "Decision": [s.decision for s in plex.sessions],
                "Location": ["local" if s.local else "remote" for s in plex.sessions],
                "Bandwidth": [
                    f"{s.bandwidth_kbps:,.0f} kbps" if s.bandwidth_kbps else "—"
                    for s in plex.sessions
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

st.divider()

# ---------------------------------------------------------------------------
# Immich
# ---------------------------------------------------------------------------

st.markdown("### Immich")

immich_endpoint = settings.endpoint("immich")
immich_base = (
    immich_endpoint.url.replace("/api/server/ping", "") if immich_endpoint else ""
)
immich = get_immich_status(immich_base)

immich_columns = st.columns(4)
with immich_columns[0]:
    metric_card(
        "API",
        "Up" if immich.reachable else ("Down" if immich.reachable is False else "Unknown"),
    )
with immich_columns[1]:
    metric_card("Version", immich.version or "—")

# Container-level health for the Immich stack.
container_readings = [
    r
    for r in (applications.readings if applications else [])
    if r.key.startswith("container.immich")
]
with immich_columns[2]:
    healthy = sum(1 for r in container_readings if r.status is Status.HEALTHY)
    metric_card("Containers healthy", f"{healthy} / {len(container_readings)}")
with immich_columns[3]:
    storage = immich.detail.get("storage", {})
    metric_card(
        "Library size",
        human_bytes(storage.get("diskUse")) if isinstance(storage, dict) and storage.get("diskUse") else "—",
    )

if container_readings:
    st.dataframe(
        pd.DataFrame(
            {
                "Status": [f"{style(r.status).icon} {r.status.value}" for r in container_readings],
                "Component": [r.label for r in container_readings],
                "State": [str(r.value) for r in container_readings],
                "Detail": [r.detail for r in container_readings],
            }
        ),
        hide_index=True,
        width="stretch",
    )

st.divider()

# ---------------------------------------------------------------------------
# Download stack
# ---------------------------------------------------------------------------

st.markdown("### Download & indexer stack")
vpn_component = snapshot.component("vpn")
if vpn_component is not None and vpn_component.status is not Status.HEALTHY:
    st.warning(
        "Every service below routes through Gluetun, and the tunnel is not "
        "healthy right now — expect them all to fail together. Check the VPN "
        "page before troubleshooting any of them individually.",
        icon=":material/vpn_lock:",
    )

# SABnzbd
sab_endpoint = settings.endpoint("sabnzbd")
sab = get_sabnzbd_status(
    sab_endpoint.url if sab_endpoint else "", settings.api.sabnzbd_api_key
)
with st.container(border=True):
    st.markdown("**SABnzbd**")
    if not sab.configured:
        st.caption(
            "SABNZBD_API_KEY not set — queue, speed and disk-space detail "
            "unavailable. Availability is still probed. "
            "Run `scripts/extract_api_keys.sh` to populate it."
        )
        reading = _probe_reading("sabnzbd")
        if reading:
            reading_card(reading)
    elif not sab.reachable:
        st.error(f"SABnzbd API error: {sab.error}", icon=":material/error:")
    else:
        sab_columns = st.columns(5)
        with sab_columns[0]:
            metric_card("State", "Paused" if sab.paused else "Active")
        with sab_columns[1]:
            metric_card("Speed", human_bytes_per_second(sab.speed_bytes_per_sec))
        with sab_columns[2]:
            metric_card("Queue", str(sab.queue_size) if sab.queue_size is not None else "—")
        with sab_columns[3]:
            metric_card(
                "Remaining",
                f"{sab.remaining_mb / 1024:.1f} GB" if sab.remaining_mb else "—",
            )
        with sab_columns[4]:
            metric_card(
                "Free space",
                f"{sab.disk_free_gb:.0f} GB" if sab.disk_free_gb else "—",
            )
        if sab.current_job:
            st.caption(f"Current job: {sab.current_job}")

# qBittorrent
qbit_endpoint = settings.endpoint("qbittorrent")
qbit = get_qbittorrent_status(
    qbit_endpoint.url if qbit_endpoint else "",
    settings.api.qbittorrent_user,
    settings.api.qbittorrent_password,
)
with st.container(border=True):
    st.markdown("**qBittorrent**")
    if not qbit.reachable:
        st.caption(qbit.error or "Not reachable.")
        reading = _probe_reading("qbittorrent")
        if reading:
            reading_card(reading)
    else:
        qbit_columns = st.columns(6)
        for column, (label, value) in zip(
            qbit_columns,
            (
                ("Download", human_bytes_per_second(qbit.download_bytes_per_sec)),
                ("Upload", human_bytes_per_second(qbit.upload_bytes_per_sec)),
                ("Torrents", str(qbit.total_torrents or 0)),
                ("Downloading", str(qbit.downloading or 0)),
                ("Seeding", str(qbit.seeding or 0)),
                ("Errored", str(qbit.errored or 0)),
            ),
        ):
            with column:
                metric_card(label, value)
        if qbit.errored:
            st.warning(
                f"{qbit.errored} torrent(s) in an error state.",
                icon=":material/warning:",
            )

# *arr services
st.markdown("**Sonarr / Radarr / Prowlarr**")
arr_rows = []
for key, display, api_key in (
    ("sonarr", "Sonarr", settings.api.sonarr_api_key),
    ("radarr", "Radarr", settings.api.radarr_api_key),
    ("prowlarr", "Prowlarr", settings.api.prowlarr_api_key),
):
    endpoint = settings.endpoint(key)
    base = endpoint.url.replace("/ping", "") if endpoint else ""
    status = get_arr_status(key, display, base, api_key)
    probe = _probe_reading(key)
    arr_rows.append(
        {
            "Service": display,
            "Probe": probe.status.value if probe else "—",
            "API": "up"
            if status.reachable
            else ("not configured" if not status.configured else "down"),
            "Version": status.version or "—",
            "Health warnings": len(status.health_warnings) if status.configured else "—",
            "Queue": status.queue_count if status.queue_count is not None else "—",
            "Missing": status.missing_count if status.missing_count is not None else "—",
            "Indexers": (
                f"{status.indexers_total - (status.indexers_failing or 0)}/{status.indexers_total}"
                if status.indexers_total is not None
                else "—"
            ),
            "_warnings": status.health_warnings,
            "_error": status.error,
        }
    )

st.dataframe(
    pd.DataFrame(arr_rows).drop(columns=["_warnings", "_error"]),
    hide_index=True,
    width="stretch",
)

for row in arr_rows:
    if row["_warnings"]:
        with st.expander(f"{row['Service']} health warnings ({len(row['_warnings'])})"):
            for warning in row["_warnings"]:
                st.markdown(f"- {warning}")
    elif row["_error"]:
        st.caption(f":gray[{row['Service']}: {row['_error']}]")

read_only_notice()
