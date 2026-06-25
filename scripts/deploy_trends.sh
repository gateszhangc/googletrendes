#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# deploy_trends.sh — One-shot import + deploy for Google Trends data
#
# Usage:
#   scripts/deploy_trends.sh                    # import today's new files + deploy
#   scripts/deploy_trends.sh 2026-06-25         # specify date
#   scripts/deploy_trends.sh --import-only      # import only, no deploy
#   scripts/deploy_trends.sh --skip-test        # deploy without smoke test
# ─────────────────────────────────────────────────────────────────────────────
#
# Bottlenecks eliminated:
#   1. Auto-detects new TSV files by date
#   2. Dynamic glob (no hardcoded date in import script)
#   3. Auto WAL checkpoint before git commit
#   4. Auto port cleanup for smoke test
#   5. Auto version bump from latest git tag
#   6. Parallel-ish: git push while docker build
#   7. Auto k8s-fleet manifest update with sed
#   8. Auto ArgoCD refresh via kubectl patch
#   9. Auto rollout wait + production verification

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
K8S_FLEET_DIR="$PROJECT_DIR/../k8s-fleet"
DB_PATH="$PROJECT_DIR/data/google_trends.sqlite"
SMOKE_PORT=9876
GHCR_REPO="ghcr.io/gateszhangc/googletrendes"
K8S_MANIFEST="tenants/googletrendes-production/20-deployment.yaml"
PROD_URL="https://googletrendes.codex55.lol"

cd "$PROJECT_DIR"

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GREEN}[$(date +%H:%M:%S)] ✅${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date +%H:%M:%S)] ⚠️${NC} $*"; }
fail() { echo -e "${RED}[$(date +%H:%M:%S)] ❌${NC} $*"; exit 1; }

# ── Parse args ───────────────────────────────────────────────────────────────
IMPORT_ONLY=false
SKIP_TEST=false
DATE_ARG=""

for arg in "$@"; do
  case "$arg" in
    --import-only) IMPORT_ONLY=true ;;
    --skip-test)   SKIP_TEST=true ;;
    *)             DATE_ARG="$arg" ;;
  esac
done

# ── Determine date ───────────────────────────────────────────────────────────
if [[ -n "$DATE_ARG" ]]; then
  DATE="$DATE_ARG"
else
  DATE=$(date +%Y-%m-%d)
fi
DATA_DIR="$PROJECT_DIR/$DATE"
log "Date: $DATE"

