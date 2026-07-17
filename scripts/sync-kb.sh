#!/usr/bin/env bash
set -euo pipefail

# sync-kb.sh — populate the Bedrock Knowledge Base with content, end to end:
#   1. Resolve the KB bucket, knowledge-base ID, and data-source ID from the
#      rendered project's cdk-outputs.json (Wisdom stack outputs).
#   2. Upload the content path (file or directory) to the KB S3 bucket.
#   3. Start a Bedrock ingestion job and poll until it completes.
#
# Requires knowledgeBaseEnabled=true in the deployment (the Wisdom stack must
# have created the Bedrock KB). Idempotent: re-running re-syncs the content and
# starts a fresh ingestion job; unchanged documents are re-indexed harmlessly.
#
# Usage:
#   sync-kb.sh <project-dir> [content-path] [region]
#
# Args:
#   project-dir    rendered project directory (contains cdk-outputs.json)
#   content-path   local file or directory to upload (optional; defaults to the
#                  skill's sample-data/ folder, which ships a demo return policy)
#   region         deploy region (optional). Precedence: this arg, then the
#                  `region` key in .connect-skill-values.json, then us-east-1.

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
info() { echo "→ $1"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}" >&2; exit 1; }

PROJECT_DIR="${1:?usage: sync-kb.sh <project-dir> [content-path] [region]}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTENT_PATH="${2:-$REPO_ROOT/sample-data}"
REGION_ARG="${3:-}"

# Resolve region: explicit arg wins, else the values file, else us-east-1
# (same precedence as setup-widget.sh).
VALUES_FILE="$REPO_ROOT/.connect-skill-values.json"
if [[ -n "$REGION_ARG" ]]; then
  REGION="$REGION_ARG"
elif [[ -f "$VALUES_FILE" ]]; then
  REGION="$(jq -r '.region // "us-east-1"' "$VALUES_FILE")"
else
  REGION="us-east-1"
fi

OUTPUTS="$PROJECT_DIR/cdk-outputs.json"
[[ -f "$OUTPUTS" ]]      || fail "cdk-outputs.json not found at $OUTPUTS (deploy the project first)"
[[ -e "$CONTENT_PATH" ]] || fail "content path not found: $CONTENT_PATH"

# --- 1. Resolve KB resources from the Wisdom stack outputs ------------------
wisdom_output() {
  jq -r --arg k "$1" 'to_entries[] | select(.key | endswith("-Wisdom")) | .value[$k] // empty' "$OUTPUTS" | head -n1
}
KB_BUCKET="$(wisdom_output KnowledgeBaseBucketName)"
KB_ID="$(wisdom_output BedrockKnowledgeBaseId)"
DS_ID="$(wisdom_output BedrockDataSourceId)"
[[ -n "$KB_BUCKET" && -n "$KB_ID" && -n "$DS_ID" ]] || fail \
  "knowledge-base outputs missing from $OUTPUTS — was the project deployed with knowledgeBaseEnabled=true?"
info "Knowledge base: $KB_ID (data source: $DS_ID, bucket: $KB_BUCKET)"

# --- 2. Upload content -------------------------------------------------------
if [[ -d "$CONTENT_PATH" ]]; then
  info "Syncing directory $CONTENT_PATH to s3://$KB_BUCKET/ ..."
  aws s3 sync "$CONTENT_PATH" "s3://$KB_BUCKET/" --region "$REGION" \
    --exclude ".*" --exclude "*/.*" \
    || fail "s3 sync failed"
else
  info "Uploading file $CONTENT_PATH to s3://$KB_BUCKET/ ..."
  aws s3 cp "$CONTENT_PATH" "s3://$KB_BUCKET/" --region "$REGION" \
    || fail "s3 cp failed"
fi
ok "Content uploaded"

# --- 3. Start ingestion and poll to completion -------------------------------
info "Starting ingestion job..."
JOB_ID="$(aws bedrock-agent start-ingestion-job \
  --knowledge-base-id "$KB_ID" \
  --data-source-id "$DS_ID" \
  --region "$REGION" \
  --query 'ingestionJob.ingestionJobId' --output text)" \
  || fail "start-ingestion-job failed"
info "Ingestion job: $JOB_ID"

# Poll (up to ~10 minutes; small KBs typically finish in under a minute).
STATUS="STARTING"
for _ in $(seq 1 60); do
  STATUS="$(aws bedrock-agent get-ingestion-job \
    --knowledge-base-id "$KB_ID" \
    --data-source-id "$DS_ID" \
    --ingestion-job-id "$JOB_ID" \
    --region "$REGION" \
    --query 'ingestionJob.status' --output text)"
  case "$STATUS" in
    COMPLETE) break ;;
    FAILED|STOPPED) break ;;
    *) sleep 10 ;;
  esac
done

if [[ "$STATUS" != "COMPLETE" ]]; then
  aws bedrock-agent get-ingestion-job \
    --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
    --ingestion-job-id "$JOB_ID" --region "$REGION" \
    --query 'ingestionJob.failureReasons' --output text 2>/dev/null || true
  fail "ingestion job $JOB_ID did not complete (status: $STATUS)"
fi

STATS="$(aws bedrock-agent get-ingestion-job \
  --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
  --ingestion-job-id "$JOB_ID" --region "$REGION" \
  --query 'ingestionJob.statistics' --output json)"
SCANNED="$(echo "$STATS" | jq -r '.numberOfDocumentsScanned // 0')"
INDEXED="$(echo "$STATS" | jq -r '(.numberOfNewDocumentsIndexed // 0) + (.numberOfModifiedDocumentsIndexed // 0)')"
FAILED_DOCS="$(echo "$STATS" | jq -r '.numberOfDocumentsFailed // 0')"

echo ""
echo "=========================================="
echo "Knowledge base populated"
echo "=========================================="
echo "Documents scanned: $SCANNED, indexed: $INDEXED, failed: $FAILED_DOCS"
[[ "$FAILED_DOCS" != "0" ]] && warn "some documents failed to index — check supported formats/size limits"
ok "Done. The AI agent can now retrieve this content on the next call."
