#!/usr/bin/env bash
#
# Fresh build of the Streamanator Dashboard, in place on the server.
#
#   ./scripts/rebuild.sh              # rebuild the venv, verify, swap in
#   ./scripts/rebuild.sh --dry-run    # show what it would do
#   ./scripts/rebuild.sh --keep-old   # leave .venv.old behind for inspection
#
# Run this on the server, after `scripts/deploy.sh` has put the current code
# there. It rebuilds the virtualenv from scratch — the thing a redeploy never
# does — and re-verifies the result.
#
# WHY IT BUILDS BESIDE THE RUNNING ONE
#
# The obvious version of this script is `rm -rf .venv && python3 -m venv .venv
# && pip install`. That leaves the dashboard dead for the several minutes pip
# takes, and dead permanently if pip fails halfway — no wheel cache, no
# network, a yanked release. So the new environment is built as `.venv.new`,
# the full test suite is run against it, and only then is it swapped in. The
# old one is kept until the restarted service answers on HTTP, and put back if
# it does not.
#
# WHAT IT NEVER TOUCHES
#
#   .env                  API keys and secrets
#   var/accounts.json     admin accounts and password hashes
#   var/audit.log         the privileged-action audit trail
#   var/history.sqlite3   400 days of metric history
#   var/notifications.json, var/probes.json
#
# All of it is snapshotted to the home directory first anyway, because "never
# touches" is a claim about this script and not about the disk.
#
set -uo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/arm/projects/streamanator_dashboard}"
SERVICE_NAME="${SERVICE_NAME:-streamanator-dashboard}"
PORT="${DASHBOARD_PORT:-8600}"
#: Other Streamlit apps on this host. Checked after the restart, because the
#: restart path shares a process-matching pattern with them.
NEIGHBOURS="${NEIGHBOURS:-6969 8501}"

DRY_RUN=false
KEEP_OLD=false

info()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m!!!\033[0m %s\n' "$*"; }
fail()  { printf '\033[31mERR\033[0m %s\n' "$*" >&2; exit 1; }
run()   { if $DRY_RUN; then printf '    would run: %s\n' "$*"; else "$@"; fi; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)  DRY_RUN=true ;;
        --keep-old) KEEP_OLD=true ;;
        -h|--help)  sed -n '2,40p' "$0"; exit 0 ;;
        *)          fail "unknown option: $1 (try --help)" ;;
    esac
    shift
done

cd "$PROJECT_DIR" || fail "no such directory: $PROJECT_DIR"
[[ -f app.py ]] || fail "app.py not found in $PROJECT_DIR"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

info "Preflight"

command -v python3 >/dev/null || fail "python3 not found"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
    || fail "Python 3.10+ required, found $(python3 --version)"
printf '    python: %s\n' "$(python3 --version)"

# A venv is a few hundred MB and a half-written one is worse than none.
available_mb=$(df -Pm . | awk 'NR==2 {print $4}')
[[ "${available_mb:-0}" -ge 2048 ]] \
    || fail "only ${available_mb}MB free; want at least 2048MB to build a venv"
printf '    disk:   %sMB free\n' "$available_mb"

[[ -f requirements.txt ]] || fail "requirements.txt is missing — deploy the code first"
REQUIREMENTS="requirements.txt"
# Dev requirements include the runtime ones and add pytest, which this script
# needs in order to verify the build it just made.
[[ -f requirements-dev.txt ]] && REQUIREMENTS="requirements-dev.txt"
printf '    deps:   %s\n' "$REQUIREMENTS"

for leftover in .venv.new .venv.failed; do
    if [[ -d "$leftover" ]]; then
        warn "leftover $leftover from an earlier run — removing it"
        run rm -rf "$leftover"
    fi
done

# ---------------------------------------------------------------------------
# Snapshot the things that are not in git and cannot be regenerated
# ---------------------------------------------------------------------------

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAPSHOT="$HOME/streamanator-state-$STAMP.tar.gz"

info "Snapshotting secrets and runtime state to $SNAPSHOT"
STATE=()
for item in .env var/accounts.json var/audit.log var/history.sqlite3 \
            var/notifications.json var/probes.json; do
    [[ -e "$item" ]] && STATE+=("$item")
