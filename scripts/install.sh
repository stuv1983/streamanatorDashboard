#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${DASHBOARD_PORT:-8600}"
cd "$ROOT"

[[ -f web/package-lock.json ]] || { echo "web/package-lock.json is missing" >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js is required" >&2; exit 1; }
node -e 'const [major]=process.versions.node.split(".").map(Number); if (major < 22) process.exit(1)' || { echo "Node.js 22+ is required" >&2; exit 1; }

mkdir -p var
cd web
npm ci
npm run test
npm run typecheck
npm run build
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env; set ADMIN_PASSWORD and ADMIN_SESSION_SECRET before using Admin."
fi

if command -v systemctl >/dev/null && [[ "${INSTALL_SYSTEMD:-1}" == "1" ]]; then
  sudo install -m 0644 deploy/streamanator-dashboard.service /etc/systemd/system/streamanator-dashboard.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now streamanator-dashboard
else
  echo "Build complete. Start with: cd web && npm run start -- --hostname 0.0.0.0 --port $PORT"
fi

for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null && { echo "Dashboard healthy on port $PORT"; exit 0; }; sleep 1; done
echo "Dashboard did not become healthy" >&2
exit 1
