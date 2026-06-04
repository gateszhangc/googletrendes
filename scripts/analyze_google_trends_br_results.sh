#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/a1-6/Desktop/code/googletrendes"
STATUS_FILE="$ROOT_DIR/google_trends_BR_rising_status.json"
CONTEXT_FILE="$ROOT_DIR/google_trends_BR_context.md"
ANALYSIS_LOG="$ROOT_DIR/google_trends_BR_analysis.log"
CODEX_BIN="/usr/local/bin/codex"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" >> "$ANALYSIS_LOG"
}

if [[ ! -x "$CODEX_BIN" ]]; then
  log "Codex CLI not found or not executable: $CODEX_BIN"
  exit 10
fi

if [[ ! -f "$STATUS_FILE" ]]; then
  log "Status file missing: $STATUS_FILE"
  exit 11
fi

status="$(jq -r '.status // "unknown"' "$STATUS_FILE")"
if [[ "$status" != "complete" ]]; then
  log "Skip analysis because status=$status"
  exit 0
fi

output_file="$(jq -r '.output_file // ""' "$STATUS_FILE")"
log_file="$(jq -r '.log_file // ""' "$STATUS_FILE")"
rows="$(jq -r '.rows // 0' "$STATUS_FILE")"
existing_report="$(jq -r '.analysis_file // ""' "$STATUS_FILE")"

if [[ -n "$existing_report" && -f "$existing_report" ]]; then
  log "Analysis already exists: $existing_report"
  exit 0
fi

if [[ -z "$output_file" || ! -f "$output_file" ]]; then
  log "Output TSV missing: $output_file"
  exit 12
fi

if [[ "$rows" == "0" ]]; then
  log "Skip analysis because rows=0"
  exit 0
fi

base_name="$(basename "$output_file" .tsv)"
report_file="$ROOT_DIR/${base_name}_analysis.md"
prompt_file="$ROOT_DIR/${base_name}_analysis_prompt.md"

cat > "$prompt_file" <<PROMPT
请分析这个 Google Trends Brazil Explore 抓取结果。

下面是本次任务必须继承的上下文，请严格遵守：

$(cat "$CONTEXT_FILE")

数据文件：
$output_file

日志文件：
$log_file

状态文件：
$STATUS_FILE

要求：
- 只基于本地 TSV、日志、状态文件和上下文文件分析，不要联网搜索。
- 数据口径：Google Trends Explore，geo=BR，date=now 7-d，默认 Google 网页搜索，只抓取 Consultas de pesquisa / Em ascensão。
- 输出中文 Markdown。
- 给出：总览、分类覆盖情况、最强增长关键词、重复/跨分类关键词、体育/新闻/购物等值得关注的类别摘要、数据质量问题、后续采集建议。
- 如果 TSV 字段有异常，明确指出。
- 不要修改任何文件；只把分析内容输出到 stdout。
PROMPT

log "Starting Codex analysis rows=$rows output=$output_file report=$report_file"

set +e
"$CODEX_BIN" exec \
  -C "$ROOT_DIR" \
  -a never \
  -s read-only \
  "$(cat "$prompt_file")" > "$report_file" 2>> "$ANALYSIS_LOG"
exit_code=$?
set -e

if [[ "$exit_code" -ne 0 ]]; then
  log "Codex analysis failed exit_code=$exit_code"
  rm -f "$report_file"
  exit "$exit_code"
fi

tmp_status="$(mktemp)"
jq \
  --arg analysis_file "$report_file" \
  --arg analyzed_at "$(date '+%Y-%m-%d %H:%M:%S %Z')" \
  '. + {
    analysis_status: "complete",
    analysis_file: $analysis_file,
    analyzed_at: $analyzed_at,
    next_action: "review_analysis"
  }' "$STATUS_FILE" > "$tmp_status"
mv "$tmp_status" "$STATUS_FILE"

log "Codex analysis complete report=$report_file"
