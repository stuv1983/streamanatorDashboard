# Live environment vs. documentation

Recorded from a read-only survey of `streamanator` on **13 August 2026**.

The build specification and the project's `Home-Network-README.md` disagree with
the live host in several places that materially affect monitoring. Per the
spec's own instruction ("treat the live system as authoritative and document the
discrepancy"), the dashboard is built against what is actually running, and every
difference is listed here rather than silently absorbed.

Nothing on the server was modified to make it match the documentation.

---

## 1. The monitoring stack did not exist (now deployed)

**This was the largest discrepancy and it changed the architecture.**

> **Update, 13 Aug 2026:** the stack shipped in `deploy/monitoring-stack/` has
> since been deployed via `deploy.sh`. Prometheus, Grafana, node-exporter,
> cAdvisor, blackbox-exporter and smartctl-exporter are running (all bound to
> 127.0.0.1), the dashboard's `PROMETHEUS_URL` is set, and SMART/CRC history —
> including `WPV2E6LL` at CRC 5670 — is being collected. The "Live" column
> below records the original survey state; the local-collector fallback
> described here still exists and still runs whenever Prometheus is absent.

The spec describes Prometheus, Grafana, cAdvisor and Node Exporter as "existing
infrastructure" and instructs the dashboard to consume Prometheus as the
preferred source of truth.

| Component | Documented | Live |
|---|---|---|
| Prometheus (9090) | running | **no listener, no container** |
| Grafana (3000) | running | **no listener, no container** |
| Node Exporter (9100) | running | **no listener, no container** |
| cAdvisor (8080) | running | **no container** (8080 is SABnzbd) |

The images `prom/prometheus:latest`, `prom/node-exporter:latest` and
`gcr.io/cadvisor/cadvisor:latest` are present locally, along with
`grafana/grafana-oss`, `grafana/loki`, `grafana/alloy`, `netdata/netdata` and
`louislam/uptime-kuma` — so a stack was set up at some point and the containers
were later removed.

```
$ pgrep -a -f "prometheus|grafana|cadvisor|node_exporter"
(no output)
$ ss -lnt | grep -E ':(9090|3000|9100)'
(no output)
```

### What the dashboard does about it

Building strictly to spec would have produced a dashboard showing
NOT CONFIGURED everywhere. Instead:

1. **A source-routing layer** (`core/collector.py:SourceRouter`) prefers
   Prometheus per data area and falls back to local collectors. Setting
   `PROMETHEUS_URL` switches the relevant areas over with no code change.
2. **Local collectors** (`services/system.py`) read `/proc`, `/sys` and
   `statvfs` directly, behind timeouts and caching, as the spec permits for
   data Prometheus cannot supply.
3. **A local SQLite time-series store** (`core/history.py`) with a background
   sampler provides the deltas, trends and forecasts that the whole design
   depends on — the CRC delta and capacity forecast are unanswerable without
   *some* time-series database.
4. **The full stack is shipped ready to deploy** in
   `deploy/monitoring-stack/`, including smartctl and blackbox exporters.

---

## 2. Port 8080 is SABnzbd, not cAdvisor

The README lists cAdvisor on 8080 ("reported historically") and flags it for
verification. It is SABnzbd:

```
$ curl -sI http://10.0.40.100:8080/
Server: CherryPy/18.10.0        # SABnzbd's web server
```

Every media-stack port is published by the **gluetun** container, not by the
application containers, which is why `docker ps` shows no ports against Sonarr
or Radarr:

| Host port | Service | Container port |
|---|---|---|
| 8080 | SABnzbd | 8080 |
| 8081 | Sonarr | 8989 |
| 8082 | Radarr | 7878 |
| 8085 | Prowlarr | 9696 |
| 8086 | qBittorrent | 8086 |
| 6881 | qBittorrent BitTorrent | 6881 |

The bundled Prometheus config puts cAdvisor on **9101** to avoid the collision.

---

## 3. Sports Data Lab runs on port 6969, not 8501

