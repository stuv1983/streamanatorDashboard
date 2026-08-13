#!/usr/bin/env bash
#
# Incremental deploy of the Streamanator Dashboard to the server.
#
# Sends only the files whose contents actually differ from the server's copy,
# backs the server copy up first, restarts the service, waits for it to answer
# on HTTP, and rolls back to the backup if it does not.
#
#   ./scripts/deploy.sh                  # deploy changed files, restart, verify
#   ./scripts/deploy.sh --dry-run        # show what would be sent, send nothing
#   ./scripts/deploy.sh --prune          # also delete server files no longer in the repo
#   ./scripts/deploy.sh --force-restart  # restart even if nothing changed
#   ./scripts/deploy.sh --rollback       # restore the most recent backup
#   ./scripts/deploy.sh --list-backups
#
# Runs from Git Bash on Windows or from any Linux/WSL shell. It needs only
# ssh + tar + sha256sum, all of which Git Bash already ships — deliberately no
# rsync dependency, because rsync is not present on this workstation.
#
# Use key-based SSH auth. The script opens three SSH connections (manifest,
# upload, and — for --list-backups — a listing), so password auth means typing
# the password more than once.
#
# WHAT GETS SENT
#   `git ls-files --cached --others --exclude-standard`, i.e. every tracked
#   file plus new files that are not gitignored. That means .env, var/, .venv/
#   and Home-Network-README.md are excluded by the same rules that keep them
#   out of the repository — the server's secrets and runtime state are never
#   touched by a deploy.
#
set -uo pipefail

# ---------------------------------------------------------------------------
# Configuration (override with flags or environment)
# ---------------------------------------------------------------------------

SSH_TARGET="${DEPLOY_HOST:-arm@10.0.40.100}"
REMOTE_DIR="${DEPLOY_DIR:-/home/arm/projects/streamanator_dashboard}"
SERVICE_NAME="${SERVICE_NAME:-streamanator-dashboard}"
PORT="${DASHBOARD_PORT:-8600}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"
SSH_OPTS="${SSH_OPTS:-}"

DRY_RUN=false
PRUNE=false
FORCE_RESTART=false
NO_RESTART=false
MODE=deploy

info()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m!!!\033[0m %s\n' "$*"; }
fail()  { printf '\033[31mERR\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)       DRY_RUN=true ;;
        --prune)         PRUNE=true ;;
        --force-restart) FORCE_RESTART=true ;;
        --no-restart)    NO_RESTART=true ;;
        --rollback)      MODE=rollback ;;
        --list-backups)  MODE=list-backups ;;
        --host)          SSH_TARGET="$2"; shift ;;
        --dir)           REMOTE_DIR="$2"; shift ;;
        --port)          PORT="$2"; shift ;;
        -h|--help)       sed -n '2,30p' "$0"; exit 0 ;;
        *)               fail "unknown option: $1 (try --help)" ;;
    esac
    shift
done

