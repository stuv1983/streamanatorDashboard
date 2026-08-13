# Streamanator Dashboard

A single-screen NOC-style operations console for the `streamanator` home server.

It answers one question quickly:

> **Is everything healthy, what has changed, and what needs my attention?**

It is not a Grafana replacement. Grafana remains the deep-dive telemetry and
historical analysis platform; this is the screen you open first, to decide
whether you need to open Grafana at all.

**Read-only.** It observes and explains. It never restarts a container, touches
the array, or changes configuration.

---

## Contents

- [Design philosophy](#design-philosophy)
- [Architecture](#architecture)
- [Installation](#installation)
- [Admin console](#admin-console)
- [Configuration](#configuration)
- [Environment variables](#environment-variables)
- [Prometheus and exporter requirements](#prometheus-and-exporter-requirements)
- [Running](#running)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Extending](#extending)
- [Testing](#testing)

---

## Design philosophy

Four rules shape every panel.

**1. State, delta, trend — not raw values.** A number without movement is
rarely actionable. Disk `WPV2E6LL` carries roughly 5,670 UDMA CRC errors from
past SATA-path faults. That number will never go down, so treating it as a
fault would mean a permanently red dashboard. What matters is whether it is
still climbing:

```
WPV2E6LL
CRC errors: 5,670
1h +0    24h +0    7d +0    30d +0
STABLE — a high but static count reflects a past fault, not a current one.
```

**2. Missing data is not zero.** `0 errors` and `no data` are different
answers, and the difference matters when the question is "is the array safe?".
Every reading carries a data state, and the UI renders `NOT CONFIGURED`,
`NO DATA`, `STALE` or `UNKNOWN` rather than a plausible-looking number. Stale
telemetry is downgraded to UNKNOWN so an exporter that quietly stopped scraping
cannot keep showing its last healthy value forever.

**3. The score never hides a fault.** A CRITICAL component clamps the global
score below the healthy band and forces the overall status to CRITICAL,
regardless of how good everything else is:

```
Health score: 82 / 100
Status: CRITICAL
Reason: Critical: RAID & disks
```

**4. Alerts explain themselves.** Each one states what happened, the current
value, the threshold, the probable cause and the next thing to check. Related
alerts are collapsed into one incident — a Gluetun failure taking down Prowlarr,
Sonarr and SABnzbd is one problem, not four.

---

## Architecture

```
streamanator_dashboard/
├── app.py                    Entry point, navigation, sidebar controls
├── config.py                 All settings; live-verified defaults
├── .streamlit/config.toml    Theme (dark-first, validated palette)
│
├── app_pages/                One file per page
│   ├── overview.py           NOC summary screen
│   ├── network.py  server.py  storage.py  raid.py
│   ├── docker.py   vpn.py     media.py    applications.py
│   └── backups.py  security.py  diagnostics.py
│
├── core/
│   ├── status.py             Status enum, Reading, Alert, ComponentHealth
│   ├── history.py            SQLite time-series + background sampler
│   ├── collector.py          Source routing and aggregation
│   ├── runtime.py            Streamlit caching layer
│   └── errors.py             Structured exceptions
│
├── services/                 One module per data source, all timeout-bounded
│   ├── prometheus.py  system.py   smart.py    docker_service.py
│   ├── probes.py      network.py  vpn.py      backups.py
│   └── sportsdb.py    apps.py     unifi.py
│
├── health/
│   ├── thresholds.py         Every limit, in one place
│   ├── rules.py              Pure classification functions
│   ├── forecast.py           Capacity projection with confidence gates
│   ├── scoring.py            Weighted score with severity clamping
│   └── correlation.py        Cause → effect alert grouping
│
├── components/               Reusable UI: cards, alerts, charts, layout, theme
├── utils/                    Formatting, logging
├── tests/                    167 tests over the critical logic
├── deploy/                   systemd unit, sudoers, monitoring stack
├── scripts/                  install, validate, extract_api_keys
└── docs/DISCREPANCIES.md     Live environment vs. documentation
```

### Data flow

```
      ┌─────────────────────────────────────────────┐
      │  SourceRouter — prefers Prometheus per area │
      └───────────────┬─────────────────────────────┘
                      │
        ┌─────────────┴──────────────┐
        ▼                            ▼
   Prometheus                  Local collectors
   (when deployed)             /proc, statvfs, docker,
                               smartctl, ping, HTTP probes
        │                            │
        └─────────────┬──────────────┘
                      ▼
            HistoryStore (SQLite)          ← background sampler, every 60s
            deltas · trends · forecasts
                      ▼
              health/rules.py               ← pure functions, fully tested
                      ▼
          scoring · correlation
                      ▼
                  Snapshot → pages
```

### Why there is a local history store

The dashboard's most valuable outputs are differences over time. Prometheus is
the intended time-series database — but **it is not currently deployed on this
host** (see [docs/DISCREPANCIES.md](docs/DISCREPANCIES.md)), so there would
have been nothing to difference against on day one.

`core/history.py` is a small append-only SQLite series, written by a background
thread at a fixed interval and retained for 400 days. It runs independently of
the UI, so 7-day and 30-day deltas keep accruing whether or not a browser tab
is open. When `PROMETHEUS_URL` is set, Prometheus becomes the preferred source
for range queries and this keeps running as a backstop.

---

## Installation

Target host: `streamanator`, as the `arm` user.

```bash
# 1. Copy the project onto the server
rsync -av --exclude .venv --exclude var \
    streamanator_dashboard/ arm@10.0.40.100:/home/arm/projects/streamanator_dashboard/

# 2. Install
ssh arm@10.0.40.100
cd /home/arm/projects/streamanator_dashboard
./scripts/install.sh

# 3. Create the admin account (interactive — prompts for a password)
.venv/bin/python scripts/admin_bootstrap.py init
```

`install.sh` verifies Python ≥ 3.10, checks the chosen port is free, creates a
virtualenv, installs dependencies, creates `.env` from the template, runs the
tests, installs and starts the systemd unit, and confirms the HTTP endpoint
responds. It changes nothing about Docker, the array or any existing service.

Step 3 is separate because it needs a terminal. See
[Admin console](#admin-console) for what it creates and why it is not a web
setup wizard.

### Updating a running install

`scripts/deploy.sh` pushes changes from the workstation to the server. It sends
only files whose SHA-256 differs from the server's copy, so a typical deploy is
a few kilobytes rather than the whole tree.

```bash
./scripts/deploy.sh --dry-run   # list what differs, send nothing
./scripts/deploy.sh             # back up, send, restart, verify
```

Each deploy tars the current server tree into `var/deploy-backups/` before
writing anything, restarts the systemd unit, and polls
`/_stcore/health` for 30 seconds. If the dashboard does not come back, the
script prints the last 30 log lines, restores the backup and restarts again —
so a bad deploy ends with the previous version running, not with an outage.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Show the changed-file list and exit |
| `--prune` | Also delete server files no longer in the repo |
| `--force-restart` | Restart even when nothing changed |
| `--no-restart` | Write files, leave the running process alone |
| `--rollback` | Restore the most recent backup and restart |
| `--list-backups` | List backups on the server |

It runs from Git Bash on Windows and needs only `ssh`, `tar` and `sha256sum` —
no rsync. The file list comes from `git ls-files --cached --others
--exclude-standard`, so `.env`, `var/` and `.venv/` are excluded by the same
rules that keep them out of the repository: a deploy never touches the server's
secrets, history database or account store. Host and path default to
`arm@10.0.40.100:/home/arm/projects/streamanator_dashboard` and are overridable
with `--host` / `--dir`.

The first install still goes through `install.sh`; this script only updates an
existing one.

### Manual installation

```bash
cd /home/arm/projects/streamanator_dashboard
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
cp .env.example .env && chmod 600 .env
mkdir -p var

sudo cp deploy/streamanator-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now streamanator-dashboard
```

### Port selection

The dashboard uses **8600**, verified free on this host. Confirm before
changing:

```bash
ss -lntup | grep 8600
```

Do **not** create a WAN port-forward for it. It binds to `0.0.0.0` so it is
reachable from the Home and Management VLANs; it is an internal tool.

---

## Admin console

The monitoring pages are read-only and open. The **Admin** section is
authenticated and is where configuration and control live.

### Creating the first account

There is no web setup wizard. That is deliberate: a first-run wizard on a
service bound to `0.0.0.0` leaves a window in which anyone who can reach the
port can claim the admin account, and the window opens the moment the process
starts. Requiring shell access means the first account can only be created by
someone who already has the server.

```bash
cd /home/arm/projects/streamanator_dashboard
.venv/bin/python scripts/admin_bootstrap.py init
```

This prompts for a username and password (never taken as arguments — they
would land in shell history and the process list), then prints ten break-glass
recovery codes **once**.

Other subcommands, all for the case where the web path is unavailable:

| Command | Use when |
|---|---|
| `add-admin NAME` | Adding a second admin |
| `passwd NAME` | Password forgotten |
| `breakglass --force` | Recovery codes lost or exhausted |
| `unlock NAME` | Locked out by failed attempts |
| `disable-totp NAME` | Authenticator device lost |
| `list` | Checking account state |

### The two accounts

**admin** — the everyday account. Password, plus an optional TOTP
authenticator enrolled from Admin → Accounts. Five failed attempts lock it,
with the lockout lengthening on repeated failures. Sessions last four hours
absolute, thirty minutes idle.

**breakglass** — the emergency account, for when the admin path itself is
broken. It has **no password**. It authenticates with single-use recovery
codes that are generated once, shown once, stored only as hashes, and burned
on use.

That asymmetry is the design. A break-glass account with a memorable reusable
password is just a second admin account with weaker authentication — it
becomes the easiest way in rather than the last way in. Single-use codes
cannot be reused, cannot be shoulder-surfed into a lasting compromise, and
deplete visibly, so the store itself records how many times the emergency path
has been taken.

Break-glass carries the **same authority** as admin. Restricting what it can do
would defeat its purpose — an emergency credential that cannot fix the
emergency is decoration. The controls on it are visibility and time:

- A red banner appears on **every page** until dismissed, not just in Admin.
- The event is logged at critical severity, in the audit file and journald.
- Sessions last 30 minutes absolute, 10 minutes idle.

Store the codes somewhere that does not depend on this server being reachable.
Codes saved only on `streamanator` are useless in the emergency they exist for.

### What the console can do

| Page | Purpose |
|---|---|
| Admin jobs | Reboot, service restarts, container restarts, stack deploys |
| API keys | UniFi, Plex, Sonarr, Radarr, Prowlarr, SABnzbd, qBittorrent, Tautulli |
| Disk health setup | Unblock SMART via the exporter or the sudoers rule |
| Service probes | Add, retarget and test application health checks |
| Accounts | Passwords, TOTP enrolment, break-glass code reissue |
| Audit log | Every privileged action, filterable |

### How actions are constrained

Version 1 was specified as read-only. The admin console reverses that
deliberately, but the reasoning behind the original rule survives in the shape
of the implementation. **The dashboard is still not a remote shell.**

- Every action is a **fixed argv tuple declared in `admin/actions.py`**.
  Nothing is assembled from a text box. `shell=True` appears nowhere.
- The one variable — which container to restart — comes from a closed list
  derived from configuration, validated immediately before execution.
- **No sudo grant points at a path the service account can write.** A NOPASSWD
  rule on a script under `/home` is a root shell with extra steps: rewrite the
  script, run it. Actions that would need that are marked `never_grant` and are
  permanently SSH-only.
- **No wildcards in sudo rules.** Each unit is named; `systemctl restart *`
  would permit restarting units whose `ExecStart` is arbitrary root code.
- Destructive actions are **delayed and reversible**. The reboot is scheduled a
  minute out so the cancel button is a real option, not a race.
- Every action is probed against the live system before it is offered. One that
  cannot run says why and shows the command to paste into SSH.

There is no button to remove a disk, fail a RAID member, delete a backup, or
run an arbitrary command. Those are absent from the registry, not hidden from
the page — there is no code path to them.

`tests/test_admin_actions.py` asserts these properties structurally, so they
survive future edits rather than depending on review.

### Optional: passwordless sudo for the allowlisted commands

Without this, actions needing root render as SSH commands. This makes them run
directly:

```bash
sudo install -m 0440 -o root -g root \
    deploy/sudoers-streamanator-admin \
    /etc/sudoers.d/streamanator-dashboard-admin
sudo visudo -c        # must report "parsed OK" before you log out
```

Keep a second root shell open until `visudo -c` passes. A malformed file in
`/etc/sudoers.d` disables sudo for every user on the host.

A test asserts this file grants **exactly** what the registry expects — no
more, no less — so it cannot drift into an over-broad grant or a broken button.

### Turning control off

```bash
ADMIN_ACTIONS_ENABLED=false   # console becomes configuration-only
REQUIRE_AUTH_FOR_ALL=true     # sign-in required for monitoring pages too
```

The first leaves credentials and probes editable while every action renders as
a command to run over SSH. The second is worth setting if the dashboard ever
becomes reachable from a VLAN you do not trust — though the standing advice
remains not to expose it.

---

## Configuration

All configuration is environment-based. Copy `.env.example` to `.env` and edit.
Every value is optional — the dashboard runs with none of them set, using the
live-verified defaults in `config.py`, and shows `NOT CONFIGURED` for whatever
is missing.

`.env` is `chmod 600` and gitignored. **No credential is ever read from source
or committed.**

### Populating API keys

```bash
sudo ./scripts/extract_api_keys.sh          # review the output first
sudo ./scripts/extract_api_keys.sh >> .env  # then append
chmod 600 .env
sudo systemctl restart streamanator-dashboard
```

This reads the keys out of the container config files once, as an explicit
operator action. The dashboard itself never reads `/root/docker` at runtime.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PROMETHEUS_URL` | *(empty)* | Preferred telemetry source. Not deployed yet. |
| `GRAFANA_URL` | *(empty)* | Enables "Open in Grafana" deep links. |
| `BLACKBOX_URL` | *(empty)* | Continuous probing with history. |
| `UNIFI_EXPORTER_URL` | *(empty)* | Gateway, WAN and VLAN telemetry. |
| `DASHBOARD_PORT` | `8600` | Verified free on this host. |
| `DASHBOARD_REFRESH_SECONDS` | `30` | Auto-refresh interval. |
| `HISTORY_DB_PATH` | `var/history.sqlite3` | Local time-series store. |
| `HISTORY_SAMPLE_INTERVAL` | `60` | Background sampler period. |
| `SMARTCTL_SUDO` | `false` | Enable after installing the sudoers drop-in. |
| `PLEX_URL` | `http://10.0.40.100:32400` | Native service, not a container. |
| `IMMICH_URL` | `http://10.0.40.100:2283` | |
| `SPORTS_DATA_LAB_URL` | `http://10.0.40.100:6969` | **6969**, not 8501. |
| `AQUALOG_URL` | `http://10.0.40.100:8501` | The other Streamlit app. |
| `SABNZBD_URL` | `http://10.0.40.100:8080` | Published by gluetun. |
| `SONARR_URL` | `http://10.0.40.100:8081` | → container 8989 |
| `RADARR_URL` | `http://10.0.40.100:8082` | → container 7878 |
| `PROWLARR_URL` | `http://10.0.40.100:8085` | → container 9696 |
| `QBITTORRENT_URL` | `http://10.0.40.100:8086` | |
| `CRC_WATCH_SERIAL` | `WPV2E6LL` | Disk with CRC history. |
| `RAID_DEVICE` | `md127` | |
| `RAID_REQUIRED_MEMBERS` | `4` | |
| `SPORTS_BACKUP_DIR` | `/mnt/media/sportsDBackUp` | |
| `NIGHTLY_BACKUP_DIR` | `/mnt/backup/nightly` | Undocumented backup disk. |

Secrets — `PLEX_TOKEN`, `SONARR_API_KEY`, `RADARR_API_KEY`,
`PROWLARR_API_KEY`, `SABNZBD_API_KEY`, `QBITTORRENT_USER`/`_PASSWORD`,
`UNIFI_API_KEY`, `GLUETUN_API_KEY` — are all optional and all environment-only.

Every threshold in `health/thresholds.py` can be overridden with a `TH_*`
variable; see the commented block at the end of `.env.example`.

---

## Prometheus and exporter requirements

**None are required.** The dashboard is fully functional without any of them,
using local collectors and its own history store. Each one deployed upgrades
specific panels from local point-in-time data to Prometheus-backed history.

Deploy the full stack with one script — it generates the Grafana password,
brings everything up, waits for health, wires the dashboard to Prometheus, and
provisions Grafana with a starter dashboard:

```bash
cd deploy/monitoring-stack
./deploy.sh
sudo systemctl restart streamanator-dashboard   # pick up PROMETHEUS_URL
```

See [deploy/monitoring-stack/README.md](deploy/monitoring-stack/README.md) for
what it runs, how Grafana is provisioned, and how to tear it down. Verified
live on 13 Aug 2026: all 15 scrape targets up, and smartctl-exporter reading
the array — including **WPV2E6LL at CRC 5670**, the disk that was previously
blind and holding the health score back.

Ranked by value:

| Exporter | Priority | What it unlocks | Port |
|---|---|---|---|
| **smartctl_exporter** | Very high | All physical disk health: SMART status, temperature, pending/reallocated sectors, and the CRC trend. Without it, disk health is entirely blind. | 9633 |
| **Prometheus + node_exporter** | Very high | Historical telemetry with proper retention; replaces the local history store as the range-query source. | 9090 / 9100 |
| **cAdvisor** | High | Per-container CPU, memory and network. | 9101 |
| **Blackbox Exporter** | High | Continuous probing with history instead of at page load. | 9115 |

UniFi is **not** part of this stack — it is reached through the Network
Integration API (an API key set in Admin → API keys), because the polling
account uses MFA. See below.

### UniFi with MFA — use an API key, not unpoller

The controller is the UniFi console itself at `https://10.0.40.1`, verified
reachable from `streamanator`.

**This account has email MFA enforced, so any username/password path is out.**
unpoller and the legacy controller API (`/proxy/network/api/s/<site>/...`) both
perform an interactive login and expect a session cookie back; MFA stops that
flow for a second factor and it never completes. That is a property of the
login flow, not of the account's role — making it a "local admin" does not help
while MFA is on.

The **Network Integration API** solves this. It authenticates with an
`X-API-KEY` header, which is a separate credential issued from the console and
never goes through the login flow. **MFA stays enabled on your account.** The
endpoint was confirmed present on this firmware — it answers 401 rather than
404 — so this is the supported path here:

```bash
curl -sk -o /dev/null -w '%{http_code}\n' \
  https://10.0.40.1/proxy/network/integration/v1/sites
# 401 = present, needs a key.   404 = firmware too old for this API.
```

**Setup:**

1. UniFi console → **Settings → Control Plane → Integrations → Create API Key**
   (on some firmware: Settings → Admins & Users → the account → Create API
   Key). Copy it immediately; it is shown once.
2. Verify it:
   ```bash
   curl -sk -H 'X-API-KEY: <key>' \
     https://10.0.40.1/proxy/network/integration/v1/sites
   # expect HTTP 200 and a JSON list of sites
   ```
3. Add to the dashboard `.env` and restart:
   ```bash
   UNIFI_CONTROLLER_URL=https://10.0.40.1
   UNIFI_API_KEY=<key>
   ```

**What this gives you:** gateway/AP/switch inventory and state, device CPU and
memory, uptime, uplink throughput, and client counts per VLAN.

**What it will not give you, even once connected:** IDS/IPS alarm history and
per-VLAN firewall counters. Those exist only on the legacy API, which needs the
login MFA blocks. The Security page says so explicitly and points you at the
UniFi console for threat review, rather than showing an empty table that would
read as an all-clear.

Leave `deploy/monitoring-stack/`'s unpoller service commented out — it cannot
authenticate against an MFA account.

> cAdvisor is on **9101**, not 8080. On this host 8080 is SABnzbd, published by
> the gluetun container.

### SMART without the exporter

If you would rather not run the exporter, grant narrow read-only sudo:

```bash
sudo install -m 0440 -o root -g root \
    deploy/sudoers-smartctl /etc/sudoers.d/streamanator-dashboard-smartctl
sudo visudo -c                       # always validate
echo 'SMARTCTL_SUDO=true' >> .env
sudo systemctl restart streamanator-dashboard
```

The drop-in permits exactly two read-only `smartctl` invocations and explicitly
denies every form that can write to a drive. The exporter is still preferable:
it confines the privilege to a container and gives Prometheus history for free.

---

## Running

```bash
sudo systemctl start streamanator-dashboard
sudo systemctl stop streamanator-dashboard
sudo systemctl restart streamanator-dashboard
systemctl status streamanator-dashboard
journalctl -u streamanator-dashboard -f
```

> **Stop it with systemctl, never with `pkill -f streamlit`.**
> This host runs three Streamlit applications — Sports Data Lab (6969), AquaLog
> (8501) and this dashboard (8600). They all share the command substring
> `streamlit run app.py`, so a pattern kill takes down the other two as
> collateral. If you must kill by hand, match the port:
> `pkill -f 'streamlit run app.py --server.port 8600'`, or find the exact PID
> with `ss -lntp | grep 8600` first.
>
> There is a second trap in that command. `pkill -f` matches a process's *full
> argv*, so running it as an **SSH one-liner matches the SSH session itself** —
> the session dies mid-restart and takes the dashboard with it. Use
> `scripts/restart-dev.sh`, which keeps the pattern inside a file where it
> cannot self-match, and verifies all three ports afterwards.

Manually, for development:

```bash
cd /home/arm/projects/streamanator_dashboard
./.venv/bin/streamlit run app.py --server.port 8600

# or, when it is running detached rather than under systemd:
./scripts/restart-dev.sh
```

Validate the whole environment at any time — this is read-only and safe to run
whenever something looks wrong:

```bash
./scripts/validate.sh
```

It checks the service, RAID state, filesystems, disk serials, Docker, the VPN
leak comparison, every service endpoint, backup age, failed units, which
exporters are deployed, and the current external listener inventory.

---

## Updating

```bash
cd /home/arm/projects/streamanator_dashboard
# copy in the new version, preserving .env and var/
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m pytest tests/ -q
sudo systemctl restart streamanator-dashboard
./scripts/validate.sh
```

`var/history.sqlite3` holds the accumulated time-series. **Do not delete it** —
doing so resets every delta and forecast to "insufficient history".

---

## Troubleshooting

**The dashboard will not start.**
```bash
journalctl -u streamanator-dashboard -n 50
```
Most common causes: the port is taken (`ss -lntup | grep 8600`), or the
virtualenv is missing (`./scripts/install.sh` again).

**Container panels show "Docker is unreachable".**
The service user needs the `docker` group:
```bash
sudo usermod -aG docker arm && sudo systemctl restart streamanator-dashboard
```

**Disk SMART shows NOT CONFIGURED.**
Expected until you deploy the smartctl exporter or install the sudoers
drop-in — SMART requires root and `arm` has no passwordless sudo. See above.

**Deltas and forecasts show "insufficient history".**
Also expected on a fresh install. The sampler needs a few hours for 24-hour
deltas and several days for 7-day windows and forecasts. Check it is running on
the Diagnostics page; it reports last run, run count and any error.

**A service shows UNKNOWN but I can reach it in a browser.**
Check the exact URL on the Diagnostics page. Several services return non-200
without credentials, which is why qBittorrent's expected statuses include 401
and 403.

**The health score seems low but everything looks fine.**
Look at the status label, not the number, and open the Diagnostics page. An
UNKNOWN component holds the score back deliberately — a green dashboard is
supposed to mean "checked and fine", not "did not check".

**Everything in the media stack failed at once.**
Check the VPN page first. Those containers share Gluetun's network namespace;
when the tunnel drops they all lose DNS simultaneously while still reporting
`Up`. The alert panel should already have collapsed them into one incident.

---

## Extending

### Adding a service to monitor

1. Add a `ServiceEndpoint` to `SERVICE_ENDPOINTS` in `config.py`.
2. If it has an API worth reading, add a function to `services/apps.py`
   returning an `AppStatus`.
3. It appears automatically on the Applications page and in the probe table.

### Adding a health rule

1. Add a threshold to the relevant dataclass in `health/thresholds.py`.
2. Write a pure `classify_*` function in `health/rules.py` returning a
   `Verdict`. It must return `Status.UNKNOWN` for `None` input.
3. Call it from the appropriate collector in `core/collector.py` and append the
   `Reading` (and `Alert`, via `rules.alert_from_verdict`).
4. Add tests in `tests/test_health_rules.py`, including the missing-data case.

### Adding a Prometheus metric

1. Add the metric name to the right family in `EXPECTED_METRIC_FAMILIES`
   (`services/prometheus.py`) so feature detection knows about it.
2. Add a query function — keep PromQL out of the UI entirely.
3. Route it in `SourceRouter.source_for` so it falls back gracefully when the
   exporter is absent.

### Adding a container to the expected inventory

Add an `ExpectedContainer` to `EXPECTED_CONTAINERS` in `config.py`. Set
`behind_vpn=True` if it shares Gluetun's namespace — that is what makes alert
correlation group it under a VPN failure.

---

## Testing

```bash
./.venv/bin/pip install -r requirements-dev.txt
./.venv/bin/python -m pytest tests/ -q
```

359 tests covering:

- RAID classification, including degraded and rebuilding arrays
- `/proc/mdstat` parsing against captured healthy, degraded, rebuilding and
  failed-member output
- CRC delta logic — large-but-static vs. rising, and the no-history case
- SMART attributes, temperature bands, pending and uncorrectable sectors
- Filesystem thresholds and inode pressure
- Capacity forecasting: insufficient history, flat usage, shrinking, noisy data
- History store deltas, including the distinction between `+0` and "no baseline"
- Change detection (WAN IP, container image versions)
- VPN leak detection, including both inconclusive cases
- Gluetun log analysis (`AUTH_FAILED` identification)
- Container health and restart-loop detection
- Backup age, size plausibility and integrity states
- Data freshness and staleness downgrading
- Health scoring, severity clamping and worst-of aggregation
- Alert correlation

The health rules are pure functions with no I/O, which is what makes the
critical paths — degraded RAID, VPN leak, backup failure — testable without a
live host.

### Admin and security tests

The admin tests assert properties that are invisible from the UI when they
break — a lockout that never engages, a TOTP code that can be replayed, a
recovery code that survives use all look completely normal from the outside:

- Password hashing: salting, constant-time comparison, fail-closed on a
  corrupt hash, and identical messages for "no such user" and "wrong password"
  so the form is not a username oracle
- Lockout engagement and escalation; a missing TOTP code not counting as a
  failed attempt
- TOTP against the RFC 6238 reference vector, drift tolerance, and **replay
  refusal** within the same 30-second window
- Two-phase TOTP enrolment — the secret is not stored until a code verifies
- Break-glass codes: single use, burned on redemption, never written to disk
  in plaintext, invalidated on reissue
- The audit log never containing a secret value, including a scrubber test
  against bare high-entropy strings

Structural checks on the action registry, which is where a future edit is most
likely to quietly widen the blast radius:

- No shell metacharacters in any argv; no relative binary paths
- **No sudo grant on a path the service account can write** — and the inverse,
  that anything referencing the project directory is marked SSH-only
- No wildcards in any grantable sudo rule
- The shipped sudoers file grants *exactly* the registry's list — no more, no
  less, so it cannot drift into an over-broad grant or a broken button
- Destructive actions declare step-up, a typed phrase and an undo path
- Parameterised actions reject values outside their configured list
- A plain `(ALL : ALL) ALL` sudo grant is **not** read as passwordless

And the access guard itself: each admin page stops before creating a single
widget when unauthenticated, expired and idle sessions are refused, and
`REQUIRE_AUTH_FOR_ALL` unregisters the monitoring pages rather than hiding
them from the sidebar.

---

## Roadmap

Phase 1 (**complete**) — local collectors, history store, all pages, health
rules, alerting, correlation, forecasting.

Phase 2 — deploy `deploy/monitoring-stack/`: smartctl exporter (unlocks all
disk health), Prometheus + node_exporter, cAdvisor, blackbox exporter.

Phase 3 — UniFi via unpoller: gateway health, WAN throughput, VLAN visibility,
IDS/IPS events.

Phase 4 — Tautulli for richer Plex sessions; alert acknowledgement; historical
health score.

---

## See also

- [docs/DISCREPANCIES.md](docs/DISCREPANCIES.md) — every place the live host
  disagrees with the documentation, and what was done about it.
