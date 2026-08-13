#!/usr/bin/env bash
#
# Install the Streamanator Dashboard on streamanator.
#
# Read-only with respect to the existing system: it creates a virtualenv and a
# systemd unit, and touches nothing about Docker, the array or any existing
# service. Run as the `arm` user; it will ask for sudo only for the unit file.
#
#   ./scripts/install.sh
#
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/arm/projects/streamanator_dashboard}"
SERVICE_NAME="streamanator-dashboard"
PORT="${DASHBOARD_PORT:-8600}"

info()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m!!!\033[0m %s\n' "$*"; }
fail()  { printf '\033[31mERR\033[0m %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------------
# Preflight
# --------------------------------------------------------------------------

[[ -f "${PROJECT_DIR}/app.py" ]] || fail "app.py not found in ${PROJECT_DIR}"

info "Checking Python"
command -v python3 >/dev/null || fail "python3 not found"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
  || fail "Python 3.10+ required"
python3 --version

info "Checking that port ${PORT} is free"
if ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}$"; then
  fail "Port ${PORT} is already in use. Pick another with DASHBOARD_PORT=... and update the unit file."
fi
info "Port ${PORT} is available"

info "Checking Docker group membership"
if id -nG "$USER" | grep -qw docker; then
  info "User $USER is in the docker group — container monitoring will work"
else
  warn "User $USER is NOT in the docker group. Container health will show as unavailable."
  warn "Fix with: sudo usermod -aG docker $USER  (then log out and back in)"
fi

# --------------------------------------------------------------------------
# Virtualenv
# --------------------------------------------------------------------------

cd "${PROJECT_DIR}"

info "Creating virtualenv"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
./.venv/bin/python -m pip install --quiet --upgrade pip
info "Installing dependencies"
./.venv/bin/pip install --quiet -r requirements.txt
info "Installed: $(./.venv/bin/streamlit version 2>/dev/null || echo 'streamlit')"

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

if [[ ! -f .env ]]; then
  info "Creating .env from template"
  cp .env.example .env
  chmod 600 .env
  warn "Edit .env to add API keys. Run scripts/extract_api_keys.sh to populate them."
else
  info ".env already exists — leaving it alone"
  chmod 600 .env
fi

mkdir -p var
info "History store directory: ${PROJECT_DIR}/var"

# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------

if ./.venv/bin/python -c 'import pytest' 2>/dev/null; then
  info "Running tests"
  ./.venv/bin/python -m pytest tests/ -q || warn "Tests reported failures"
else
  info "pytest not installed; skipping tests (pip install -r requirements-dev.txt to enable)"
fi

# --------------------------------------------------------------------------
# systemd
# --------------------------------------------------------------------------

info "Installing systemd unit (requires sudo)"
sudo cp "deploy/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.service"
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

sleep 3
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  info "Service is running"
else
  warn "Service did not start. Check: journalctl -u ${SERVICE_NAME} -n 50"
  exit 1
fi

# --------------------------------------------------------------------------
# Verify
# --------------------------------------------------------------------------

info "Verifying HTTP endpoint"
for _ in {1..10}; do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/_stcore/health"; then
    info "Dashboard is responding on port ${PORT}"
    break
  fi
  sleep 2
done

cat <<EOF

  Streamanator Dashboard installed.

  URL:      http://$(hostname -I | awk '{print $1}'):${PORT}
  Logs:     journalctl -u ${SERVICE_NAME} -f
  Restart:  sudo systemctl restart ${SERVICE_NAME}
  Config:   ${PROJECT_DIR}/.env

  This dashboard is bound to an internal interface. Do NOT create a WAN
  port-forward for it.

  Next steps, highest value first:
    1. Deploy the monitoring stack for history and SMART data:
         cd deploy/monitoring-stack && cp .env.example .env && \$EDITOR .env
         docker compose up -d
         # then set PROMETHEUS_URL=http://127.0.0.1:9090 in ../../.env
    2. Populate application API keys:
         sudo ./scripts/extract_api_keys.sh >> .env
    3. Re-run validation:
         ./scripts/validate.sh

EOF