# shellcheck disable=SC2086  # SSH_OPTS is intentionally word-split
ssh_run() { ssh $SSH_OPTS "$SSH_TARGET" "$@"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || fail "cannot enter repository root"
[[ -f app.py ]] || fail "app.py not found in ${REPO_ROOT} — wrong directory?"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# Simple remote-only modes
# ---------------------------------------------------------------------------

if [[ "$MODE" == "list-backups" ]]; then
    info "Backups on ${SSH_TARGET}:${REMOTE_DIR}/var/deploy-backups"
    ssh_run "ls -lh '${REMOTE_DIR}/var/deploy-backups' 2>/dev/null || echo '(none yet)'"
    exit $?
fi

# ---------------------------------------------------------------------------
# Local manifest
#
# Hash every deployable file. sha256sum in Git Bash hashes in binary mode, so
# the digests match the server's byte-for-byte as long as the working tree is
# LF (core.autocrlf is false in this repo — do not turn it on, or every file
# would look changed on every deploy and would land on Linux with CRLF).
# ---------------------------------------------------------------------------

# Normalise `HASH  path` / `HASH *path` to HASH<TAB>path so awk can split on a
# tab and paths containing spaces survive.
normalise='s/^\([0-9a-f]\{64\}\)[ *]\{1,2\}/\1\t/'

if [[ "$MODE" == "deploy" ]]; then
    git ls-files --cached --others --exclude-standard -z > "$TMP/files.z" \
        || fail "git ls-files failed (is this a git repository?)"
    [[ -s "$TMP/files.z" ]] || fail "no deployable files found"

    xargs -0 sha256sum < "$TMP/files.z" | sed "$normalise" | sort -t $'\t' -k2 \
        > "$TMP/local.man"
    tr '\0' '\n' < "$TMP/files.z" | sort > "$TMP/local.list"
    info "Local files: $(wc -l < "$TMP/local.man" | tr -d ' ')"
fi

# ---------------------------------------------------------------------------
# Remote manifest
#
# One SSH round trip: confirm the project directory, hash the remote tree with
# the same exclusions git applies, and report how the service is managed.
# ---------------------------------------------------------------------------

REMOTE_PROBE=$(cat <<EOF
set -u
cd '${REMOTE_DIR}' 2>/dev/null || { echo "MISSING_DIR"; exit 0; }
echo "OK_DIR"
if systemctl cat '${SERVICE_NAME}.service' >/dev/null 2>&1; then
    echo "MANAGED systemd"
elif [ -x scripts/restart-dev.sh ]; then
    echo "MANAGED script"
else
    echo "MANAGED none"
fi
[ -x .venv/bin/python ] && echo "VENV yes" || echo "VENV no"
echo "MANIFEST"
find . -type f \\
    -not -path './.venv/*' -not -path './var/*' -not -path './.git/*' \\
    -not -path '*/__pycache__/*' -not -path './.pytest_cache/*' \\
    -not -path './.ruff_cache/*' -not -path './.mypy_cache/*' \\
    -not -name '*.pyc' -not -name '*.log' \\
    -not -name '.env' -not -name '.env.bak*' \\
    -not -name '*.pem' -not -name '*.crt' -not -name '*.key' \\
    -not -name '*.sqlite3*' -not -name 'secrets.toml' \\
    -not -name 'Home-Network-README.md' \\
    -print0 | xargs -0 -r sha256sum
EOF
)

info "Reading server state from ${SSH_TARGET}:${REMOTE_DIR}"
ssh_run "bash -s" <<< "$REMOTE_PROBE" > "$TMP/probe.out" \
    || fail "SSH to ${SSH_TARGET} failed"

grep -q '^OK_DIR$' "$TMP/probe.out" \
    || fail "${REMOTE_DIR} does not exist on ${SSH_TARGET} — run scripts/install.sh there first"

MANAGED=$(awk '/^MANAGED /{print $2}' "$TMP/probe.out")
HAS_VENV=$(awk '/^VENV /{print $2}' "$TMP/probe.out")
# `find .` yields ./-prefixed paths; strip that so the keys match the local
# manifest's repo-relative ones.
sed -n '/^MANIFEST$/,$p' "$TMP/probe.out" | tail -n +2 \
    | sed -e "$normalise" -e 's|\t\./|\t|' | sort -t $'\t' -k2 > "$TMP/remote.man"

info "Service management: ${MANAGED}   venv: ${HAS_VENV}   remote files: $(wc -l < "$TMP/remote.man" | tr -d ' ')"
[[ "$MANAGED" == "none" ]] && warn "no systemd unit and no scripts/restart-dev.sh on the server — cannot restart"

# ---------------------------------------------------------------------------
# Rollback mode short-circuits the diff entirely
# ---------------------------------------------------------------------------

if [[ "$MODE" == "rollback" ]]; then
    CHANGED_COUNT=0
    : > "$TMP/changed.list"
    : > "$TMP/deletions.list"
else
    # New or modified: present locally with a different (or absent) remote hash.
    awk -F '\t' 'NR==FNR { r[$2]=$1; next }
                 !($2 in r) || r[$2] != $1 { print $2 }' \
        "$TMP/remote.man" "$TMP/local.man" | sort > "$TMP/changed.list"

    # Present on the server, gone from the repo. Never a candidate for deletion
    # unless --prune is given, and never anything under var/ or .venv/.
    awk -F '\t' 'NR==FNR { l[$0]=1; next } !($2 in l) { print $2 }' \
        "$TMP/local.list" "$TMP/remote.man" \
        | grep -v -E '^(var/|\.venv/|\.env($|\.))' | sort > "$TMP/deletions.list"

    CHANGED_COUNT=$(wc -l < "$TMP/changed.list" | tr -d ' ')
    DELETE_COUNT=$(wc -l < "$TMP/deletions.list" | tr -d ' ')

    if [[ "$CHANGED_COUNT" -eq 0 ]]; then
        info "No file differs from the server."
    else
        info "${CHANGED_COUNT} file(s) to send:"
        sed 's/^/      /' "$TMP/changed.list"
    fi

    if [[ "$DELETE_COUNT" -gt 0 ]]; then
        if $PRUNE; then
            warn "${DELETE_COUNT} file(s) will be DELETED on the server:"
        else
            warn "${DELETE_COUNT} file(s) exist on the server but not in the repo (use --prune to remove):"
            : > "$TMP/deletions.list"
        fi
        sed 's/^/      /' "$TMP/deletions.list" 2>/dev/null
    fi

    if $DRY_RUN; then
        info "Dry run — nothing sent."
        exit 0
    fi

    if [[ "$CHANGED_COUNT" -eq 0 && "$DELETE_COUNT" -eq 0 ]] && ! $FORCE_RESTART; then
        info "Nothing to do. Use --force-restart to restart anyway."
        exit 0
    fi
fi

RESTART=true
$NO_RESTART && RESTART=false

# ---------------------------------------------------------------------------
# The remote half.
#
# Backup first, then apply, then restart, then verify — and if the verify
# fails, put the backup back and restart again. The dashboard is never left in
# a state where a bad deploy is running unverified.
# ---------------------------------------------------------------------------

cat > "$TMP/apply.sh" <<'APPLY'
#!/usr/bin/env bash
set -uo pipefail
STAGE="$1"
. "$STAGE/deploy.env"

info()  { printf '\033[36m  ->\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m  !!\033[0m %s\n' "$*"; }
fail()  { printf '\033[31m  ERR\033[0m %s\n' "$*" >&2; exit 1; }

cd "$REMOTE_DIR" || fail "cannot enter $REMOTE_DIR"

BACKUP_DIR="var/deploy-backups"
mkdir -p "$BACKUP_DIR"

TAR_EXCLUDES=(
    '--exclude=./.venv' '--exclude=./var' '--exclude=./.git'
    '--exclude=__pycache__' '--exclude=./.pytest_cache'
    '--exclude=./.ruff_cache' '--exclude=./.mypy_cache'
    '--exclude=./.env' '--exclude=*.pyc' '--exclude=*.log'
)

restart_service() {
    if [ "$MANAGED" = "systemd" ]; then
        info "systemctl restart $SERVICE_NAME"
        sudo systemctl restart "$SERVICE_NAME" || return 1
    elif [ "$MANAGED" = "script" ]; then
        info "scripts/restart-dev.sh"
        ./scripts/restart-dev.sh || return 1
    else
        warn "no restart mechanism available — skipping restart"
    fi
    return 0
}

# Streamlit's health endpoint answers as soon as the server loop is up, which
# is the earliest honest signal that the app imported cleanly.
health_check() {
    local i code
    for i in $(seq 1 30); do
        code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
            "http://127.0.0.1:${PORT}/_stcore/health" 2>/dev/null)
        if [ "$code" = "200" ]; then
            info "health check OK after ${i}s (http $code)"
            return 0
        fi
        sleep 1
    done
    warn "health check FAILED — no 200 from 127.0.0.1:${PORT}/_stcore/health after 30s"
    return 1
}