The README records port 8501 and a tmux-managed session. Live:

```
$ systemctl show sports-data-lab.service
ExecStart=.../python -m streamlit run app.py --server.address 0.0.0.0 --server.port 6969
```

* Sports Data Lab: **port 6969**, systemd unit `sports-data-lab.service`,
  running directly (no tmux wrapper).
* Port **8501** belongs to a *different, undocumented* Streamlit application:
  **AquaLog** (`aqualog.service`, `/home/arm/projects/aquaLog`).

Probing 8501 as "Sports Data Lab" would have produced a permanently green
panel for the wrong application. Both are now monitored separately.

---

## 4. Plex is not a container

The README and spec list Plex among the Docker services. It runs natively:

* `plexmediaserver.service` — active, enabled, with a systemd drop-in override.
* The `plex` container exists but **exited 11 months ago**.

Version is also newer than documented: live **1.43.3.10861**, README 1.42.2.10156.

---

## 5. An undocumented backup disk exists

`/mnt/backup` (a 931 GB portable SSD, serial `2246AP402020`) is mounted and
actively used, holding `nightly/` and `bootstrap/` trees updated on the morning
of the survey. It appears nowhere in the README.

This matters: it is the only backup target that is **not** on the RAID array,
which makes it the most important one to monitor. It is now a tracked
filesystem and a tracked backup job.

---

## 6. Two live backup problems

Both were found during the survey and are exactly what the dashboard exists to
surface.

**`backup-nightly.service` is in a failed state:**

```
× backup-nightly.service
   Active: failed (Result: exit-code) since Thu 2026-08-13 02:00:36 AEST
   backup.sh[2140074]: [2026-08-13 02:00:36] Another backup is running. Exiting.
```

A stale lock, or an overlapping run, is causing the nightly job to abort. It has
been failing silently.

**The Sports Data Lab backup is overdue:**

Latest archive is `sports_data_lab_2026-08-09_14-11-57.tar.gz` — 4 days old at
the time of survey. The cron schedule is `0 23 * * 0,3` (Sun & Wed 23:00), so
the **Wednesday 12 August run did not produce output**.

The backup job also lives at `/usr/local/sbin/sports-data-backup.sh` under
**root's** crontab, not `arm`'s as the README implies.

---

## 7. Disk serial to device mapping (as of this boot only)

| Serial | Device now | Model | Role |
|---|---|---|---|
| WPV2E65M | sda | ST8000VN002-2ZM1 | RAID5 member |
| WPV36EV6 | sdb | ST8000VN002-2ZM1 | RAID5 member |
| WPV2E6KL | sdc | ST8000VN002-2ZM1 | RAID5 member |
| **WPV2E6LL** | **sde** | ST8000VN002-2ZM1 | RAID5 member — CRC history |
| S2ZWNDAHA21787 | sdd | SAMSUNG MZ7TY256 | Boot / root LVM |
| 2518106901831 | sdf | BIWIN M100 1TB | `/mnt/ssd` download staging |
| 2246AP402020 | sdg | Portable SSD | `/mnt/backup` |

The README attributes the 31 July re-add to `/dev/sdb`. `WPV2E6LL` is currently
`sde`, which confirms the README's own warning that device letters move. The
dashboard keys every disk by serial and treats `/dev/sdX` as display-only.

The 11 August incident is visible in the kernel log:

```
md/raid:md127: raid level 5 active with 3 out of 4 devices
md: recovery of RAID array md127
md: md127: recovery done.        # ~24 minutes later
```

---

## 8. Array and filesystem state

RAID is **healthy**: `[4/4] [UUUU]`, no resync running.

Filesystem usage differs from the spec's worked examples:

| Mount | Spec example | Live |
|---|---|---|
| `/mnt/media` | 73% used, 6.1 TiB free | **78% used, 4.9 TiB free** (22 T total, XFS) |
| `/mnt/ssd` | — | 4% used, 859 G free |
| `/` | — | 48% used, 116 G free |

