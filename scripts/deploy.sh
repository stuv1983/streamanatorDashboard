#!/usr/bin/env bash
# Deploy this working tree to the server.
#
#   scripts/deploy.sh             validate locally, ship, build, test, swap, restart
#   scripts/deploy.sh --dry-run   list what would be shipped and stop
#
# Works from Git Bash on Windows as well as Linux/macOS: it needs ssh and tar,
# not rsync. The live dashboard keeps serving the old build until the new one
# has built and passed the test suite on the server; then the two build
# directories are swapped and the service restarted. A failed build or test
# never touches the running service. A failed health check after the restart
# puts the previous build and source back and restarts again.
#
# Environment:
#   STREAMANATOR_SSH          ssh target            (default arm@streamanator)
#   STREAMANATOR_SSH_OPTS     extra ssh options     e.g. "-i ~/.ssh/key -o IdentitiesOnly=yes"
#   STREAMANATOR_REMOTE_DIR   project dir on server (default /home/arm/projects/streamanator_dashboard)
#   STREAMANATOR_SERVICE      systemd unit          (default streamanator-dashboard)
#   STREAMANATOR_SYSTEMCTL    how to drive it       (default "sudo -n systemctl"; "systemctl --user" for a user unit)
#   DASHBOARD_PORT            port to health-check  (default 8600)
#   STREAMANATOR_NODE_BIN     node on the server    (default /home/arm/.local/node-current/bin)
set -euo pipefail

SSH_TARGET="${STREAMANATOR_SSH:-arm@streamanator}"
read -r -a SSH_OPTS <<< "${STREAMANATOR_SSH_OPTS:-}"
REMOTE_DIR="${STREAMANATOR_REMOTE_DIR:-/home/arm/projects/streamanator_dashboard}"
SERVICE="${STREAMANATOR_SERVICE:-streamanator-dashboard}"
SYSTEMCTL="${STREAMANATOR_SYSTEMCTL:-sudo -n systemctl}"
PORT="${DASHBOARD_PORT:-8600}"
NODE_BIN="${STREAMANATOR_NODE_BIN:-/home/arm/.local/node-current/bin}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

cd "$ROOT"
[[ -f web/package-lock.json ]] || { echo "web/package-lock.json is missing" >&2; exit 1; }

# What ships: tracked and untracked-but-not-ignored files that exist. .env,
# var/, node_modules and build output are gitignored, so they never leave here.
MANIFEST="$(mktemp)"
trap 'rm -f "$MANIFEST"' EXIT
git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' f; do
  [[ -f "$f" ]] && printf '%s\n' "$f"
done > "$MANIFEST"
grep -qx ".env" "$MANIFEST" && { echo "Refusing to deploy: .env is not gitignored." >&2; exit 1; }

if $DRY_RUN; then
  cat "$MANIFEST"
  echo "$(wc -l < "$MANIFEST") files would be shipped to $SSH_TARGET:$REMOTE_DIR" >&2
  exit 0
fi

echo "Validating locally (tests, typecheck)..."
(cd web && npm run -s test 2>&1 | grep -E "^not ok|^# (pass|fail)" && npm run -s typecheck)

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
echo "Shipping $(wc -l < "$MANIFEST") files as release $STAMP..."
tar -czf - -T "$MANIFEST" \
  | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "mkdir -p '$REMOTE_DIR/var/deploy' && cat > '$REMOTE_DIR/var/deploy/$STAMP.tar.gz'"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cat > '$REMOTE_DIR/var/deploy/$STAMP.manifest'" < "$MANIFEST"

# ssh joins its arguments into one string for the remote shell, so each one
# is quoted here or "systemctl --user" would arrive as two.
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "bash -s -- $(printf '%q ' "$REMOTE_DIR" "$STAMP" "$SERVICE" "$PORT" "$NODE_BIN" "$SYSTEMCTL")" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1" STAMP="$2" SERVICE="$3" PORT="$4" NODE_BIN="$5"
read -r -a SYSTEMCTL <<< "$6"
export PATH="$NODE_BIN:$PATH"
cd "$REMOTE_DIR"
D=var/deploy
NEW_MANIFEST="$D/$STAMP.manifest"
OLD_MANIFEST="$D/current.manifest"
BACKUP="$D/backup-$STAMP.tar.gz"

