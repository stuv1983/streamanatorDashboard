#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${DASHBOARD_PORT:-8600}"
cd "$ROOT/web"
mkdir -p "$ROOT/var"
if [[ -f "$ROOT/var/dashboard.pid" ]]; then kill "$(cat "$ROOT/var/dashboard.pid")" 2>/dev/null || true; fi
nohup npm run dev -- --hostname 0.0.0.0 --port "$PORT" > "$ROOT/var/dashboard.log" 2>&1 &
echo $! > "$ROOT/var/dashboard.pid"
echo "Development dashboard started at http://127.0.0.1:$PORT"
