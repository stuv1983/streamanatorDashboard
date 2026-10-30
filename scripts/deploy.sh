#!/usr/bin/env bash
set -euo pipefail

SSH_TARGET="${STREAMANATOR_SSH:-arm@streamanator}"
REMOTE_DIR="${STREAMANATOR_REMOTE_DIR:-/home/arm/projects/streamanator_dashboard}"
SERVICE="${STREAMANATOR_SERVICE:-streamanator-dashboard}"
PORT="${DASHBOARD_PORT:-8600}"
NODE_BIN="${STREAMANATOR_NODE_BIN:-/home/arm/.local/node-current/bin}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

cd "$ROOT"
[[ -f web/package-lock.json ]] || { echo "web/package-lock.json is missing" >&2; exit 1; }

echo "Validating local TypeScript build..."
(cd web && npm run test && npm run typecheck && npm run build)

if $DRY_RUN; then
  rsync -anv --exclude .git --exclude .env --exclude var --exclude web/node_modules --exclude web/.next --exclude web/.npm-cache --exclude web/tsconfig.tsbuildinfo --exclude next_build.tar.gz --exclude web.tar.gz ./ "$SSH_TARGET:$REMOTE_DIR/"
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ssh "$SSH_TARGET" "set -e; cd '$REMOTE_DIR'; mkdir -p var/deploy-backups; tar czf 'var/deploy-backups/$STAMP.tar.gz' --exclude=.git --exclude=.env --exclude=var --exclude=web/node_modules --exclude=web/.next ."
rsync -av --exclude .git --exclude .env --exclude var --exclude web/node_modules --exclude web/.next --exclude web/.npm-cache --exclude web/tsconfig.tsbuildinfo --exclude next_build.tar.gz --exclude web.tar.gz ./ "$SSH_TARGET:$REMOTE_DIR/"
ssh "$SSH_TARGET" "set -e; export PATH='$NODE_BIN':\"\$PATH\"; cd '$REMOTE_DIR/web'; npm ci; npm run build; sudo -n systemctl restart '$SERVICE'"

for _ in $(seq 1 45); do
  if ssh "$SSH_TARGET" "curl -fsS 'http://127.0.0.1:$PORT/api/health' >/dev/null"; then
    echo "Deploy complete and healthy."
    exit 0
  fi
  sleep 1
done

echo "Health check failed; restoring $STAMP backup." >&2
ssh "$SSH_TARGET" "set -e; export PATH='$NODE_BIN':\"\$PATH\"; cd '$REMOTE_DIR'; tar xzf 'var/deploy-backups/$STAMP.tar.gz'; cd web; npm ci; npm run build; sudo -n systemctl restart '$SERVICE'"
exit 1
