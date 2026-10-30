# Streamanator dashboard

Streamanator is a self-hosted Next.js 16 and TypeScript dashboard for a Linux home server. The former Streamlit application has been retired; all UI, collectors, history, health scoring, alerts, admin configuration and background workers run in the Node.js application under `web/`.

## Monitored areas

- RAID/mdadm state, member disks, SMART health and CRC deltas
- Filesystem capacity, inodes, growth and capacity forecasts
- CPU, memory, load, uptime, temperatures and systemd failures
- Internet, gateway, DNS, WAN address, interfaces and UniFi gateway/AP/switch/port/VLAN inventory
- Docker containers, restart counts and VPN/leak state
- Plex, Immich, AFLDB, download services, other application probes and sports databases
- Backup freshness, missed schedules and in-progress jobs
- Listening ports, declared exposure and UniFi IDS/IPS events
- Task Manager-style CPU, memory, disk, network and latency graphs backed by SQLite history
- Alert/recovery email, weekly summaries and healthchecks heartbeat

Every view distinguishes zero from missing data and shows the source used. SMART and UniFi exporter data are discovered through Prometheus when available; bounded local collectors and direct probes provide the remaining live data.

## Development

Requires Node.js 22 or newer.

```bash
cd web
npm ci
npm run test
npm run typecheck
npm run dev
```

Open <http://localhost:3000>. Production health is available at `/api/health`; collector diagnostics are shown at `/diagnostics` and returned by `/api/diagnostics`.

## Production

```bash
./scripts/install.sh
./scripts/validate.sh
```

The systemd unit runs `npm run start` on port 8600. `scripts/deploy.sh` validates locally, backs up the remote tree, synchronises sources, installs locked dependencies, builds, restarts, verifies `/api/health`, and restores the backup on failure.

Runtime state stays in `var/`. Secrets stay in the root `.env` file (mode `0600`) and are passed to the Node service through systemd. Configure `ADMIN_PASSWORD` plus a random `ADMIN_SESSION_SECRET` of at least 32 characters before using the admin page.

See [docs/DISCREPANCIES.md](docs/DISCREPANCIES.md) for the live-host survey and [deploy/monitoring-stack/README.md](deploy/monitoring-stack/README.md) for Prometheus/Grafana exporters.
