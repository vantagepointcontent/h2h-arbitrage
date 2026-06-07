#!/usr/bin/env bash
# pm2-crash-alert.sh — Detect crash storms and trigger alerts
#
# Monitors PM2 process restart counters. If any process exceeds 10 restarts
# per minute, an alert is logged and optionally forwarded to a webhook/email.
#
# Usage: pm2-crash-alert.sh [--alert-url URL]
#   --alert-url: POST JSON payload to this URL on alert (optional)
#
# Designed to run via cron every minute:
#   * * * * * /home/scott/h2h-arbitrage/scripts/pm2-crash-alert.sh --alert-url https://hooks.example.com/alerts

set -euo pipefail

THRESHOLD=10                          # max restarts per minute
STATE_FILE="/tmp/pm2-crash-state.json"
ALERT_LOG="/home/scott/.pm2/logs/crash-alerts.log"
ALERT_URL="${1:-}"

log_alert() {
    printf '[%s] CRASH ALERT: %s — restarts=%d (threshold: %d)\n' \
        "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2" "$THRESHOLD" >> "$ALERT_LOG"
}

# Parse PM2 list for process name and restart count
# Output: name=restarts pairs
parse_pm2_list() {
    pm2 list --json 2>/dev/null | jq -r '.[] | "\(.name)=\(.restart_time)"' \
        || echo ""
}

# Track state: { process_name: { last_count: N, last_check: epoch } }
load_state() {
    if [[ -f "$STATE_FILE" ]]; then
        cat "$STATE_FILE"
    else
        echo '{}'
    fi
}

save_state() {
    echo "$1" > "$STATE_FILE"
}

main() {
    local state
    state=$(load_state)
    local now
    now=$(date +%s)

    # Current PM2 stats
    local pm2_data
    pm2_data=$(parse_pm2_list)

    if [[ -z "$pm2_data" ]]; then
        exit 0
    fi

    local alerted=false
    local new_state="{}"

    while IFS='=' read -r name count; do
        [[ -z "$name" ]] && continue

        local prev_count prev_epoch
        prev_count=$(echo "$state" | jq -r ".\"$name\".last_count // 0")
        prev_epoch=$(echo "$state" | jq -r ".\"$name\".last_check // 0")

        local elapsed=$(( now - prev_epoch ))
        if (( elapsed >= 60 )); then
            # One minute window — calculate rate
            local delta=$(( count - prev_count ))
            if (( delta > THRESHOLD )); then
                log_alert "$name" "$delta"
                alerted=true

                # Forward to webhook if configured
                if [[ -n "$ALERT_URL" ]]; then
                    curl -sf -X POST "$ALERT_URL" \
                        -H 'Content-Type: application/json' \
                        -d "{\"app\":\"$name\",\"restarts_per_min\":$delta,\"threshold\":$THRESHOLD,\"time\":\"$(date -Iseconds)\"}" \
                        &>/dev/null || true
                fi
            fi
        fi

        # Update state
        new_state=$(echo "$new_state" | jq --arg name "$name" \
            --argjson count "$count" --argjson epoch "$now" \
            '.[$name] = {"last_count": $count, "last_check": $epoch}')
    done <<< "$pm2_data"

    save_state "$new_state"

    if $alerted; then
        exit 1  # Signal that an alert fired
    fi

    exit 0
}

main "$@"
