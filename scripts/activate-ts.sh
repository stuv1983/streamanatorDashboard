#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/arm/projects/streamanator_dashboard"
SERVICE="streamanator-dashboard"

[[ "$(realpath "$ROOT")" == "$ROOT" ]] || {
  echo "Refusing to operate on unexpected project path: $ROOT" >&2
  exit 1
}
[[ -f "$ROOT/web/package.json" && -f "$ROOT/deploy/streamanator-dashboard.service" ]] || {
  echo "TypeScript build or service unit is missing under $ROOT" >&2
  exit 1
}

systemctl stop "$SERVICE"

rm -rf -- \
  "$ROOT/.venv" \
  "$ROOT/.venv.old" \
  "$ROOT/__pycache__" \
  "$ROOT/.pytest_cache" \
  "$ROOT/.ruff_cache" \
  "$ROOT/admin" \
  "$ROOT/app_pages" \
  "$ROOT/auth" \
  "$ROOT/components" \
  "$ROOT/core" \
  "$ROOT/health" \
  "$ROOT/queries" \
  "$ROOT/services" \
  "$ROOT/tests" \
  "$ROOT/utils" \
  "$ROOT/scripts/__pycache__"

install -m 0644 \
  "$ROOT/deploy/streamanator-dashboard.service" \
  "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE"

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:8600/api/health" >/dev/null; then
    echo "TypeScript dashboard is live on port 8600."
    exit 0
  fi
  sleep 1
done

systemctl status "$SERVICE" --no-pager || true
echo "Dashboard did not become healthy on port 8600." >&2
exit 1
