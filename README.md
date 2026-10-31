# Streamanator dashboard

Streamanator is a self-hosted Next.js 16 and TypeScript dashboard for a Linux home server. The former Streamlit application has been retired; all UI, collectors, history, health scoring, alerts, admin configuration and background workers run in the Node.js application under `web/`.

It has two jobs: a health overview that says what needs attention, and a Task Manager-depth live view of the host for when something does. A Raspberry Pi on the LAN can show the `/hub` home display (or the `/wall` server status) full-screen around the clock (see [deploy/pi-kiosk/README.md](deploy/pi-kiosk/README.md)).

## Monitored areas

- RAID/mdadm state, member disks, SMART health and CRC deltas
- Filesystem capacity, inodes, growth and capacity forecasts
- CPU, memory, load, uptime, temperatures and systemd failures
- Internet, gateway, DNS, WAN address, interfaces and UniFi gateway/AP/switch/port/VLAN inventory
- Docker containers, restart counts and VPN/leak state
- Plex, Immich, AFLDB, download services and other application probes
- Backup freshness, missed schedules and in-progress jobs
- Listening ports, declared exposure and UniFi IDS/IPS events
- Alert/recovery email, weekly summaries and healthchecks heartbeat

## Live views

A one-second sampler reads `/proc`, `/sys` and `nvidia-smi` directly and streams frames to the browser over server-sent events (`/api/live`), keeping the last ten minutes in memory so a page opens with history already drawn.

| Page | What it shows |
|---|---|
| `/wall` | Full-screen kiosk: overall status, the things that need attention, live CPU/memory/storage/network/GPU tiles, internet latency, subsystem states. Reloads itself after a deploy and says STALE rather than showing old numbers as current. |
| `/live` | Task Manager: CPU (overall or per logical processor), memory composition, every disk (active time, throughput, latency), every NIC, the GPU (3D, decode, encode, memory) and pressure stall information. |
| `/processes` | Every process with CPU, memory, disk I/O, threads, owning systemd unit or container; list, tree and by-service views; a detail drawer with ancestry, open files, sockets and limits. |
| `/connections` | Listening ports with their reachable scope, established connections grouped by remote, TCP state counts. |
| `/services` | systemd units with state, CPU, memory, tasks and restarts; failed units; timers; error-priority journal entries from the last 24 hours. |
| `/alerts` | Threshold rules evaluated on the live stream (for example CPU above 90 % for 5 minutes). Firing rules feed the health score, the wall and alert email. Editable from an Admin session. |
| `/events` | What changed on the host: inventory differences, WAN changes and other recorded events, plus the admin audit log for signed-in admins. |
| `/home` | Apps & media: a launcher tile for every monitored service with a live up/down dot, admin-edited bookmarks, a search box (apps, Sonarr/Radarr add-search, the web; press `/`), clock and Open-Meteo weather, Plex now playing, the SABnzbd and qBittorrent queues, the Sonarr/Radarr calendar and RSS headlines. Each widget says whether it is unconfigured, failing or idle. |
| `/hub` | Home hub for a wall or kitchen screen: clock, weather (now, next 18 hours, 5 days, rain chance, UV, sunrise/sunset), a 7-day agenda merged from private iCal feeds (Google, iCloud, Outlook) plus Sonarr/Radarr releases, tap-to-tick To do and Shopping lists anyone at the screen can edit, countdowns, an Immich album slideshow behind it all, and one line of server health, Plex now playing and headlines. Night dimming, a photos-only mode (tap the clock), landscape and portrait layouts, and a reload after each deploy. Feed URLs and the Immich key never leave the server. |
| `/inventory` | Packages, enabled units, containers (with image id), listening ports, login-capable accounts, kernel modules and fingerprints of security-relevant files, re-collected every six hours. New accounts, new listeners on all interfaces and changes to sshd/sudoers/authorized_keys are raised as warnings. |

Every view distinguishes zero from missing data and shows the source used. SMART and UniFi exporter data are discovered through Prometheus when available; bounded local collectors and direct probes provide the remaining live data.

The dashboard runs unprivileged as `arm`. Without root the kernel hides the disk I/O counters, open files and socket owners of other accounts' processes; those show as "—" or by uid, not as zero.

