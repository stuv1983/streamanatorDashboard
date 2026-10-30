#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/web"
npm ci
npm run test
npm run typecheck
npm run build
if systemctl cat streamanator-dashboard.service >/dev/null 2>&1; then sudo systemctl restart streamanator-dashboard; fi
curl --retry 30 --retry-delay 1 --retry-all-errors -fsS "http://127.0.0.1:${DASHBOARD_PORT:-8600}/api/health" >/dev/null
echo "TypeScript dashboard rebuilt and healthy."