done
if [[ ${#STATE[@]} -eq 0 ]]; then
    warn "no state found to snapshot — a first install, or the wrong directory"
else
    run tar czf "$SNAPSHOT" "${STATE[@]}" \
        || fail "snapshot failed — refusing to rebuild without one"
    $DRY_RUN || printf '    %s\n' "$(du -h "$SNAPSHOT" | cut -f1) — ${#STATE[@]} item(s)"
fi

# ---------------------------------------------------------------------------
# Build the new environment beside the running one
# ---------------------------------------------------------------------------

info "Building a fresh virtualenv in .venv.new (the running one is untouched)"
run python3 -m venv .venv.new || fail "could not create .venv.new"
run ./.venv.new/bin/python -m pip install --quiet --upgrade pip \
    || fail "could not upgrade pip in the new venv"
run ./.venv.new/bin/pip install --quiet -r "$REQUIREMENTS" \
    || fail "dependency install failed — the running venv is untouched, nothing to undo"

if ! $DRY_RUN; then
    printf '    streamlit: %s\n' \
        "$(./.venv.new/bin/streamlit version 2>/dev/null || echo unknown)"
fi

# Bytecode from the old interpreter must not be inherited by the new one.
info "Clearing bytecode caches"
run bash -c "find . -path ./.venv -prune -o -path ./.venv.new -prune -o \
    -name __pycache__ -type d -print0 2>/dev/null | xargs -0 -r rm -rf"

# ---------------------------------------------------------------------------
# Verify before committing to it
# ---------------------------------------------------------------------------

if $DRY_RUN; then
    info "Dry run — stopping before the test run and the swap."
    run rm -rf .venv.new
    exit 0
fi

if ./.venv.new/bin/python -c 'import pytest' 2>/dev/null; then
    info "Running the test suite against the new venv"
    if ! ./.venv.new/bin/python -m pytest tests/ -q; then
        rm -rf .venv.new
        fail "tests failed against the new environment — nothing was swapped, \
the dashboard is still running on the old venv"
    fi
else
    warn "pytest is not installed; skipping verification"
    warn "install requirements-dev.txt to have the rebuild verify itself"
fi

# ---------------------------------------------------------------------------
# Swap and restart
# ---------------------------------------------------------------------------

restart_service() {
    if systemctl cat "$SERVICE_NAME.service" >/dev/null 2>&1; then
        sudo systemctl restart "$SERVICE_NAME"
    elif [[ -x scripts/restart-dev.sh ]]; then
        ./scripts/restart-dev.sh
    else
        warn "no systemd unit and no scripts/restart-dev.sh — cannot restart"
        return 1
    fi
}

health_check() {
    local i code
    for i in $(seq 1 30); do
        code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
            "http://127.0.0.1:${PORT}/_stcore/health" 2>/dev/null)
        if [[ "$code" == "200" ]]; then
            info "Health check OK after ${i}s"
            return 0
        fi
        sleep 1
    done
    warn "no 200 from 127.0.0.1:${PORT}/_stcore/health after 30s"
    return 1
}

relocate_venv() {
    # A virtualenv records its own absolute path in the shebang of every
    # console script it installs, and in the activate scripts. Building at
    # .venv.new and renaming it to .venv leaves all of them pointing at a
    # directory that no longer exists.
    #
    # The failure this produces is actively misleading: the kernel reports the
    # *script* as missing — "failed to run command '.venv/bin/streamlit': No
    # such file or directory" — when streamlit is sitting right there and it is
    # the interpreter on line 1 that is gone.
    local from="$PROJECT_DIR/.venv.new"
    local to="$PROJECT_DIR/.venv"
    grep -rIlZ -- "$from" .venv/bin/ 2>/dev/null | xargs -0 -r sed -i "s|$from|$to|g"
    [[ -f .venv/pyvenv.cfg ]] && sed -i "s|$from|$to|g" .venv/pyvenv.cfg
    return 0
}

venv_smoke_test() {
    # Run at the final path, after relocation. Testing the venv only where it
    # was built is what let a broken swap reach the restart last time.
    ./.venv/bin/python -c 'import streamlit, altair, pandas, requests' 2>/dev/null \
        && ./.venv/bin/streamlit version >/dev/null 2>&1
}

restore_old_venv() {
    rm -rf .venv.failed
    mv .venv .venv.failed
    mv .venv.old .venv
}

info "Swapping the new venv in"
rm -rf .venv.old .venv.failed
mv .venv .venv.old || fail "could not move the old venv aside"
mv .venv.new .venv || {
    mv .venv.old .venv
    fail "could not move the new venv into place — the old one is back"
}

info "Repointing the new venv at its final path"
relocate_venv

if ! venv_smoke_test; then
    warn "the swapped-in venv cannot import the dashboard's dependencies"
    restore_old_venv
    fail "swap reverted before restarting, so the dashboard never went down. \
The failed build is in .venv.failed."
fi
info "Smoke test passed: $(./.venv/bin/streamlit version)"

restart_service
if health_check; then
    info "Rebuild complete on the new environment"
else
    warn "the rebuilt dashboard is not answering — rolling back to .venv.old"
    restore_old_venv
    restart_service
    if health_check; then
        fail "rolled back; the previous environment is running again. \
The failed build is in .venv.failed and the logs are above."
    fi
    fail "ROLLBACK IS ALSO UNHEALTHY — investigate on the host. \
State snapshot: $SNAPSHOT"
fi

# Neighbours share the restart path's process-matching pattern, and one of
# them has been taken down by it before. Checked every time, not just when
# something looks wrong.
for neighbour in $NEIGHBOURS; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
        "http://127.0.0.1:${neighbour}/" 2>/dev/null)
    if [[ "$code" == "200" ]]; then
        info "Neighbour on ${neighbour}: OK"
    else
        warn "Neighbour on ${neighbour} returned '${code}' — check it"
    fi
done

if $KEEP_OLD; then
    info "Keeping the previous venv at .venv.old"
else
    info "Removing the previous venv"
    rm -rf .venv.old
fi

cat <<EOF

  Fresh build complete.

  URL:       http://$(hostname -I | awk '{print $1}'):${PORT}
  Python:    $(./.venv/bin/python --version)
  Streamlit: $(./.venv/bin/streamlit version 2>/dev/null || echo unknown)
  State:     $SNAPSHOT

EOF