safe_path() { [[ -n "$1" && "$1" != /* && "$1" != *..* && "$1" != .env && "$1" != var/* && "$1" != .git/* ]]; }

# Files the new release no longer has. Without a previous manifest (first
# deploy with this script) nothing is pruned.
removed_files() { [[ -f "$OLD_MANIFEST" ]] && comm -23 <(sort "$OLD_MANIFEST") <(sort "$NEW_MANIFEST") || true; }
added_files() { [[ -f "$OLD_MANIFEST" ]] && comm -13 <(sort "$OLD_MANIFEST") <(sort "$NEW_MANIFEST") || true; }

echo "[server] Backing up current source..."
tar -czf "$BACKUP" --exclude=./.git --exclude=./.env --exclude=./var --exclude=./web/node_modules \
  --exclude=./web/.next --exclude=./web/.next-build --exclude=./web/.next-prev --exclude=./web/.npm-cache \
  --exclude=./next_app --exclude='*.tar.gz' --exclude='*.zip' .
OLD_LOCK="$(sha256sum web/package-lock.json | cut -d' ' -f1)"

restore_source() {
  echo "[server] Restoring previous source from $BACKUP..."
  added_files | while IFS= read -r f; do if safe_path "$f"; then rm -f -- "$f"; fi; done
  tar -xzf "$BACKUP"
  if [[ "$(sha256sum web/package-lock.json | cut -d' ' -f1)" != "$NEW_LOCK" ]]; then
    (cd web && npm ci --no-audit --no-fund >/dev/null)
  fi
}

echo "[server] Unpacking release..."
tar -xzf "$D/$STAMP.tar.gz"
removed_files | while IFS= read -r f; do if safe_path "$f"; then rm -f -- "$f"; fi; done
NEW_LOCK="$(sha256sum web/package-lock.json | cut -d' ' -f1)"

cd web
if [[ "$NEW_LOCK" != "$OLD_LOCK" ]]; then
  echo "[server] Dependencies changed; npm ci..."
  npm ci --no-audit --no-fund >/dev/null
fi

echo "[server] Building into .next-build (the live build keeps serving)..."
rm -rf .next-build
if ! NEXT_DIST_DIR=.next-build npm run -s build > "../$D/build-$STAMP.log" 2>&1; then
  tail -30 "../$D/build-$STAMP.log" >&2
  echo "[server] Build failed; the running service was not touched." >&2
  rm -rf .next-build; cd ..; restore_source; exit 1
fi

echo "[server] Running tests..."
if ! npm run -s test > "../$D/test-$STAMP.log" 2>&1; then
  grep -E "^not ok|^# (pass|fail)" "../$D/test-$STAMP.log" >&2 || tail -30 "../$D/test-$STAMP.log" >&2
  echo "[server] Tests failed; the running service was not touched." >&2
  rm -rf .next-build; cd ..; restore_source; exit 1
fi

rollback() {
  echo "[server] $1; rolling back." >&2
  rm -rf .next-failed; mv .next .next-failed
  if [[ -d .next-prev ]]; then mv .next-prev .next; fi
  cd ..; restore_source
  "${SYSTEMCTL[@]}" restart "$SERVICE" || echo "[server] Restart after rollback ALSO failed; check the service by hand." >&2
  echo "[server] Previous build restored. The failed build is in web/.next-failed." >&2
  exit 1
}

echo "[server] Swapping builds and restarting $SERVICE..."
NEW_ID="$(cat .next-build/BUILD_ID)"
rm -rf .next-prev
if [[ -d .next ]]; then mv .next .next-prev; fi
mv .next-build .next
"${SYSTEMCTL[@]}" restart "$SERVICE" || rollback "Restart failed"

# Healthy means the NEW build answering: the live stream's hello carries the build id.
for _ in $(seq 1 45); do
  health="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  hello="$(curl -sN --max-time 3 "http://127.0.0.1:$PORT/api/live" 2>/dev/null | head -c 20000 || true)"
  if [[ "$health" == *'"ok":true'* && "$hello" == *"\"buildId\":\"$NEW_ID\""* ]]; then
    cd ..
    cp "$NEW_MANIFEST" "$OLD_MANIFEST"
    # Keep the last three backups and release archives; the root fs is not large.
    ls -1t $D/backup-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
    ls -1t $D/2*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
    ls -1t $D/2*.manifest $D/build-*.log $D/test-*.log 2>/dev/null | tail -n +10 | xargs -r rm -f
    echo "[server] Healthy on build $NEW_ID."
    exit 0
  fi
  sleep 1
done
if [[ " ${SYSTEMCTL[*]} " == *" --user "* ]]; then journalctl --user-unit "$SERVICE" -n 20 --no-pager >&2 || true; else journalctl -u "$SERVICE" -n 20 --no-pager >&2 || true; fi
rollback "Health check failed after restart"
REMOTE
echo "Deploy complete."