show_logs() {
    if [ "$MANAGED" = "systemd" ]; then
        journalctl -u "$SERVICE_NAME" -n 30 --no-pager 2>/dev/null
    else
        tail -30 var/dashboard.log 2>/dev/null
    fi
}

# --- Rollback ---------------------------------------------------------------

if [ "$MODE" = "rollback" ]; then
    LATEST=$(ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | head -1)
    [ -n "$LATEST" ] || fail "no backup found in $REMOTE_DIR/$BACKUP_DIR"
    info "restoring $LATEST"
    tar xzf "$LATEST" -C . || fail "restore failed"
    find . -path ./.venv -prune -o -name __pycache__ -type d -print0 2>/dev/null \
        | xargs -0 -r rm -rf
    restart_service || fail "restart failed after rollback"
    health_check || { show_logs; fail "service unhealthy after rollback"; }
    info "rollback complete"
    exit 0
fi

# --- Backup -----------------------------------------------------------------

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$BACKUP_DIR/$STAMP.tar.gz"
info "backing up current tree to $BACKUP"
tar czf "$BACKUP" "${TAR_EXCLUDES[@]}" . 2>/dev/null \
    || fail "backup failed — refusing to deploy over an unbacked-up tree"

# Keep the last N; a backup is ~1 MB, but this directory would otherwise grow
# forever on a host whose whole point is watching disks fill up.
ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -n "+$((KEEP_BACKUPS + 1))" \
    | xargs -r rm -f

