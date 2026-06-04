#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/a1-6/Desktop/code/googletrendes"
RUN_ID="$(date +%Y%m%d_%H%M%S)"
OUT_TSV="$ROOT_DIR/google_trends_BR_rising_by_category_$RUN_ID.tsv"
LOG_FILE="$ROOT_DIR/google_trends_BR_rising_by_category_$RUN_ID.log"
STATUS_FILE="$ROOT_DIR/google_trends_BR_rising_status.json"
LOCK_FILE="$ROOT_DIR/.google_trends_br_capture.lock"
LABEL="com.a16.googletrends.br.cooldown"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LAUNCHD_MODE=0
STARTED_AT="$(date '+%Y-%m-%d %H:%M:%S %Z')"

if [[ "${1:-}" == "--launchd" ]]; then
  LAUNCHD_MODE=1
fi

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" | tee -a "$LOG_FILE"
}

rows_count() {
  if [[ -f "$OUT_TSV" ]]; then
    awk 'END{print NR > 0 ? NR - 1 : 0}' "$OUT_TSV"
  else
    printf '0'
  fi
}

write_status() {
  local status="$1"
  local next_action="$2"
  local reason="${3:-}"
  local next_retry_at="${4:-}"
  local next_retry_epoch="${5:-0}"
  local finished_at=""
  if [[ "$status" != "running" ]]; then
    finished_at="$(date '+%Y-%m-%d %H:%M:%S %Z')"
  fi

  jq -n \
    --arg status "$status" \
    --arg next_action "$next_action" \
    --arg reason "$reason" \
    --arg run_id "$RUN_ID" \
    --arg started_at "$STARTED_AT" \
    --arg finished_at "$finished_at" \
    --arg next_retry_at "$next_retry_at" \
    --arg next_retry_epoch "$next_retry_epoch" \
    --arg node "${CURRENT_NODE:-UNKNOWN}" \
    --arg ip "${CURRENT_IP:-UNKNOWN}" \
    --arg output_file "$OUT_TSV" \
    --arg log_file "$LOG_FILE" \
    --arg rows "$(rows_count)" \
    '{
      status: $status,
      next_action: $next_action,
      reason: $reason,
      run_id: $run_id,
      started_at: $started_at,
      finished_at: $finished_at,
      next_retry_at: $next_retry_at,
      next_retry_epoch: ($next_retry_epoch | tonumber),
      clash_node: $node,
      public_ip: $ip,
      rows: ($rows | tonumber),
      output_file: $output_file,
      log_file: $log_file
    }' > "$STATUS_FILE"
}

cleanup() {
  rm -f "$LOCK_FILE"
  if [[ "$LAUNCHD_MODE" == "1" ]]; then
    launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
  fi
}
trap cleanup EXIT

if ! ( set -o noclobber; printf '%s\n' "$$" > "$LOCK_FILE" ) 2>/dev/null; then
  log "Another capture appears to be running; lock file exists: $LOCK_FILE"
  exit 2
fi

mkdir -p "$ROOT_DIR"
printf 'category_id\tcategory\tpage\trank\tquery\tchange\n' > "$OUT_TSV"

log "Starting Brazil Google Trends Explore capture"
log "Target: geo=BR date=now 7-d gprop=default module=Consultas de pesquisa / Em ascensão"
log "Output: $OUT_TSV"

CURRENT_NODE="$(curl -sS --max-time 3 http://127.0.0.1:9090/proxies/GLOBAL 2>/dev/null | jq -r '.now // "UNKNOWN"' 2>/dev/null || printf 'UNKNOWN')"
CURRENT_IP="$(curl -sS --max-time 8 https://api.ipify.org 2>/dev/null || printf 'UNKNOWN')"
write_status "running" "capture_in_progress" ""
log "Clash GLOBAL node: $CURRENT_NODE"
log "Public IP: $CURRENT_IP"

osascript >/dev/null <<'APPLESCRIPT'
tell application "Google Chrome"
  make new window
end tell
APPLESCRIPT

