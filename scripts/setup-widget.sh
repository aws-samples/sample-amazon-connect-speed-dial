#!/usr/bin/env bash
set -euo pipefail

# setup-widget.sh — wire up an Amazon Connect communication widget for the
# web-call frontend, end to end:
#   1. Extract id/snippetId/scriptUrl from the pasted embed snippet and patch
#      lib/config.ts (via extract-widget.js).
#   2. Deploy the <prefix>-WebcallWidget stack so the widget config and an (empty)
#      Secrets Manager secret are created.
#   3. Write the security key into that secret so the token Lambda can sign JWTs.
#
# Idempotent: re-running replaces the widget entry and overwrites the secret.
#
# Usage:
#   setup-widget.sh <project-dir> <embed-file> <security-key> [region]
#
# Args:
#   project-dir    rendered project directory (contains lib/config.ts, cdk.json)
#   embed-file     path to a file holding the pasted <script> embed snippet
#   security-key   the widget security key from the Connect console
#   region         deploy region (optional). Precedence: this arg, then the
#                  `region` key in .connect-skill-values.json, then us-east-1.
#
# NOTE: region is an explicit arg (matching SKILL.md's Branch B call and the
# sibling setup-test-users.sh) because build-values.sh does NOT emit `region`
# to .connect-skill-values.json — relying on the values file alone silently
# defaulted eu-central-1 deployments to us-east-1.

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
info() { echo "→ $1"; }
fail() { echo -e "${RED}✗ $1${NC}" >&2; exit 1; }

PROJECT_DIR="${1:?usage: setup-widget.sh <project-dir> <embed-file> <security-key> [region]}"
EMBED_FILE="${2:?usage: setup-widget.sh <project-dir> <embed-file> <security-key> [region]}"
SECURITY_KEY="${3:?usage: setup-widget.sh <project-dir> <embed-file> <security-key> [region]}"
REGION_ARG="${4:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_TS="$PROJECT_DIR/lib/config.ts"

# Resolve region: explicit arg wins, else the values file, else us-east-1.
# Values file lives in the project dir (project-scoped); the repo-root location
# is the legacy fallback for deployments created before project scoping.
VALUES_FILE="$PROJECT_DIR/.connect-skill-values.json"
[[ -f "$VALUES_FILE" ]] || VALUES_FILE="$REPO_ROOT/.connect-skill-values.json"
if [[ -n "$REGION_ARG" ]]; then
  REGION="$REGION_ARG"
elif [[ -f "$VALUES_FILE" ]]; then
  REGION="$(jq -r '.region // "us-east-1"' "$VALUES_FILE")"
else
  REGION="us-east-1"
fi
[[ "$REGION" == "us-east-1" || "$REGION" == "eu-central-1" ]] || fail "unsupported region '$REGION' (pass it as the 4th arg: us-east-1 or eu-central-1)"

[[ -f "$CONFIG_TS" ]]   || fail "config.ts not found at $CONFIG_TS (is <project-dir> a rendered project?)"
[[ -f "$EMBED_FILE" ]]  || fail "embed file not found: $EMBED_FILE"
[[ -n "$SECURITY_KEY" ]] || fail "security key is empty"

# --- 1. Extract + patch config.ts -----------------------------------------
info "Extracting widget fields and patching config.ts..."
EXTRACT_JSON="$(node "$SCRIPT_DIR/extract-widget.js" --config "$CONFIG_TS" --embed "$EMBED_FILE")"
WIDGET_ID="$(echo "$EXTRACT_JSON" | jq -r '.id')"
PREFIX="$(echo "$EXTRACT_JSON" | jq -r '.prefix')"
[[ -n "$WIDGET_ID" && "$WIDGET_ID" != "null" ]] || fail "could not extract widget id"
[[ -n "$PREFIX" && "$PREFIX" != "null" ]]       || fail "could not read project prefix"
ok "Widget $WIDGET_ID extracted; config.ts patched (prefix: $PREFIX)"

# --- 2. Deploy the widget stack --------------------------------------------
# This (re)creates config.js with the widget and the empty signing-key secret.
info "Deploying ${PREFIX}-WebcallWidget stack in ${REGION} (this can take a few minutes)..."
# Pin the region for both the CDK CLI's environment lookup (AWS_REGION /
# AWS_DEFAULT_REGION — the CLI re-derives region from the AWS SDK and would
# otherwise ignore CDK_DEFAULT_REGION when the ambient profile points elsewhere)
# and the app's env (CDK_DEFAULT_REGION, read in bin/connect-blueprint.ts).
# --exclusively keeps the deploy to the widget stack alone; without it CDK pulls
# in the ConnectInstance dependency stack and tries to recreate the (already
# existing) storage bucket.
(
  cd "$PROJECT_DIR"
  AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" CDK_DEFAULT_REGION="$REGION" \
    npx cdk deploy "${PREFIX}-WebcallWidget" --exclusively --require-approval never --outputs-file cdk-outputs.json
) || fail "cdk deploy of ${PREFIX}-WebcallWidget failed"
ok "Widget stack deployed"

# --- 3. Write the security key into the widget's Secrets Manager secret ----
SECRET_NAME="${PREFIX}-widget-secret-${WIDGET_ID}"
info "Storing security key in Secrets Manager secret: $SECRET_NAME"
aws secretsmanager put-secret-value \
  --secret-id "$SECRET_NAME" \
  --secret-string "$SECURITY_KEY" \
  --region "$REGION" >/dev/null \
  || fail "failed to write security key to secret $SECRET_NAME"
ok "Security key stored"

# --- Report the live URL ---------------------------------------------------
CLOUDFRONT_URL="$(jq -r --arg s "${PREFIX}-WebcallWidget" '.[$s].CloudFrontUrl // empty' "$PROJECT_DIR/cdk-outputs.json" 2>/dev/null || true)"

echo ""
echo "=========================================="
echo "Web-call widget configured"
echo "=========================================="
[[ -n "$CLOUDFRONT_URL" ]] && echo "Web-call site:  $CLOUDFRONT_URL"
echo "Widget ID:      $WIDGET_ID"
echo "Secret:         $SECRET_NAME"
echo ""
echo -e "${GREEN}✓ Done.${NC} Create a Cognito login for the user pool, then open the site and click to call."
echo -e "${YELLOW}  (No login yet? Add one in the Cognito console for the ${PREFIX}-webcall-users pool.)${NC}"