`/mnt/ssd/complete` is a directory on `/mnt/ssd`, not a separate filesystem.
The array filesystem is **XFS**, which the README lists as an open question.

Because `/mnt/media` is already past the spec's 80% warning line, the storage
panel leads with *growth rate and projected crossing dates* rather than the
percentage, which would otherwise alarm permanently and mean nothing.

---

## 9. Container naming is inconsistent

The media stack mixes Compose v1 and v2 naming, because SABnzbd was recreated
under v2 during the 11 August update:

```
media-vpn-sabnzbd-1        <- Compose v2
media-vpn_prowlarr_1       <- Compose v1
media-vpn_radarr_1
media-vpn_qbittorrent_1
media-vpn_sonarr_1
media-vpn_gluetun_1
```

`services/docker_service.py:find_container` matches exactly, then
underscore/hyphen-insensitively, then by Compose service label — so a future
Compose migration will not make the dashboard report containers as missing.

---

## 10. VPN state

Working at survey time. Gluetun healthy, NordVPN over OpenVPN, exit IP
`187.13.209.146` (Miami, US) versus home WAN `111.118.194.91` — leak check
passes.

One limitation: Gluetun's HTTP control server (`:8000`) has
`HTTP_CONTROL_SERVER_AUTH_CONFIG_FILEPATH` set, so it requires an API key
(v3.40+ behaviour) and returns nothing without one. Tunnel state is therefore
inferred from an exit-IP lookup executed inside the container's namespace,
which is reliable but coarser than the control API. Setting `GLUETUN_API_KEY`
upgrades it.

---

## 11. Host facts worth recording

* 24 CPU cores, 31 GiB RAM, kernel 6.8.0-137.
* ~800 MiB "free" memory alongside 27 GiB page cache and **28 GiB available** —
  which is why every memory rule uses `MemAvailable`, not free memory.
* `arm` is in the `docker` group (container monitoring works unprivileged).
* `arm` has **no passwordless sudo** — so `smartctl` cannot run without either
  the sudoers drop-in in `deploy/` or the smartctl exporter container. This is
  the single biggest gap in current coverage.
* Samba is listening on 139/445; `mdcheck_continue.timer` and
  `mdmonitor-oneshot.timer` are active (RAID scrubbing is scheduled).
* Port **8600** was free and is used for the dashboard.

---

## 12. Items from the spec left deliberately unimplemented

| Spec item | Why |
|---|---|
| VLAN client counts, RX/TX, firewall blocks | Requires UniFi telemetry. Shown as `—` with a NOT CONFIGURED panel rather than approximated from host NIC counters, which would be a different measurement wearing the same label. |
| Inter-VLAN traffic visualisation | The spec says not to manufacture flow data UniFi does not expose. It does not expose it here. |
| Gateway CPU/RAM/temperature, WAN throughput | Same — UniFi only. |
| IDS/IPS event table | Same. An empty table would read as "no intrusions", which is not what "cannot see" means. |
| External port detection | No outbound scanning is performed. The Security page shows a declared inventory to be reconciled against UniFi's port forwards; 80/443 are documented as the standard HTTP/HTTPS entry points. |

---

## 13. A pre-existing privilege-escalation path via `sudoers.d`

**Found while building the admin console, on 13 Aug 2026. Not introduced by
this project.**

```
/etc/sudoers.d/sports-data-lab-deploy:
    arm ALL=(root) NOPASSWD: /home/arm/bin/deploy-sports-data-lab.sh

-rwxr-xr-x 1 arm arm 5124 Aug 11 12:12 /home/arm/bin/deploy-sports-data-lab.sh
drwxr-xr-x 2 arm arm 4096 Aug 11 12:12 /home/arm/bin
```

The granted script is **owned and writable by the same account the grant is
issued to**, inside a directory that account also owns. So the rule does not
grant "run this deployment script as root" — it grants "become root":

```bash
echo 'bash -i' >> /home/arm/bin/deploy-sports-data-lab.sh
sudo /home/arm/bin/deploy-sports-data-lab.sh
```

