#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/a1-6/Desktop/code/googletrendes"
STATUS_FILE="$ROOT_DIR/google_trends_BR_rising_status.json"
CAPTURE_SCRIPT="$ROOT_DIR/scripts/capture_google_trends_br_rising.sh"
ANALYZE_SCRIPT="$ROOT_DIR/scripts/analyze_google_trends_br_results.sh"
LOCK_FILE="$ROOT_DIR/.google_trends_br_capture.lock"
WATCH_LOG="$ROOT_DIR/google_trends_BR_autowatch.log"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" >> "$WATCH_LOG"
}

notify() {
  local title="$1"
  local message="$2"
  osascript -e "display notification \"$message\" with title \"$title\"" >/dev/null 2>&1 || true
}

write_waiting_status() {
  local retry_epoch="$1"
  local retry_at="$2"
  local node ip
  node="$(curl -sS --max-time 3 http://127.0.0.1:9090/proxies/GLOBAL 2>/dev/null | jq -r '.now // "UNKNOWN"' 2>/dev/null || printf 'UNKNOWN')"
  ip="$(curl -sS --max-time 8 https://api.ipify.org 2>/dev/null || printf 'UNKNOWN')"
  jq -n \
    --arg status "waiting_cooldown" \
    --arg next_action "wait_and_retry" \
    --arg reason "Initialized by autowatch; waiting before next Google Trends Explore attempt" \
    --arg next_retry_at "$retry_at" \
    --arg next_retry_epoch "$retry_epoch" \
    --arg node "$node" \
    --arg ip "$ip" \
    '{
      status: $status,
      next_action: $next_action,
      reason: $reason,
      next_retry_at: $next_retry_at,
      next_retry_epoch: ($next_retry_epoch | tonumber),
      clash_node: $node,
      public_ip: $ip,
      rows: 0,
      output_file: "",
      log_file: ""
    }' > "$STATUS_FILE"
}

if [[ -f "$LOCK_FILE" ]]; then
  pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    log "Capture already running pid=$pid"
    exit 0
  fi
  log "Removing stale lock file"
  rm -f "$LOCK_FILE"
fi

if [[ ! -f "$STATUS_FILE" ]]; then
  retry_epoch="$(date -v+2H '+%s')"
  retry_at="$(date -v+2H '+%Y-%m-%d %H:%M:%S %Z')"
  write_waiting_status "$retry_epoch" "$retry_at"
  log "Created initial waiting status; next_retry_at=$retry_at"
  exit 0
fi

status="$(jq -r '.status // "unknown"' "$STATUS_FILE")"
next_action="$(jq -r '.next_action // ""' "$STATUS_FILE")"
next_retry_epoch="$(jq -r '.next_retry_epoch // 0' "$STATUS_FILE")"
now_epoch="$(date '+%s')"

case "$status" in
  complete)
    rows="$(jq -r '.rows // 0' "$STATUS_FILE")"
    output="$(jq -r '.output_file // ""' "$STATUS_FILE")"
    log "Capture complete rows=$rows output=$output"
    if [[ -x "$ANALYZE_SCRIPT" ]]; then
      log "Starting analysis for existing complete capture"
      "$ANALYZE_SCRIPT" >> "$WATCH_LOG" 2>&1 || log "Analysis script failed for existing complete capture"
    fi
    notify "Google Trends BR capture complete" "Rows: $rows"
    exit 0
    ;;
  running)
    log "Status says running; skipping"
    exit 0
    ;;
esac

if [[ "$next_action" != "wait_and_retry" ]]; then
  log "No automatic action for status=$status next_action=$next_action"
  exit 0
fi

if [[ "$next_retry_epoch" =~ ^[0-9]+$ ]] && (( now_epoch < next_retry_epoch )); then
  log "Cooldown not reached status=$status next_retry_epoch=$next_retry_epoch now=$now_epoch"
  exit 0
fi

log "Cooldown reached; starting capture"
notify "Google Trends BR capture" "Cooldown reached; starting capture"

set +e
GOOGLE_TRENDS_CATEGORY_SLEEP_SECONDS="${GOOGLE_TRENDS_CATEGORY_SLEEP_SECONDS:-180}" "$CAPTURE_SCRIPT"
exit_code=$?
set -e

new_status="$(jq -r '.status // "unknown"' "$STATUS_FILE" 2>/dev/null || printf 'unknown')"
rows="$(jq -r '.rows // 0' "$STATUS_FILE" 2>/dev/null || printf '0')"
log "Capture exited code=$exit_code status=$new_status rows=$rows"

if [[ "$new_status" == "complete" ]]; then
  if [[ -x "$ANALYZE_SCRIPT" ]]; then
    log "Starting analysis after complete capture"
    "$ANALYZE_SCRIPT" >> "$WATCH_LOG" 2>&1 || log "Analysis script failed after complete capture"
  fi
  notify "Google Trends BR capture complete" "Rows: $rows"
else
  reason="$(jq -r '.reason // ""' "$STATUS_FILE" 2>/dev/null || true)"
  notify "Google Trends BR capture paused" "$new_status: ${reason:0:80}"
fi

exit 0