close_chrome_window() {
  osascript >/dev/null 2>&1 <<'APPLESCRIPT' || true
tell application "Google Chrome"
  if (count of windows) > 0 then close front window
end tell
APPLESCRIPT
}
trap 'close_chrome_window; cleanup' EXIT

extract_category() {
  local cat_id="$1"
  osascript <<APPLESCRIPT
with timeout of 220 seconds
  tell application "Google Chrome"
    set w to front window
    set t to active tab of w
    set URL of t to "https://trends.google.com/trends/explore?cat=$cat_id&date=now%207-d&geo=BR&hl=pt-BR"
    delay 35

    set outData to ""

    repeat with p from 1 to 10
      set jsRead to "(function(){function txt(e){return e?(e.innerText||e.textContent||'').trim():'';} function clean(s){return String(s||'').replace(/[\\t\\r\\n]+/g,' ').trim();} var body=txt(document.body); if(/429|Too Many Requests|unusual traffic/i.test(body)) return '__RATE_LIMIT__\\t' + clean(body).slice(0,220); if(/Ops\\. Ocorreu|Tente novamente|出了点问题|稍后重试/i.test(body)) return '__PAGE_ERROR__\\t' + clean(body).slice(0,260); var cs=Array.from(document.querySelectorAll('.fe-related-queries')); var c=cs.find(function(x){var s=txt(x); return /Consultas de pesquisa|Related queries|相关查询/i.test(s) && /Em ascensão|Rising|上升/i.test(s);}) || cs.find(function(x){return /Consultas de pesquisa|Related queries|相关查询/i.test(txt(x));}) || cs[1] || cs[0]; if(!c) return '__NO_WIDGET__\\t' + clean(body).slice(0,260); var lines=txt(c).split('\\n').map(function(s){return s.trim();}).filter(Boolean); var rows=[]; var skip=/help_outline|file_download|code|share|more_vert|Consultas de pesquisa|Related queries|相关查询|Em ascensão|Rising|Principais|Top|Mostrando|Showing|分析|warning|Aviso/i; for(var i=0;i<lines.length;i++){ if(/^\\d+$/.test(lines[i])){ var rank=lines[i], query='', change=''; for(var j=i+1;j<Math.min(i+8,lines.length);j++){ var l=lines[j]; if(!query && !skip.test(l) && !/^\\.\\.\\.$/.test(l) && !/^Mais\\s+/i.test(l) && !/^\\+/.test(l)){ query=l; continue; } if(query && (/^Mais\\s+/i.test(l)||/^\\+/.test(l)||/^Aumento repentino$/i.test(l)||/^Breakout$/i.test(l))){ change=l.replace(/^Mais\\s+/i,'+'); break; } } if(query){ rows.push(rank+'\\t'+clean(query)+'\\t'+clean(change||'BREAKOUT')); } } } return rows.length ? '__OK__\\n' + rows.join('\\n') : '__NO_ROWS__\\t' + clean(txt(c)).slice(0,260);})();"
      set pageRows to execute t javascript jsRead

      if pageRows starts with "__RATE_LIMIT__" then
        return pageRows
      end if
      if pageRows starts with "__PAGE_ERROR__" then
        return pageRows
      end if
      if pageRows starts with "__NO_WIDGET__" then
        return pageRows
      end if
      if pageRows starts with "__NO_ROWS__" then
        set outData to outData & "NO_ROWS" & tab & p & tab & pageRows & return
        exit repeat
      end if

      set oldDelims to AppleScript's text item delimiters
      set AppleScript's text item delimiters to linefeed
      set rowItems to text items of pageRows
      set AppleScript's text item delimiters to oldDelims

      repeat with rowIndex from 2 to count of rowItems
        set rowItem to item rowIndex of rowItems
        if (rowItem as text) is not "" then
          set outData to outData & "OK" & tab & p & tab & (rowItem as text) & return
        end if
      end repeat

      set jsNext to "(function(){function txt(e){return e?(e.innerText||e.textContent||'').trim():'';} var cs=Array.from(document.querySelectorAll('.fe-related-queries')); var c=cs.find(function(x){var s=txt(x); return /Consultas de pesquisa|Related queries|相关查询/i.test(s) && /Em ascensão|Rising|上升/i.test(s);}) || cs.find(function(x){return /Consultas de pesquisa|Related queries|相关查询/i.test(txt(x));}) || cs[1] || cs[0]; if(!c) return 'NO_CONTAINER'; var scopes=[]; var n=c; for(var i=0;i<8 && n;i++,n=n.parentElement){scopes.push(n);} scopes.push(document); for(var si=0;si<scopes.length;si++){var btns=Array.from(scopes[si].querySelectorAll('button[aria-label=\"Next\"],button[aria-label=\"Próxima\"],button[aria-label=\"下一页\"]')); for(var bi=0;bi<btns.length;bi++){var b=btns[bi]; if(!b.disabled && b.getAttribute('aria-disabled') !== 'true'){b.click(); return 'CLICKED';}}} return 'NO_NEXT';})();"
      set nextStatus to execute t javascript jsNext
      if nextStatus is not "CLICKED" then exit repeat
      delay 3
    end repeat

    return outData
  end tell
end timeout
APPLESCRIPT
}