Anything running as `arm` inherits this, including this dashboard and Sports
Data Lab itself. A remote-code-execution bug in either becomes a root
compromise rather than a service compromise.

**Severity in context:** moderate, not urgent. `arm` already has `(ALL : ALL)
ALL` in the base sudoers and is in the `docker` group, both of which are
root-equivalent for an interactive human. What this changes is the picture for
*non-interactive* code running as `arm`: the docker group and this rule both
give it root without a password prompt.

**Suggested fix** — move the script somewhere the invoking user cannot write:

```bash
sudo install -m 0755 -o root -g root \
    /home/arm/bin/deploy-sports-data-lab.sh \
    /usr/local/sbin/deploy-sports-data-lab.sh
sudo sed -i 's#/home/arm/bin/#/usr/local/sbin/#' \
    /etc/sudoers.d/sports-data-lab-deploy
sudo visudo -c        # must report "parsed OK"
```

Updating the script then becomes a deliberate root action, which is the
property the sudoers rule was presumably meant to have.

**Why the dashboard's own sudoers file does not have this problem:**
`deploy/sudoers-streamanator-admin` grants only distribution binaries under
`/usr`, with every argument fixed and no wildcards. Installing the SMART
sudoers rule — the one action that *would* need to read a file from the
project directory — is marked `never_grant` in `admin/actions.py` and is
permanently SSH-only for exactly this reason.
`tests/test_admin_actions.py::test_no_sudo_action_points_at_a_user_writable_path`
enforces it.

---

## 14. UniFi Integration API is live; one endpoint is broken upstream

**Verified 13 Aug 2026 against the published Network API v10.4.57 spec and the
live controller (application version 10.5.67).**

The UniFi onboarding was completed: an API key is configured and the dashboard
reads the controller through `/proxy/network/integration/v1`. Confirmed working
against the live console:

| Endpoint | Result |
|---|---|
| `/v1/info` | 200 — application version 10.5.67 |
| `/v1/sites` | 200 — 1 site (Default) |
| `/sites/{id}/devices` | 200 — 4 devices (UCG Ultra + 3 APs/switch) |
| `/sites/{id}/networks` | 200 — VLANs 1/10/20/30/40/50 |
| `/sites/{id}/firewall/zones` | 200 — 12 zones |
| `/sites/{id}/wans` | 200 — 2 WANs |
| `/sites/{id}/acl-rules` | 200 |
| `/sites/{id}/vpn/servers` | 200 — 1 WireGuard server |
| **`/sites/{id}/firewall/policies`** | **HTTP 500 — `api.unexpected-error`** |

**The firewall-policies endpoint returns HTTP 500 on this firmware.** Every
other firewall endpoint works, so this is an upstream defect in UniFi's
Integration API, not a dashboard fault. The dashboard reports it as such and
uses **firewall zones** instead, which answer the question segmentation exists
to answer — which networks share a trust boundary. Re-test the policies
endpoint after a UniFi Network update; the code will pick it up with no change
once it stops erroring.

**Controller address:** the live `.env` uses `UNIFI_CONTROLLER_URL=https://10.0.0.1`
(the UCG Ultra's primary address). `https://10.0.40.1` — the VLAN 40 gateway
interface — also answers the Integration API. Either works.

**A note on the earlier scope claim:** §12 of this document and the first
version of the UniFi integration listed firewall data as entirely unavailable.
That was written before the API specification was read, and it understated what
the Integration API exposes. Firewall *rules and zones* are available; only the
per-rule hit/drop **counters** are not. The claim has been corrected in
`services/unifi.py` and on the Network and Security pages.

**Key scope, recorded because it is not obvious:** UniFi issues a single API-key
scope that includes write access (networks, firewall policies, SSIDs, device
actions). There is no read-only key. The dashboard's client enforces read-only
on its side — `services/unifi.py` only ever issues GET, and
`tests/test_unifi_readonly.py` fails if a mutating verb, `requests.request()`,
or an `/actions` path is ever added. Treat the key itself as privileged.
