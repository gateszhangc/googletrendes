#!/usr/bin/env bash
set -euo pipefail

# One-shot Google Trends day import + production release.
#
# Usage:
#   scripts/deploy_trends.sh
#   scripts/deploy_trends.sh 2026-07-01
#   scripts/deploy_trends.sh --import-only
#   scripts/deploy_trends.sh --skip-test
#   scripts/deploy_trends.sh --force
#
# This project intentionally deploys directly to production through k8s/ArgoCD.
# Dokploy and staging are not used for googletrendes.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
K8S_FLEET_DIR="${K8S_FLEET_DIR:-$PROJECT_DIR/../k8s-fleet}"
DB_PATH="$PROJECT_DIR/data/google_trends.sqlite"
PROCESSOR="$HOME/.codex/skills/google-trends-folder-processor/scripts/process_google_trends_day.py"
SMOKE_PORT="${SMOKE_PORT:-9876}"
GHCR_REPO="ghcr.io/gateszhangc/googletrendes"
K8S_MANIFEST="tenants/googletrendes-production/20-deployment.yaml"
PROD_URL="https://googletrendes.codex55.lol"
ARGO_APP="googletrendes-production"

IMPORT_ONLY=false
SKIP_TEST=false
FORCE=false
DATE_ARG=""
SERVER_PID=""

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '[%s] ERROR: %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
One-shot Google Trends day import + production release.

Usage:
  scripts/deploy_trends.sh
  scripts/deploy_trends.sh 2026-07-01
  scripts/deploy_trends.sh --import-only
  scripts/deploy_trends.sh --skip-test
  scripts/deploy_trends.sh --force

This project deploys directly to production through k8s/ArgoCD.
Dokploy and staging are not used for googletrendes.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      usage
      exit 0
      ;;
    --import-only)
      IMPORT_ONLY=true
      ;;
    --skip-test)
      SKIP_TEST=true
      ;;
    --force)
      FORCE=true
      ;;
    -*)
      fail "Unknown argument: $arg"
      ;;
    *)
      DATE_ARG="$arg"
      ;;
  esac
done

if [[ -n "$DATE_ARG" ]]; then
  DATE="$DATE_ARG"
else
  DATE="$(date +%Y-%m-%d)"
fi
DATA_DIR="$PROJECT_DIR/$DATE"
EXPECTED_HEADER=$'geo\tcat\tdate\tquery\ttranslation\tchange'

require() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require git
require python3
require sqlite3
require npm
require docker
require kubectl
require curl
require shasum

[[ -f "$PROCESSOR" ]] || fail "Processor not found: $PROCESSOR"
[[ -d "$DATA_DIR" ]] || fail "Date directory not found: $DATA_DIR"

cd "$PROJECT_DIR"

APP_STATUS="$(git status --short)"
[[ -z "$APP_STATUS" ]] || fail "App repo has uncommitted changes before start:\n$APP_STATUS"

log "Date: $DATE"
log "Scanning official TSV files"
FILES=()
while IFS= read -r file; do
  FILES+=("$file")
done < <(find "$DATA_DIR" -maxdepth 1 -type f -name "google_trends_rising_${DATE}*.tsv" -print | sort)