categories=(
  "0|所有类别"
  "3|艺术与娱乐"
  "184|汽车"
  "44|美容与健身"
  "22|书籍与文学"
  "12|商业与工业"
  "5|计算机与电子"
  "7|金融"
  "71|饮食"
  "8|游戏"
  "45|健康"
  "65|爱好与休闲"
  "11|家居与园艺"
  "13|互联网与电信"
  "958|求职与教育"
  "19|法律与政府"
  "16|新闻"
  "299|在线社区"
  "14|人物与社会"
  "66|宠物与动物"
  "29|房地产"
  "533|体育"
  "174|科学"
  "18|购物"
  "67|旅游与交通"
)

sleep_between_categories="${GOOGLE_TRENDS_CATEGORY_SLEEP_SECONDS:-180}"

for cat in "${categories[@]}"; do
  cat_id="${cat%%|*}"
  cat_name="${cat#*|}"
  log "Category start: $cat_name cat=$cat_id"

  raw="$(extract_category "$cat_id" || true)"

  if [[ "$raw" == __RATE_LIMIT__* ]]; then
    reason="RATE_LIMIT at category $cat_name cat=$cat_id: ${raw#__RATE_LIMIT__	}"
    log "$reason"
    write_status "blocked_rate_limit" "wait_and_retry" "$reason" "$(date -v+2H '+%Y-%m-%d %H:%M:%S %Z')" "$(date -v+2H '+%s')"
    exit 42
  fi
  if [[ "$raw" == __PAGE_ERROR__* ]]; then
    reason="PAGE_ERROR at category $cat_name cat=$cat_id: ${raw#__PAGE_ERROR__	}"
    log "$reason"
    write_status "blocked_page_error" "wait_and_retry" "$reason" "$(date -v+2H '+%Y-%m-%d %H:%M:%S %Z')" "$(date -v+2H '+%s')"
    exit 43
  fi
  if [[ "$raw" == __NO_WIDGET__* ]]; then
    reason="NO_WIDGET at category $cat_name cat=$cat_id: ${raw#__NO_WIDGET__	}"
    log "$reason"
    write_status "blocked_no_widget" "wait_and_retry" "$reason" "$(date -v+2H '+%Y-%m-%d %H:%M:%S %Z')" "$(date -v+2H '+%s')"
    exit 44
  fi

  rows_added=0
  while IFS=$'\t' read -r status page rank query change extra; do
    [[ -z "${status:-}" ]] && continue
    if [[ "$status" == "OK" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cat_id" "$cat_name" "$page" "$rank" "$query" "$change" >> "$OUT_TSV"
      rows_added=$((rows_added + 1))
    else
      log "$status at category $cat_name cat=$cat_id page=$page $rank $query $change $extra"
    fi
  done <<< "$raw"

  log "Category done: $cat_name cat=$cat_id rows=$rows_added"
  log "Sleeping ${sleep_between_categories}s before next category"
  sleep "$sleep_between_categories"
done

total_rows="$(($(wc -l < "$OUT_TSV") - 1))"
log "Capture complete rows=$total_rows output=$OUT_TSV"
write_status "complete" "summarize_results" "Capture complete"
