#!/usr/bin/env bash
# deploy-hooks.sh — PM2 deploy hook integration
# Called by PM2 on_restart / on_online / on_stop lifecycle events
#
# Usage: deploy-hooks.sh <event> [extra args...]
# Events: restart, online, stop

set -euo pipefail

LOG_DIR="${PM2_LOGS_PATH:-/home/scott/.pm2/logs}"
HEALTH_LOG="$LOG_DIR/deploy-events.log"
APP_NAME="${PM2_APP_NAME:-unknown}"
WORKDIR="/home/scott/h2h-arbitrage"

log_event() {
  printf '[%s] %s (%s) — %s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$APP_NAME" "${2:-}" >> "$HEALTH_LOG"
}

check_health() {
  local base_url="${H2H_BASE_URL:-http://100.86.7.30:3000}"
  local retries=5
  local i=0

  while (( i < retries )); do
    if curl -sf "${base_url}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done

  return 1
}

case "${1:-}" in
  restart)
    log_event "RESTART" "Shutting down for restart"
    ;;

  online)
    if [[ "$APP_NAME" == "h2h-arbitrage" ]]; then
      if check_health; then
        log_event "ONLINE" "Health check passed"
      else
        log_event "ONLINE" "WARNING: Health check failed after ${retries} retries"
      fi
    else
      log_event "ONLINE" "Process started (skipping health check for $APP_NAME)"
    fi
    ;;

  stop)
    log_event "STOP" "Process stopped"
    ;;

  *)
    echo "Usage: $0 {restart|online|stop}" >&2
    exit 1
    ;;
esac

exit 0
