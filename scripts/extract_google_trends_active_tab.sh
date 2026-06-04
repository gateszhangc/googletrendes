#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXTRACTOR_JS="$ROOT_DIR/scripts/google_trends_rising_tab_extractor.js"
URL="${1:-}"
RUN_ID="$(date +%Y%m%d_%H%M%S)"
TMP_JSON="$(mktemp "${TMPDIR:-/tmp}/google_trends_tab_extract.XXXXXX.json")"

cleanup() {
  rm -f "$TMP_JSON"
}
trap cleanup EXIT

osascript >/tmp/google_trends_tab_open.out <<APPLESCRIPT
set targetUrl to "$URL"
with timeout of 180 seconds
  tell application "Google Chrome"
    activate
    if (count of windows) = 0 then make new window
    if targetUrl is not "" then
      tell front window
        set t to make new tab with properties {URL:targetUrl}
        set active tab index to (count of tabs)
      end tell
    end if
    repeat with i from 1 to 120
      tell active tab of front window
        set bodyText to execute javascript "(document.body && (document.body.innerText || document.body.textContent) || '')"
      end tell
      if bodyText contains "429" then return "RATE_LIMIT"
      if bodyText contains "搜索查询" and bodyText contains "搜索量上升" then exit repeat
      if i > 4 then
        tell active tab of front window
          execute javascript "window.scrollTo({top: document.body.scrollHeight, behavior: 'instant'}); 'SCROLLED'"
        end tell
      end if
      delay 1
    end repeat
    return "READY"
  end tell
end timeout
APPLESCRIPT

osascript >/tmp/google_trends_tab_start.out <<APPLESCRIPT
set jsCode to read POSIX file "$EXTRACTOR_JS"
with timeout of 60 seconds
  tell application "Google Chrome"
    tell active tab of front window
      return execute javascript jsCode
    end tell
  end tell
end timeout
APPLESCRIPT

for _ in $(seq 1 180); do
  status_json="$(osascript <<'APPLESCRIPT'
with timeout of 30 seconds
  tell application "Google Chrome"
    tell active tab of front window
      return execute javascript "JSON.stringify({status:(window.__GT_RISING_EXTRACTOR_STATE&&window.__GT_RISING_EXTRACTOR_STATE.status)||'missing',progress:(window.__GT_RISING_EXTRACTOR_STATE&&window.__GT_RISING_EXTRACTOR_STATE.progress)||null,error:(window.__GT_RISING_EXTRACTOR_STATE&&window.__GT_RISING_EXTRACTOR_STATE.error)||null})"
    end tell
  end tell
end timeout
APPLESCRIPT
)"
  status="$(printf '%s' "$status_json" | jq -r '.status // "missing"')"
  if [[ "$status" == "done" ]]; then
    osascript <<'APPLESCRIPT' > "$TMP_JSON"
with timeout of 60 seconds
  tell application "Google Chrome"
    tell active tab of front window
      return execute javascript "JSON.stringify(window.__GT_RISING_EXTRACTOR_STATE.result)"
    end tell
  end tell
end timeout
APPLESCRIPT
    break
  fi
  if [[ "$status" == "error" ]]; then
    printf 'Extractor failed: %s\n' "$status_json" >&2
    exit 1
  fi
  sleep 1
done

if [[ ! -s "$TMP_JSON" ]]; then
  printf 'Extractor timed out waiting for completion.\n' >&2
  exit 2
fi

geo="$(jq -r '.geo // "UNKNOWN"' "$TMP_JSON")"
cat_id="$(jq -r '.categoryId // "0"' "$TMP_JSON")"
out_json="$ROOT_DIR/google_trends_${geo}_cat${cat_id}_rising_pages_${RUN_ID}.json"
out_tsv="$ROOT_DIR/google_trends_${geo}_cat${cat_id}_rising_pages_${RUN_ID}.tsv"

jq . "$TMP_JSON" > "$out_json"
jq -r '
  . as $root |
  (["geo","category_id","date","hl","page","rank","query","translation","change"] | @tsv),
  (.rows[] | [$root.geo, $root.categoryId, $root.date, $root.hl, .page, .rank, .query, .translation, .change] | @tsv)
' "$out_json" > "$out_tsv"

printf '%s\n%s\n' "$out_json" "$out_tsv"
jq '{status, ok, pageUrl, geo, categoryId, date, hl, total, pageCount, rowCount:(.rows|length), first5:.rows[0:5], last5:.rows[-5:]}' "$out_json"