# --- Apply ------------------------------------------------------------------

if [ -d "$STAGE/payload" ]; then
    info "applying changed files"
    cp -a "$STAGE/payload/." . || fail "copy failed"
fi

if [ -s "$STAGE/deletions.list" ]; then
    info "pruning removed files"
    while IFS= read -r f; do
        case "$f" in
            ''|.env|var/*|.venv/*|../*|/*) warn "skipping $f"; continue ;;
        esac
        rm -f -- "$f" && echo "     deleted $f"
    done < "$STAGE/deletions.list"
    # Drop directories the prune emptied, but never the project root and never
    # anything git, the venv or the runtime state owns.
    find . -mindepth 1 -type d -empty \
        -not -path './.venv' -not -path './.venv/*' \
        -not -path './var' -not -path './var/*' \
        -not -path './.git' -not -path './.git/*' \
        -delete 2>/dev/null
fi

# Bytecode caches are keyed on source mtime, and a deployed file carries its
# mtime from the workstation — which can be older than the .pyc the server
# already built. Clearing them removes any chance of running stale code.
find . -path ./.venv -prune -o -name __pycache__ -type d -print0 2>/dev/null \
    | xargs -0 -r rm -rf

if [ "$DEPS_CHANGED" = "true" ]; then
    if [ -x .venv/bin/pip ]; then
        info "requirements.txt changed — installing dependencies"
        .venv/bin/pip install --quiet -r requirements.txt \
            || warn "pip install reported errors"
    else
        warn "requirements.txt changed but .venv is missing — dependencies NOT installed"
    fi
fi

# --- Restart and verify -----------------------------------------------------

if [ "$RESTART" != "true" ]; then
    info "restart skipped (--no-restart). Changes are on disk but not live."
    exit 0
fi

if restart_service && health_check; then
    info "deploy OK"
    exit 0
fi

warn "deploy failed verification — rolling back to $BACKUP"
show_logs
tar xzf "$BACKUP" -C . || fail "ROLLBACK FAILED — server left in a bad state, backup: $BACKUP"
find . -path ./.venv -prune -o -name __pycache__ -type d -print0 2>/dev/null \
    | xargs -0 -r rm -rf
restart_service
if health_check; then
    fail "deploy rolled back; the previous version is running again"
fi
fail "ROLLBACK RESTART UNHEALTHY — investigate on the host. Backup: $REMOTE_DIR/$BACKUP"
APPLY

DEPS_CHANGED=false
grep -qx 'requirements.txt' "$TMP/changed.list" 2>/dev/null && DEPS_CHANGED=true

cat > "$TMP/deploy.env" <<EOF
REMOTE_DIR='${REMOTE_DIR}'
SERVICE_NAME='${SERVICE_NAME}'
PORT='${PORT}'
MANAGED='${MANAGED}'
MODE='${MODE}'
RESTART='${RESTART}'
DEPS_CHANGED='${DEPS_CHANGED}'
KEEP_BACKUPS='${KEEP_BACKUPS}'
EOF

[[ -f "$TMP/deletions.list" ]] || : > "$TMP/deletions.list"

# The payload carries the apply script with it, so the whole remote half is one
# SSH connection: the command comes from argv, the archive from stdin.
tar -cf "$TMP/payload.tar" -C "$TMP" apply.sh deploy.env deletions.list \
    || fail "could not build payload"
if [[ -s "$TMP/changed.list" ]]; then
    tar -rf "$TMP/payload.tar" --transform='s,^,payload/,' \
        -T "$TMP/changed.list" || fail "could not add changed files to payload"
fi
gzip -f "$TMP/payload.tar"

info "Uploading $(du -h "$TMP/payload.tar.gz" | cut -f1 | tr -d ' ') to ${SSH_TARGET}"

ssh_run 'set -e
d=$(mktemp -d /tmp/streamanator-deploy.XXXXXX)
tar xzf - -C "$d"
set +e
bash "$d/apply.sh" "$d"
rc=$?
rm -rf "$d"
exit $rc' < "$TMP/payload.tar.gz"

RC=$?
if [[ $RC -eq 0 ]]; then
    info "Done. http://${SSH_TARGET#*@}:${PORT}"
else
    fail "Deploy failed (exit ${RC}). Roll back with: ./scripts/deploy.sh --rollback"
fi
