#!/usr/bin/env bash
# Stop the monitoring stack and, optionally, forget the dashboard's link to it.
#
#   ./teardown.sh              # stop containers; keep data volumes and .env
#   ./teardown.sh --volumes    # also delete Prometheus history and Grafana state
#   ./teardown.sh --unwire     # also remove PROMETHEUS_URL/GRAFANA_URL from the
#                              # dashboard .env, so it falls back to local history
#
# Stopping the stack is safe: the dashboard degrades to its own SQLite history
# store the moment Prometheus is gone. It does not break — it just loses the
# longer retention and the Grafana views.
set -euo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_ENV="$(cd "$STACK_DIR/../.." && pwd)/.env"

REMOVE_VOLUMES=0
UNWIRE=0
for arg in "$@"; do
    case "$arg" in
        --volumes) REMOVE_VOLUMES=1 ;;
        --unwire)  UNWIRE=1 ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

cd "$STACK_DIR"

if [ "$REMOVE_VOLUMES" -eq 1 ]; then
    echo "Stopping the stack and DELETING data volumes (Prometheus history, Grafana state)…"
    docker compose down --volumes
else
    echo "Stopping the stack (data volumes preserved)…"
    docker compose down
fi
echo "Stopped."

if [ "$UNWIRE" -eq 1 ] && [ -f "$DASHBOARD_ENV" ]; then
    tmp="$(mktemp)"
    grep -v -E '^(PROMETHEUS_URL|GRAFANA_URL)=' "$DASHBOARD_ENV" > "$tmp" || true
    mv "$tmp" "$DASHBOARD_ENV"
    chmod 600 "$DASHBOARD_ENV"
    echo "Removed PROMETHEUS_URL and GRAFANA_URL from the dashboard .env."
    echo "Restart the dashboard to fall back to local history:"
    echo "  sudo systemctl restart streamanator-dashboard"
fi
