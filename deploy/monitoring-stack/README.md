# Monitoring stack — Prometheus + Grafana

The dashboard prefers Prometheus as its telemetry source and falls back to a
local SQLite history store when none is present. The 13 Aug 2026 survey found
no Prometheus on `streamanator`, so this directory ships the stack the
dashboard was designed to consume.

Deploying it is optional. Without it the dashboard works from its own history;
with it you get long retention, Grafana views, and — the highest-value part —
**SMART/CRC history for `WPV2E6LL`**, which is what actually answers whether
that disk's error count is moving or static.

## Deploy

```bash
cd deploy/monitoring-stack
./deploy.sh
```

`deploy.sh` checks Docker, generates a Grafana admin password on first run
(printed once, stored in `.env` at mode 600), brings the stack up, waits for
Prometheus and Grafana to report healthy, and sets `PROMETHEUS_URL` +
`GRAFANA_URL` in the dashboard's `.env`. Then restart the dashboard so it
switches sources:

```bash
sudo systemctl restart streamanator-dashboard   # or ./scripts/restart-dev.sh
```

Re-running `deploy.sh` is safe and idempotent.

## What runs

Everything binds to `127.0.0.1` only — nothing here is reachable from another
VLAN, let alone the Internet.

| Service | Port | Provides |
|---|---|---|
| Prometheus | 9090 | time-series storage, 400-day retention |
| Grafana | 3000 | dashboards (provisioned, see below) |
| node-exporter | 9100 | host CPU, memory, load, filesystems, mdadm, hwmon |
| cAdvisor | 9101 | per-container CPU and memory (**not** 8080 — that's SABnzbd) |
| blackbox-exporter | 9115 | synthetic HTTP/TCP/ICMP probes of the services |
| smartctl-exporter | 9633 | SMART attributes, including UDMA CRC |

## Grafana

The datasource and a starter dashboard are **provisioned from disk** — Grafana
comes up already wired to Prometheus with a "Streamanator — Host & Services"
dashboard as its home page. No manual setup, no click-ops to reproduce.

- `grafana/provisioning/datasources/prometheus.yml` — the Prometheus
  datasource, pinned to uid `streamanator-prometheus` so the dashboard can
  reference it deterministically across rebuilds.
- `grafana/provisioning/dashboards/provider.yml` — the file provider.
- `grafana/dashboards/streamanator.json` — the dashboard itself. Edit it in
  the UI to experiment, but the file in git is the source of truth (the
  provider re-reads it every 30s and on restart).

Grafana is bound to localhost. View it from your desktop with a tunnel, never
by exposing the port:

```bash
ssh -L 3000:127.0.0.1:3000 arm@10.0.40.100
# then browse http://localhost:3000
```

## Probe targets

`blackbox.yml` and `prometheus.yml` carry the live-verified endpoints from the
survey — note that Sports Data Lab is on **6969**, not 8501 (that's AquaLog),
and Plex/SABnzbd/qBittorrent use a TCP-connect probe because they do not answer
200 to an unauthenticated GET. Edit `prometheus.yml` to add or remove targets,
then reload without a full restart:

```bash
curl -X POST http://127.0.0.1:9090/-/reload
```

## Tear down

```bash
./teardown.sh            # stop; keep history and Grafana state
./teardown.sh --volumes  # also delete Prometheus history + Grafana state
./teardown.sh --unwire   # also unset PROMETHEUS_URL so the dashboard reverts
                         # to local history
```

Stopping is safe — the dashboard degrades to its own SQLite history the moment
Prometheus disappears. It does not break; it loses retention and the Grafana
views.

## Alerts

`alert-rules.yml` defines Prometheus alert rules (RAID degraded, filesystem
filling, CRC rising, probe down, VPN leak signals). They are evaluated by
Prometheus and visible at `http://127.0.0.1:9090/alerts`. Wiring them to a
notifier (Alertmanager, or Grafana alerting) is a deliberate follow-up, not
included here — the dashboard itself is the primary alert surface for now.
