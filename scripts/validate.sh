#!/usr/bin/env bash
#
# Validate the environment the dashboard depends on.
#
# Entirely read-only: it inspects and reports, changes nothing. Run it after
# installation, after any infrastructure change, or when a panel is showing
# something you did not expect.
#
#   ./scripts/validate.sh
#
set -uo pipefail

PORT="${DASHBOARD_PORT:-8600}"
PASS=0
FAIL=0
WARN=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL + 1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; WARN=$((WARN + 1)); }
head() { printf '\n\033[36m== %s\033[0m\n' "$*"; }

head "Dashboard service"
if systemctl is-active --quiet streamanator-dashboard; then
  ok "streamanator-dashboard is running"
else
  bad "streamanator-dashboard is not running (journalctl -u streamanator-dashboard -n 50)"
fi
if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/_stcore/health"; then
  ok "HTTP health endpoint responding on ${PORT}"
else
  bad "No response on http://127.0.0.1:${PORT}"
fi

head "RAID"
if [[ -r /proc/mdstat ]]; then
  MDLINE=$(grep -oE '\[[0-9]+/[0-9]+\] \[[U_]+\]' /proc/mdstat | head -1)
  if [[ -z "$MDLINE" ]]; then
    warn "No MD array found in /proc/mdstat"
  elif echo "$MDLINE" | grep -q '_'; then
    bad "RAID is DEGRADED: $MDLINE"
  else
    ok "RAID healthy: $MDLINE"
  fi
else
  bad "/proc/mdstat is not readable"
fi

head "Filesystems"
while read -r mount used; do
  pct=${used%\%}
  if   [[ "$pct" -ge 95 ]]; then bad  "$mount at ${used}"
  elif [[ "$pct" -ge 90 ]]; then warn "$mount at ${used}"
  elif [[ "$pct" -ge 80 ]]; then warn "$mount at ${used}"
  else                           ok   "$mount at ${used}"
  fi
done < <(df --output=target,pcent -x tmpfs -x devtmpfs -x efivarfs 2>/dev/null | tail -n +2 | awk '{print $1, $2}')

head "Physical disks"
if command -v smartctl >/dev/null; then
  ok "smartctl is installed"
  if sudo -n true 2>/dev/null; then
    ok "Passwordless sudo available — local SMART collection can work"
  else
    warn "No passwordless sudo. SMART needs deploy/sudoers-smartctl or the smartctl_exporter container."
  fi
else
  bad "smartctl not installed (apt-get install smartmontools)"
fi
echo "  Disk serials (identify disks by these, never by /dev/sdX):"
lsblk -d -o NAME,SIZE,MODEL,SERIAL 2>/dev/null | tail -n +2 | sed 's/^/    /'

head "Docker"
if command -v docker >/dev/null && docker ps >/dev/null 2>&1; then
  RUNNING=$(docker ps -q | wc -l)
  ok "Docker reachable, ${RUNNING} containers running"
  for name in media-vpn_gluetun_1 immich-server; do
    if docker ps --format '{{.Names}}' | grep -qx "$name"; then
      ok "Container present: $name"
    else
      warn "Container not found: $name (name may have changed)"
    fi
  done
else
  bad "Cannot query Docker (is $USER in the docker group?)"
fi

head "VPN"
GLUETUN=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i gluetun | head -1)
if [[ -n "$GLUETUN" ]]; then
  VPN_IP=$(docker exec "$GLUETUN" wget -qO- -T 8 https://ipinfo.io/ip 2>/dev/null | tr -d '[:space:]')
  WAN_IP=$(curl -s -m 8 https://ipinfo.io/ip 2>/dev/null | tr -d '[:space:]')
  if [[ -z "$VPN_IP" || -z "$WAN_IP" ]]; then
    warn "Could not determine both IPs (VPN='$VPN_IP' WAN='$WAN_IP') — leak check inconclusive"
  elif [[ "$VPN_IP" == "$WAN_IP" ]]; then
    bad "POSSIBLE VPN LEAK: download stack IP ($VPN_IP) matches home WAN IP"
  else
    ok "VPN leak check passed (VPN $VPN_IP != WAN $WAN_IP)"
  fi
else
  warn "No gluetun container found"
fi

head "Service endpoints"
check_http() {
  local name=$1 url=$2 expect=${3:-200}
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 6 "$url" 2>/dev/null)
  if [[ "$code" == "$expect" ]]; then
    ok "$name responding (HTTP $code)"
  elif [[ "$code" == "000" ]]; then
    bad "$name unreachable ($url)"
  else
    warn "$name returned HTTP $code ($url)"
  fi
}
check_http "Plex"            "http://10.0.40.100:32400/identity"
check_http "Immich"          "http://10.0.40.100:2283/api/server/ping"
check_http "Sports Data Lab" "http://10.0.40.100:6969/_stcore/health"
check_http "AquaLog"         "http://10.0.40.100:8501/_stcore/health"
check_http "SABnzbd"         "http://10.0.40.100:8080"

head "Backups"
SPORTS_DIR=${SPORTS_BACKUP_DIR:-/mnt/media/sportsDBackUp}
if [[ -d "$SPORTS_DIR" ]]; then
  LATEST=$(find "$SPORTS_DIR" -maxdepth 1 -name '*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1)
  if [[ -z "$LATEST" ]]; then
    bad "No backups found in $SPORTS_DIR"
  else
    TS=${LATEST%% *}
    AGE_DAYS=$(( ( $(date +%s) - ${TS%.*} ) / 86400 ))
    if   [[ "$AGE_DAYS" -gt 7 ]]; then bad  "Latest sports backup is ${AGE_DAYS} days old"
    elif [[ "$AGE_DAYS" -gt 4 ]]; then warn "Latest sports backup is ${AGE_DAYS} days old"
    else                               ok   "Latest sports backup is ${AGE_DAYS} days old"
    fi
    echo "    $(basename "${LATEST#* }")"
  fi
else
  bad "Backup directory missing: $SPORTS_DIR"
fi

head "systemd"
FAILED=$(systemctl --failed --no-legend --plain 2>/dev/null | wc -l)
if [[ "$FAILED" -eq 0 ]]; then
  ok "No failed units"
else
  warn "${FAILED} failed unit(s):"
  systemctl --failed --no-legend --plain | sed 's/^/    /'
fi

head "Monitoring stack"
for probe in "Prometheus:9090" "Grafana:3000" "node_exporter:9100" "cAdvisor:9101" "smartctl_exporter:9633" "Blackbox:9115"; do
  NAME=${probe%%:*}; P=${probe##*:}
  if ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${P}$"; then
    ok "$NAME listening on ${P}"
  else
    warn "$NAME not deployed (port ${P} has no listener)"
  fi
done

head "External exposure"
echo "  Non-loopback listeners:"
ss -lnt 2>/dev/null | awk 'NR>1 && $4 !~ /^127\.|^\[::1\]/ {print "    " $4}' | sort -u

printf '\n\033[36m== Summary\033[0m\n'
printf '  \033[32m%d passed\033[0m, \033[33m%d warnings\033[0m, \033[31m%d failed\033[0m\n\n' "$PASS" "$WARN" "$FAIL"
[[ "$FAIL" -eq 0 ]]
