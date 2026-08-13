#!/usr/bin/env bash
# Restart the dashboard when it runs detached rather than under systemd.
#
# Use this instead of typing a pkill on the command line. Two hazards, both
# already hit once on this host:
#
#   1. `pkill -f` matches a process's *full argv*, so an SSH command whose own
#      text contains the pattern matches itself and kills the session halfway
#      through the restart. Keeping the pattern inside a file avoids that
#      entirely — a script's argv is just its own path.
#
#   2. `pkill -f "streamlit run app.py"` also matches Sports Data Lab (6969)
#      and AquaLog (8501), which run the identical command. On 13 Aug that
#      pattern took Sports Data Lab down for twelve minutes. The port is part
#      of the pattern below for exactly that reason.
#
# Prefer the systemd unit where it is installed:
#   sudo systemctl restart streamanator-dashboard
set -uo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/arm/projects/streamanator_dashboard}"
PORT="${DASHBOARD_PORT:-8600}"
PATTERN="streamlit run app.py --server.port ${PORT}"

cd "$PROJECT_DIR" || { echo "no such directory: $PROJECT_DIR" >&2; exit 1; }

running=$(pgrep -f "$PATTERN" || true)
if [ -n "$running" ]; then
    echo "stopping pid(s): $running"
    pkill -f "$PATTERN"
    sleep 3
fi

mkdir -p var && chmod 700 var

setsid nohup .venv/bin/streamlit run app.py \
    --server.port "$PORT" \
    --server.address 0.0.0.0 \
    --server.headless true \
    --server.fileWatcherType none \
    --browser.gatherUsageStats false \
    > var/dashboard.log 2>&1 < /dev/null &

sleep 12

started=$(pgrep -f "$PATTERN" || true)
if [ -z "$started" ]; then
    echo "FAILED to start. Last log lines:" >&2
    tail -20 var/dashboard.log >&2
    exit 1
fi
echo "started pid(s): $started"

code=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "http://127.0.0.1:${PORT}/")
echo "http ${PORT} -> ${code}"

# Confirm the neighbours are still up — the check that would have caught the
# Sports Data Lab outage immediately instead of twelve minutes later.
for neighbour in 6969 8501; do
    neighbour_code=$(curl -s -o /dev/null -w "%{http_code}" -m 20 \
        "http://127.0.0.1:${neighbour}/")
    echo "http ${neighbour} -> ${neighbour_code}"
done