[[ ${#FILES[@]} -gt 0 ]] || fail "No official TSV files found in $DATA_DIR"
for file in "${FILES[@]}"; do
  header="$(sed -n '1p' "$file")"
  [[ "$header" == "$EXPECTED_HEADER" ]] || fail "Bad TSV header in $file: $header"
done
log "TSV headers ok: ${#FILES[@]} file(s)"

if ! $FORCE; then
  NEEDS_PROCESS=false
  for file in "${FILES[@]}"; do
    rel="${file#$PROJECT_DIR/}"
    rel_sql="${rel//\'/\'\'}"
    actual_sha="$(shasum -a 256 "$file" | awk '{print $1}')"
    stored_sha="$(sqlite3 "$DB_PATH" "select coalesce((select sha256 from source_files where path='$rel_sql'), '');")"
    if [[ "$actual_sha" != "$stored_sha" ]]; then
      log "Changed or new TSV: $rel"
      NEEDS_PROCESS=true
    fi
  done
  EXISTING_MISSING="$(sqlite3 "$DB_PATH" "select count(*) from trend_queries tq join source_files sf on tq.source_file_id=sf.id where sf.path like '$DATE/%' and coalesce(tq.translation_ai,'')='';")"
  if [[ "$EXISTING_MISSING" != "0" ]]; then
    log "Existing missing translations for $DATE: $EXISTING_MISSING"
    NEEDS_PROCESS=true
  fi
  if ! $NEEDS_PROCESS; then
    log "No changed TSV files and no missing translations for $DATE; nothing to release"
    exit 0
  fi
fi

log "Importing and translating with folder processor"
python3 "$PROCESSOR" --project "$PROJECT_DIR" --date "$DATE" --db "$DB_PATH" --translate

log "Validating SQLite date batch"
DAY_SUMMARY="$(sqlite3 "$DB_PATH" "select count(*) || '|' || count(distinct query) || '|' || count(distinct geo) || '|' || count(distinct category) || '|' || coalesce(sum(change_is_breakout),0) || '|' || sum(case when coalesce(translation_ai,'')<>'' then 1 else 0 end) from trend_queries tq join source_files sf on tq.source_file_id=sf.id where sf.path like '$DATE/%';")"
IFS='|' read -r DAY_ROWS DAY_UNIQUE DAY_GEOS DAY_CATS DAY_BREAKOUTS DAY_TRANSLATED <<<"$DAY_SUMMARY"
MISSING_TRANSLATIONS="$(sqlite3 "$DB_PATH" "select count(*) from trend_queries tq join source_files sf on tq.source_file_id=sf.id where sf.path like '$DATE/%' and coalesce(tq.translation_ai,'')='';")"
if [[ "$MISSING_TRANSLATIONS" != "0" ]]; then
  sqlite3 -header -column "$DB_PATH" "select tq.geo, tq.category, quote(tq.query) query, quote(tq.translation_original) translation_original, sf.path from trend_queries tq join source_files sf on tq.source_file_id=sf.id where sf.path like '$DATE/%' and coalesce(tq.translation_ai,'')='' limit 20;"
  fail "Missing AI translations for $DATE: $MISSING_TRANSLATIONS"
fi
log "Date summary: rows=$DAY_ROWS unique=$DAY_UNIQUE geos=$DAY_GEOS categories=$DAY_CATS breakouts=$DAY_BREAKOUTS translated=$DAY_TRANSLATED"

log "Checkpointing SQLite WAL"
sqlite3 "$DB_PATH" "pragma wal_checkpoint(truncate);" >/dev/null

if git diff --quiet -- "$DB_PATH"; then
  log "No SQLite changes detected; nothing to release"
  exit 0
fi

if ! $SKIP_TEST; then
  log "Running local dashboard smoke test"
  PIDS="$(lsof -ti tcp:"$SMOKE_PORT" 2>/dev/null || true)"
  if [[ -n "$PIDS" ]]; then
    kill $PIDS >/dev/null 2>&1 || true
  fi
  python3 "$SCRIPT_DIR/serve_trends_dashboard.py" --web "$PROJECT_DIR/web" --host 127.0.0.1 --port "$SMOKE_PORT" &
  SERVER_PID="$!"
  sleep 2
  curl -fsS "http://127.0.0.1:$SMOKE_PORT/healthz" >/dev/null
  DASHBOARD_URL="http://127.0.0.1:$SMOKE_PORT" npm run test:dashboard
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  SERVER_PID=""
fi

if $IMPORT_ONLY; then
  log "Import-only mode complete; SQLite changes are left in the working tree"
  exit 0
fi

LATEST_TAG="$(git tag --list 'v[0-9]*' --sort=-v:refname | head -1)"
[[ -n "$LATEST_TAG" ]] || fail "No existing release tag found"
BASE="${LATEST_TAG#v}"
IFS='.' read -r MAJOR MINOR PATCH <<<"$BASE"
NEW_TAG="v${MAJOR}.${MINOR}.$((PATCH + 1))"
IMAGE="$GHCR_REPO:$NEW_TAG"
COMMIT_MSG="Import additional google trends $DATE data"

log "Committing app data as $NEW_TAG"
git add "$DB_PATH"
git commit -m "$COMMIT_MSG"
git tag "$NEW_TAG"
git push origin main
git push origin "$NEW_TAG"

log "Building SQLite-only image from $LATEST_TAG"
if ! printf '%s\n' "FROM $GHCR_REPO:$LATEST_TAG" "COPY data/google_trends.sqlite /app/data/google_trends.sqlite" |
  docker build -f - -t "$IMAGE" "$PROJECT_DIR"; then
  log "SQLite-only build failed; falling back to full Dockerfile build"
  docker build -t "$IMAGE" "$PROJECT_DIR"
fi

log "Pushing $IMAGE"
PUSH_OUTPUT="$(docker push "$IMAGE" 2>&1)"
printf '%s\n' "$PUSH_OUTPUT"
FULL_DIGEST="$(printf '%s\n' "$PUSH_OUTPUT" | awk '/digest: sha256/ {print $3; exit}')"
[[ "$FULL_DIGEST" == sha256:* ]] || fail "Failed to extract image digest"
IMAGE_WITH_DIGEST="$IMAGE@$FULL_DIGEST"
log "Image pushed: $IMAGE_WITH_DIGEST"

log "Updating GitOps production manifest"
cd "$K8S_FLEET_DIR"
K8S_STATUS="$(git status --short)"
[[ -z "$K8S_STATUS" ]] || fail "k8s-fleet has uncommitted changes before start:\n$K8S_STATUS"
git pull --ff-only

MANIFEST_PATH="$K8S_FLEET_DIR/$K8S_MANIFEST"
[[ -f "$MANIFEST_PATH" ]] || fail "Manifest not found: $MANIFEST_PATH"
PREV_IMAGE="$(grep 'image:' "$MANIFEST_PATH" | head -1 | awk '{print $2}')"
python3 - "$MANIFEST_PATH" "$IMAGE_WITH_DIGEST" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
image = sys.argv[2]
text = path.read_text()
new_text, count = re.subn(
    r"image: ghcr\.io/gateszhangc/googletrendes:v[0-9]+\.[0-9]+\.[0-9]+@sha256:[a-f0-9]+",
    f"image: {image}",
    text,
    count=1,
)
if count != 1:
    raise SystemExit("expected exactly one googletrendes image reference")
path.write_text(new_text)
PY

kubectl kustomize tenants/googletrendes-production >/tmp/googletrendes-production-render.yaml
kubectl apply --dry-run=client -f /tmp/googletrendes-production-render.yaml >/dev/null

git add "$K8S_MANIFEST"
git commit -m "Release googletrendes production $NEW_TAG"
git push origin main
TARGET_REV="$(git rev-parse HEAD)"

log "Refreshing ArgoCD $ARGO_APP"
kubectl --request-timeout=120s -n argocd annotate application "$ARGO_APP" argocd.argoproj.io/refresh=hard --overwrite >/dev/null
for attempt in $(seq 1 60); do
  REV="$(kubectl --request-timeout=120s -n argocd get application "$ARGO_APP" -o jsonpath='{.status.sync.revision}' 2>/dev/null || true)"
  SYNC="$(kubectl --request-timeout=120s -n argocd get application "$ARGO_APP" -o jsonpath='{.status.sync.status}' 2>/dev/null || true)"
  HEALTH="$(kubectl --request-timeout=120s -n argocd get application "$ARGO_APP" -o jsonpath='{.status.health.status}' 2>/dev/null || true)"
  log "ArgoCD attempt=$attempt rev=$REV sync=$SYNC health=$HEALTH"
  if [[ "$REV" == "$TARGET_REV" && "$SYNC" == "Synced" && "$HEALTH" == "Healthy" ]]; then
    break
  fi
  if [[ "$attempt" == "60" ]]; then
    fail "ArgoCD did not reach Synced/Healthy for $TARGET_REV"
  fi
  sleep 5
done

cd "$PROJECT_DIR"

log "Verifying production"
HEALTH_JSON="$(curl -fsS "$PROD_URL/healthz")"
SUMMARY_JSON="$(curl -fsS "$PROD_URL/api/summary?collected_date=$DATE")"
ONLINE_ROWS="$(printf '%s' "$HEALTH_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rows"])')"
ONLINE_DAY_ROWS="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rows"])')"
ONLINE_DAY_FILES="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["files"])')"
ONLINE_TRANSLATED_RATE="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["translated_rate"])')"
[[ "$ONLINE_DAY_ROWS" == "$DAY_ROWS" ]] || fail "Production day rows mismatch: local=$DAY_ROWS online=$ONLINE_DAY_ROWS"

kubectl --request-timeout=120s -n googletrendes-production get pods -o wide

if ! $SKIP_TEST; then
  DASHBOARD_URL="$PROD_URL" npm run test:dashboard
fi

FINAL_APP_STATUS="$(git status --short)"
[[ -z "$FINAL_APP_STATUS" ]] || fail "App repo not clean after release:\n$FINAL_APP_STATUS"
cd "$K8S_FLEET_DIR"
FINAL_K8S_STATUS="$(git status --short)"
[[ -z "$FINAL_K8S_STATUS" ]] || fail "k8s-fleet repo not clean after release:\n$FINAL_K8S_STATUS"

cat <<EOF

Release complete.
Date: $DATE
App tag: $NEW_TAG
App image: $IMAGE_WITH_DIGEST
Previous image: $PREV_IMAGE
GitOps revision: $TARGET_REV
Production rows: $ONLINE_ROWS
$DATE rows: $ONLINE_DAY_ROWS
$DATE files: $ONLINE_DAY_FILES
$DATE translated_rate: $ONLINE_TRANSLATED_RATE
EOF
