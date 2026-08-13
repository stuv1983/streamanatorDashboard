"""Diagnostics — read-only troubleshooting.

Shows where every number came from, which integrations are missing, and what
each one would add. There is deliberately **no arbitrary command execution**:
this is monitoring software, not a remote shell. The commands it suggests are
printed for the operator to run themselves.
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

from components.cards import not_configured_card
from components.layout import page_header, read_only_notice, source_footer
from components.theme import style
from config import EXPECTED_LISTENERS, get_settings
from core.runtime import (
    docker_versions,
    history_store,
    prometheus_client,
    prometheus_features,
    prometheus_targets,
    sampler,
)
from core.runtime import get_snapshot
from core.status import Status
from services import unifi
from services.prometheus import EXPECTED_METRIC_FAMILIES
from services.system import IS_LINUX, get_block_devices, get_md_arrays
from utils.formatting import format_timestamp, human_age, human_bytes, human_duration

settings = get_settings()
snapshot = get_snapshot()

page_header(
    "Diagnostics",
    "Where the data comes from, what is missing, and how to verify it",
    snapshot.collected_at,
)

# ---------------------------------------------------------------------------
# Collection health
# ---------------------------------------------------------------------------

st.markdown("### Collection")

collection = st.columns(4)
with collection[0]:
    st.metric("Snapshot time", f"{snapshot.duration_seconds * 1000:.0f} ms", border=True)
with collection[1]:
    st.metric("Alerts", len(snapshot.alerts), border=True)
with collection[2]:
    st.metric("Incidents", len(snapshot.incidents), border=True)
with collection[3]:
    st.metric("Health score", f"{snapshot.health.score:.0f}", border=True)

sampler_instance = sampler()
store = history_store()
store_stats = store.stats()

with st.container(border=True):
    st.markdown("**Background history sampler**")
    columns = st.columns(4)
    with columns[0]:
        st.caption("Running")
        st.markdown(f"**{'yes' if sampler_instance.running else 'no'}**")
    with columns[1]:
        st.caption("Last run")
        st.markdown(f"**{human_age(sampler_instance.last_run)}**")
    with columns[2]:
        st.caption("Runs")
        st.markdown(f"**{sampler_instance.runs:,}**")
    with columns[3]:
        st.caption("Interval")
        st.markdown(f"**{sampler_instance.interval}s**")
    if sampler_instance.last_error:
        st.error(f"Last sampler error: {sampler_instance.last_error}", icon=":material/error:")
    # Writes on the collection path are best-effort, so a broken store shows up
    # as missing deltas rather than an exception. This is where it surfaces.
    if store.last_write_error:
        st.warning(
            f"Last history write error: {store.last_write_error} — deltas and "
            "forecasts will have gaps until this clears.",
            icon=":material/warning:",
        )

    st.caption(
        f":gray[History store: {store_stats['samples']:,} samples across "
        f"{store_stats['metrics']} metrics, "
        f"{human_bytes(store_stats['bytes'])} on disk, spanning "
        f"{human_duration(store_stats['newest'] - store_stats['oldest'])}.]"
    )
    st.caption(
        ":gray[This local store is what makes deltas and forecasts possible while "
        "Prometheus is absent. Once Prometheus is deployed it becomes the "
        "preferred source for range queries and this keeps running as a backstop.]"
    )

source_footer(snapshot.sources)

# ---------------------------------------------------------------------------
# Prometheus
# ---------------------------------------------------------------------------

st.markdown("### Prometheus")

client = prometheus_client()
if client is None:
    not_configured_card(
        "Prometheus",
        "PROMETHEUS_URL is not set. No Prometheus server was found running on "
        "this host during the initial survey — port 9090 had no listener and no "
        "prometheus container existed, although the prom/prometheus image is "
        "present locally. The dashboard is therefore running entirely on local "
        "collectors plus its own history store.",
        steps=(
            "Deploy the bundled stack: cd deploy/monitoring-stack && docker compose up -d",
            "This starts prometheus, node_exporter, cadvisor, smartctl_exporter and blackbox_exporter.",
            "Set PROMETHEUS_URL=http://127.0.0.1:9090 in the dashboard .env.",
            "Restart the dashboard: systemctl restart streamanator-dashboard",
            "Verify: curl -s localhost:9090/api/v1/label/__name__/values | head",
        ),
        source="prometheus",
    )
elif not client.available():
    st.error(
        f"Prometheus is configured at `{client.url}` but is not answering. The "
        f"dashboard has fallen back to local collectors.",
        icon=":material/error:",
    )
else:
    st.success(f"Connected to {client.url}", icon=":material/check_circle:")

    features = prometheus_features()
    st.markdown("**Exporter feature detection**")
    st.dataframe(
        pd.DataFrame(
            {
                "Exporter": list(features.keys()),
                "Present": [
                    f"{style(Status.HEALTHY).icon} yes"
                    if present
                    else f"{style(Status.UNKNOWN).icon} no"
                    for present in features.values()
                ],
            }
        ),
        hide_index=True,
        width="stretch",
    )

    targets = prometheus_targets()
    if targets:
        st.markdown("**Scrape targets**")
        st.dataframe(
            pd.DataFrame(
                {
                    "Status": [
                        f"{style(Status.HEALTHY if t.healthy else Status.CRITICAL).icon} {t.health}"
                        for t in targets
                    ],
                    "Job": [t.job for t in targets],
                    "Instance": [t.instance for t in targets],
                    "Last scrape": [human_age(t.last_scrape) for t in targets],
                    "Error": [t.last_error or "—" for t in targets],
                }
            ),
            hide_index=True,
            width="stretch",
        )

with st.expander("Metric families the dashboard can consume"):
    for family, metrics in EXPECTED_METRIC_FAMILIES.items():
        st.markdown(f"**{family}**")
        st.markdown("\n".join(f"- `{metric}`" for metric in metrics))

# ---------------------------------------------------------------------------
# Missing integrations
# ---------------------------------------------------------------------------

st.markdown("### Missing integrations")

missing = [
    (
        "Prometheus + node_exporter + cAdvisor",
        "Very high",
        "Historical telemetry, container CPU/memory/network, and the time-series "
        "base every trend depends on. Currently substituted by local collectors "
        "and the dashboard's own SQLite history.",
        "deploy/monitoring-stack/docker-compose.yml",
    ),
    (
        "smartctl_exporter",
        "Very high",
        "Physical disk health: SMART status, temperature, pending/reallocated "
        "sectors and the UDMA CRC counters. Without it the WPV2E6LL CRC trend "
        "cannot be tracked at all.",
        "deploy/monitoring-stack/ (or deploy/sudoers-smartctl for the local path)",
    ),
    (
        "Blackbox Exporter",
        "High",
        "Continuous synthetic probing with history, instead of point-in-time "
        "probes at page load.",
        "deploy/monitoring-stack/",
    ),
    (
        "UniFi exporter (unpoller)",
        "High",
        "Gateway CPU/RAM/temperature, real WAN throughput and errors, per-VLAN "
        "client counts, firewall drops, IDS/IPS events, AP and switch health.",
        "deploy/monitoring-stack/ (unpoller service)",
    ),
    (
        "Application API keys",
        "Medium",
        "Sonarr/Radarr/Prowlarr health warnings and queues, SABnzbd queue and "
        "speed, qBittorrent torrent states, Plex sessions.",
        "scripts/extract_api_keys.sh",
    ),
    (
        "Gluetun control server credentials",
        "Low",
        "Authoritative tunnel status and the current VPN endpoint. Tunnel state "
        "is currently inferred from the exit-IP lookup.",
        "GLUETUN_CONTROL_URL / GLUETUN_API_KEY",
    ),
]

st.dataframe(
    pd.DataFrame(
        {
            "Integration": [m[0] for m in missing],
            "Priority": [m[1] for m in missing],
            "What it adds": [m[2] for m in missing],
            "How": [m[3] for m in missing],
        }
    ),
    hide_index=True,
    width="stretch",
    column_config={
        "What it adds": st.column_config.TextColumn(width="large"),
    },
)

# ---------------------------------------------------------------------------
# Environment facts
# ---------------------------------------------------------------------------

st.markdown("### Environment")

env_left, env_right = st.columns(2)

with env_left:
    with st.container(border=True):
        st.markdown("**Disk identification**")
        devices = get_block_devices()
        if not devices:
            st.caption("lsblk unavailable.")
        else:
            st.dataframe(
                pd.DataFrame(
                    {
                        "Serial": [d.serial for d in devices],
                        "Kernel name": [f"/dev/{d.name}" for d in devices],
                        "Model": [d.model for d in devices],
                        "Size": [human_bytes(d.size_bytes) for d in devices],
                    }
                ),
                hide_index=True,
                width="stretch",
            )
        st.caption(
            ":gray[Serial is the identity. Kernel names have changed across "
            "reboots on this host — never act on a /dev/sdX alone.]"
        )

with env_right:
    with st.container(border=True):
        st.markdown("**RAID state (/proc/mdstat)**")
        arrays = get_md_arrays(settings.local.proc_mdstat) if IS_LINUX else None
        if not arrays:
            st.caption("No MD arrays visible (or not running on Linux).")
        else:
            for array in arrays:
                st.markdown(
                    f"- **{array.device}** — {array.level}, "
                    f"{array.disks_active}/{array.disks_required} "
                    f"`[{array.state_string}]`, members "
                    f"{', '.join(array.members)}"
                )

    with st.container(border=True):
        st.markdown("**Docker**")
        versions = docker_versions()
        if versions:
            for key, value in versions.items():
                st.markdown(f"- **{key}:** `{value}`")
        else:
            st.caption("Docker version unavailable.")

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

st.markdown("### Configured endpoints")

st.dataframe(
    pd.DataFrame(
        {
            "Service": [e.display for e in settings.endpoints],
            "URL": [e.url or "not configured" for e in settings.endpoints],
            "Expected status": [", ".join(str(s) for s in e.expect_status) for e in settings.endpoints],
            "Hosting": [e.hosting for e in settings.endpoints],
        }
    ),
    hide_index=True,
    width="stretch",
    column_config={"Hosting": st.column_config.TextColumn(width="large")},
)

# ---------------------------------------------------------------------------
# Verification commands
# ---------------------------------------------------------------------------

st.markdown("### Verification commands")
st.caption(
    "Run these yourself on the host. The dashboard does not execute arbitrary "
    "commands — it is monitoring software, not a remote shell."
)

st.code(
    """# Host and array
cat /proc/mdstat
sudo mdadm --detail /dev/md127
lsblk -o NAME,SIZE,MODEL,SERIAL,FSTYPE,MOUNTPOINTS
df -hT

# Physical disks (needs root)
sudo smartctl -a /dev/disk/by-id/ata-ST8000VN002-2ZM188_WPV2E6LL \\
  | grep -Ei 'UDMA_CRC|Reallocated|Pending|Uncorrectable|SMART overall'

# Containers and listeners
docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'
sudo ss -lntup

# VPN
docker exec media-vpn_gluetun_1 wget -qO- https://ipinfo.io/json
curl -s https://ipinfo.io/ip     # home WAN IP; must differ from the above

# Services and backups
systemctl --failed
systemctl list-timers --all
crontab -l
ls -la /mnt/media/sportsDBackUp""",
    language="bash",
)

read_only_notice()