### Process control

Signed-in admins can end, kill, suspend/resume or reload a process and lower its priority from the Processes drawer. Each action asks for the admin password again, is checked against the process start time (so a recycled PID can't be hit) and is written to `var/audit.log`, refusals included. The dashboard refuses root's processes, other accounts' processes, PID 1, kernel threads, itself and its workers, core plumbing (sshd, systemd, dockerd, mdadm and similar) and anything inside a container (restart the container instead). Raising priority needs root and is refused. `ADMIN_ACTIONS_ENABLED=false` turns all of it off.

### Home hub

Set it up under Admin → Home & hub. `HUB_CALENDARS` takes `Name|#colour|ical-url` entries separated by `;` (Google: Settings → the calendar → "Secret address in iCal format"). Recurring events, exceptions, moved occurrences and Outlook's Windows time-zone names are expanded on the server; feeds are cached for 10 minutes and a failing feed keeps its last good copy and is named on screen. Lists are stored in `var/hub.json`; they can be changed from any browser on the LAN without signing in, so keep port 8600 internal. Photos need an Immich endpoint, an API key with `album.read` and `asset.view`, and album ids in `HUB_PHOTO_ALBUMS`; the dashboard proxies only photos from those albums.

### Container control

The Docker page gives signed-in admins start, stop and restart for each container, with the same password step-up and audit log. Requests carry the container id, so a container recreated since the page loaded is refused, and the confirmation names every container sharing the target's network namespace (stopping Gluetun takes the whole media stack offline). Pulling and recreating stay with the stack updater.

## Development

Requires Node.js 22 or newer.

```bash
cd web
npm ci            # on Windows: npm ci --ignore-scripts (better-sqlite3 needs a Linux build)
npm run test
npm run typecheck
npm run dev
```

Open <http://localhost:3000>. Production health is available at `/api/health`; collector diagnostics are shown at `/diagnostics` and returned by `/api/diagnostics`. The live views need Linux `/proc`, so develop against the server or a Linux VM for those.

## Production

```bash
./scripts/install.sh
./scripts/validate.sh
```

The systemd unit runs `next start` on port 8600. Keep that port on the LAN: never forward it from the WAN.

Deploy from a workstation with:

```bash
STREAMANATOR_SSH=arm@10.0.40.100 \
STREAMANATOR_SSH_OPTS="-i ~/.ssh/your_key -o IdentitiesOnly=yes" \
./scripts/deploy.sh            # --dry-run lists what would ship
```

It needs only `ssh` and `tar`, so it runs from Git Bash on Windows. It runs the tests and typecheck locally, ships the tracked and untracked-but-not-ignored files, backs up the current source, builds into `web/.next-build` **while the live build keeps serving**, runs the test suite on the server, then swaps the build directories and restarts the unit. It's healthy once `/api/health` answers and the live stream reports the new build id. A failed build or test leaves the running service untouched; a failed restart or health check restores the previous build and source and restarts again. The previous build stays in `web/.next-prev`.

Runtime state stays in `var/`. Secrets stay in the root `.env` file (mode `0600`) and are passed to the Node service through systemd. Configure `ADMIN_PASSWORD` plus a random `ADMIN_SESSION_SECRET` of at least 32 characters before using the admin page.

### Live-view settings

| Variable | Default | Meaning |
|---|---|---|
| `LIVE_SAMPLE_INTERVAL_MS` | `1000` | Live sampler period |
| `LIVE_HISTORY_SECONDS` | `600` | In-memory history sent to a page when it opens |
| `INVENTORY_INTERVAL_HOURS` | `6` | How often the inventory is re-collected |
| `INVENTORY_PATH` | `var/inventory.json` | Last inventory snapshot |
| `ALERT_CONDITIONS_PATH` | `var/alert-conditions.json` | Customised alert rules (absent = defaults) |
| `WEIGHT_CONDITIONS` | `5` | Weight of firing alert rules in the health score |

See [docs/DISCREPANCIES.md](docs/DISCREPANCIES.md) for the live-host survey and [deploy/monitoring-stack/README.md](deploy/monitoring-stack/README.md) for Prometheus/Grafana exporters.