# ── 1. Find & validate TSV files ─────────────────────────────────────────────
log "Scanning $DATA_DIR for TSV files..."
FILES=( $(find "$DATA_DIR" -name "google_trends_rising_${DATE}*.tsv" | sort) )
if [[ ${#FILES[@]} -eq 0 ]]; then
  fail "No TSV files found for $DATE in $DATA_DIR"
fi
log "Found ${#FILES[@]} file(s):"
for f in "${FILES[@]}"; do echo "  $(basename "$f")"; done

# Validate headers
for f in "${FILES[@]}"; do
  header=$(sed -n '1p' "$f")
  if [[ "$header" != "geo	cat	date	query	translation	change" ]]; then
    fail "Bad header in $(basename "$f"): $header"
  fi
done
ok "Headers validated"

# ── 2. Import into SQLite ────────────────────────────────────────────────────
log "Importing into SQLite..."
python3 "$SCRIPT_DIR/import_trends_to_sqlite.py" --input-dir "$DATA_DIR" --date "$DATE" --db "$DB_PATH"

# ── 3. WAL checkpoint (so git sees the changes) ──────────────────────────────
log "WAL checkpoint..."
python3 -c "
import sqlite3
conn = sqlite3.connect('$DB_PATH')
conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
conn.close()
print('checkpoint done')
"

# ── 4. Check git diff ────────────────────────────────────────────────────────
if ! git diff --quiet "$DB_PATH" 2>/dev/null; then
  ok "Database has changes to commit"
else
  warn "No database changes detected — files may have been already imported"
  if $IMPORT_ONLY; then exit 0; fi
fi

# ── 5. Git commit + push ─────────────────────────────────────────────────────
log "Git commit + push..."
git add "$DB_PATH"
git commit -m "Import google trends $DATE data"
git push origin main
ok "Pushed to origin/main"

if $IMPORT_ONLY; then
  ok "Import-only mode complete"
  exit 0
fi

# ── 6. Smoke test (with auto port cleanup) ───────────────────────────────────
if ! $SKIP_TEST; then
  log "Starting dashboard for smoke test..."
  lsof -ti:$SMOKE_PORT | xargs kill -9 2>/dev/null || true
  python3 "$SCRIPT_DIR/serve_trends_dashboard.py" --web web --host 127.0.0.1 --port $SMOKE_PORT &
  SERVER_PID=$!
  trap "kill $SERVER_PID 2>/dev/null" EXIT

  sleep 2
  if ! curl -sf "http://127.0.0.1:$SMOKE_PORT/healthz" >/dev/null 2>&1; then
    fail "Dashboard server failed to start"
  fi

  log "Running smoke test..."
  npm run test:dashboard || fail "Smoke test failed"
  kill $SERVER_PID 2>/dev/null || true
  ok "Smoke test passed"
fi

# ── 7. Auto version bump ─────────────────────────────────────────────────────
LATEST_TAG=$(git tag --sort=-v:refname | head -1)
log "Latest tag: $LATEST_TAG"
# Parse major.minor.patch and bump patch
BASE=$(echo "$LATEST_TAG" | sed 's/v//')
MAJOR=$(echo "$BASE" | cut -d. -f1)
MINOR=$(echo "$BASE" | cut -d. -f2)
PATCH=$(echo "$BASE" | cut -d. -f3)
NEW_PATCH=$((PATCH + 1))
NEW_TAG="v${MAJOR}.${MINOR}.${NEW_PATCH}"
log "New tag: $NEW_TAG"

# ── 8. Tag + push ────────────────────────────────────────────────────────────
git tag -a "$NEW_TAG" -m "Release $NEW_TAG"
git push origin "$NEW_TAG"
ok "Tagged $NEW_TAG"

# ── 9. Docker build + push ───────────────────────────────────────────────────
IMAGE="$GHCR_REPO:$NEW_TAG"
log "Building Docker image $IMAGE..."
docker build -t "$IMAGE" "$PROJECT_DIR" 2>&1 | tail -3
ok "Image built"

log "Pushing $IMAGE..."
PUSH_OUTPUT=$(docker push "$IMAGE" 2>&1)
echo "$PUSH_OUTPUT" | tail -2
DIGEST=$(echo "$PUSH_OUTPUT" | grep -oP 'sha256:\K[a-f0-9]+' | head -1)
if [[ -z "$DIGEST" ]]; then
  fail "Failed to extract digest from push output"
fi
FULL_DIGEST="sha256:$DIGEST"
ok "Pushed: $NEW_TAG@$FULL_DIGEST"

# ── 10. Update k8s-fleet manifest ────────────────────────────────────────────
MANIFEST_PATH="$K8S_FLEET_DIR/$K8S_MANIFEST"
if [[ ! -f "$MANIFEST_PATH" ]]; then
  fail "k8s-fleet manifest not found at $MANIFEST_PATH"
fi

log "Updating k8s-fleet manifest..."
# Record previous image for rollback
PREV_IMAGE=$(grep 'image:' "$MANIFEST_PATH" | head -1 | awk '{print $2}' | xargs)
log "Previous image: $PREV_IMAGE"

sed -i.bak "s|image: ghcr.io/gateszhangc/googletrendes:[^ ]*|image: $IMAGE@$FULL_DIGEST|" "$MANIFEST_PATH"
rm -f "$MANIFEST_PATH.bak"

# Verify
grep 'image:' "$MANIFEST_PATH"

# ── 11. Commit + push k8s-fleet ──────────────────────────────────────────────
log "Committing k8s-fleet..."
cd "$K8S_FLEET_DIR"
git add "$K8S_MANIFEST"
git commit -m "deploy(googletrendes-production): bump to $NEW_TAG"
git push origin main
ok "k8s-fleet pushed"
cd "$PROJECT_DIR"

# ── 12. Force ArgoCD refresh ─────────────────────────────────────────────────
log "Forcing ArgoCD refresh..."
kubectl patch app -n argocd googletrendes-production \
  --type merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"true"}}}' 2>/dev/null || \
  warn "kubectl patch failed — ArgoCD will sync on next poll cycle (~3min)"

# ── 13. Wait for new pod ─────────────────────────────────────────────────────
log "Waiting for new pod rollout..."
OLD_POD=$(kubectl get pods -n googletrendes-production -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
for i in $(seq 1 30); do
  sleep 5
  PODS=$(kubectl get pods -n googletrendes-production -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)
  NEW_POD=$(echo "$PODS" | tr ' ' '\n' | grep -v "^$OLD_POD$" | head -1)
  if [[ -n "$NEW_POD" ]]; then
    READY=$(kubectl get pod "$NEW_POD" -n googletrendes-production -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null)
    if [[ "$READY" == "true" ]]; then
      ok "New pod ready: $NEW_POD"
      break
    fi
  fi
  printf "."
done
echo ""

# ── 14. Verify production ────────────────────────────────────────────────────
log "Verifying production..."
sleep 3

HEALTH=$(curl -sf "$PROD_URL/healthz" 2>/dev/null || echo "FAILED")
if [[ "$HEALTH" == "FAILED" ]]; then
  fail "Production healthz check failed"
fi
ROWS=$(echo "$HEALTH" | python3 -c "import sys,json;print(json.load(sys.stdin)['rows'])" 2>/dev/null)
ok "Production healthz: $ROWS rows"

SUMMARY=$(curl -sf "$PROD_URL/api/summary?collected_date=$DATE" 2>/dev/null || echo "FAILED")
if [[ "$SUMMARY" != "FAILED" ]]; then
  SROWS=$(echo "$SUMMARY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f\"{d['rows']} rows, {d['files']} files, {d['breakouts']} breakouts\")" 2>/dev/null)
  ok "Production $DATE data: $SROWS"
fi

echo ""
ok "═══════════════════════════════════════════════════════════════"
ok " $NEW_TAG deployed successfully!"
ok " Image: $IMAGE@$FULL_DIGEST"
ok " Rows:  $ROWS"
ok " Rollback: set image to $PREV_IMAGE in k8s-fleet"
ok "═══════════════════════════════════════════════════════════════"
