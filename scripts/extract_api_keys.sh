#!/usr/bin/env bash
#
# Extract application API keys from the container config files into .env format.
#
# WHY THIS EXISTS: the dashboard must never read secrets out of /root/docker at
# runtime — secrets belong in the environment. This script does the extraction
# once, as an explicit operator action, and prints the result for you to review
# before it lands in .env.
#
# Usage:
#   sudo ./scripts/extract_api_keys.sh              # print to stdout for review
#   sudo ./scripts/extract_api_keys.sh >> ../.env   # append after reviewing
#
# The output CONTAINS SECRETS. Do not paste it into a ticket, chat or commit.
#
set -euo pipefail

DOCKER_ROOT="${DOCKER_ROOT:-/root/docker}"

warn() { printf '# WARNING: %s\n' "$*"; }

if [[ ! -r "${DOCKER_ROOT}" ]]; then
  echo "Cannot read ${DOCKER_ROOT}. Run with sudo." >&2
  exit 1
fi

echo "# ---------------------------------------------------------------------"
echo "# API keys extracted from ${DOCKER_ROOT} on $(date -Iseconds)"
echo "# Review before appending to .env, then: chmod 600 .env"
echo "# ---------------------------------------------------------------------"

# --- *arr services: <ApiKey> in config.xml --------------------------------
extract_arr() {
  local service=$1 var=$2
  local config="${DOCKER_ROOT}/${service}/config/config.xml"
  if [[ -r "$config" ]]; then
    local key
    key=$(grep -oP '(?<=<ApiKey>)[^<]+' "$config" 2>/dev/null | head -1)
    if [[ -n "$key" ]]; then
      echo "${var}=${key}"
    else
      warn "No <ApiKey> found in ${config}"
    fi
  else
    warn "Not readable: ${config}"
  fi
}

extract_arr sonarr   SONARR_API_KEY
extract_arr radarr   RADARR_API_KEY
extract_arr prowlarr PROWLARR_API_KEY

# --- SABnzbd: api_key in sabnzbd.ini --------------------------------------
SAB_INI="${DOCKER_ROOT}/sabnzbd/config/sabnzbd.ini"
if [[ -r "$SAB_INI" ]]; then
  SAB_KEY=$(grep -oP '^api_key\s*=\s*\K\S+' "$SAB_INI" 2>/dev/null | head -1)
  if [[ -n "${SAB_KEY:-}" ]]; then
    echo "SABNZBD_API_KEY=${SAB_KEY}"
  else
    warn "No api_key found in ${SAB_INI}"
  fi
else
  warn "Not readable: ${SAB_INI}"
fi

# --- qBittorrent -----------------------------------------------------------
QBIT_CONF="${DOCKER_ROOT}/qbittorrent/config/qBittorrent/qBittorrent.conf"
if [[ -r "$QBIT_CONF" ]]; then
  QBIT_USER=$(grep -oP '^WebUI\\Username=\K.*' "$QBIT_CONF" 2>/dev/null | head -1)
  echo "QBITTORRENT_USER=${QBIT_USER:-admin}"
  # The password is stored as a PBKDF2 hash and cannot be recovered. If the
  # WebUI has no auth bypass for localhost, set this by hand.
  echo "# QBITTORRENT_PASSWORD=   # hashed in config; set manually"
  if grep -q 'LocalHostAuth=false' "$QBIT_CONF" 2>/dev/null; then
    warn "qBittorrent has localhost auth bypass enabled — no password needed from the host"
  fi
else
  warn "Not readable: ${QBIT_CONF}"
fi

# --- Plex ------------------------------------------------------------------
PLEX_PREFS="/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml"
if [[ -r "$PLEX_PREFS" ]]; then
  PLEX_TOKEN=$(grep -oP 'PlexOnlineToken="\K[^"]+' "$PLEX_PREFS" 2>/dev/null | head -1)
  if [[ -n "${PLEX_TOKEN:-}" ]]; then
    echo "PLEX_TOKEN=${PLEX_TOKEN}"
  else
    warn "No PlexOnlineToken in Preferences.xml — sign in to Plex first"
  fi
else
  warn "Not readable: ${PLEX_PREFS} (needs root; Plex runs as the plex user)"
fi

# --- Gluetun control server ------------------------------------------------
GLUETUN_AUTH="${DOCKER_ROOT}/gluetun/auth/config.toml"
if [[ -r "$GLUETUN_AUTH" ]]; then
  echo "# Gluetun control server auth config exists at ${GLUETUN_AUTH}"
  echo "# Add an apikey role there, then set:"
  echo "# GLUETUN_CONTROL_URL=http://10.0.40.100:8000"
  echo "# GLUETUN_API_KEY=<the key you configured>"
else
  warn "No Gluetun auth config at ${GLUETUN_AUTH}"
fi

echo "# --- end of extracted keys ---"
