#!/usr/bin/env bash
set -euo pipefail

# Redeploy script: re-renders from template, type-checks, and deploys via CDK.
# Usage: ./scripts/redeploy.sh [stack-name-or-pattern] [project-dir]
#   stack-name-or-pattern  stacks to deploy (default: --all)
#   project-dir            rendered project directory (default: cnsb-dev at the
#                          repo root, the historical dev default)
#
# Reads region (and optionally accountId) from the project's values file:
#   <project-dir>/.connect-skill-values.json   (project-scoped, preferred)
#   <repo-root>/.connect-skill-values.json     (legacy fallback)
# If the values file has no accountId, the account is resolved live from STS.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CDK_TARGET="${1:---all}"
DEST_DIR="${2:-$PROJECT_ROOT/cnsb-dev}"
SRC_DIR="$PROJECT_ROOT/templates/cdk-app"

VALUES_FILE="$DEST_DIR/.connect-skill-values.json"
[[ -f "$VALUES_FILE" ]] || VALUES_FILE="$PROJECT_ROOT/.connect-skill-values.json"
if [[ ! -f "$VALUES_FILE" ]]; then
  echo "ERROR: values file not found at $DEST_DIR/.connect-skill-values.json or $PROJECT_ROOT/.connect-skill-values.json" >&2
  exit 1
fi

# Region comes from the values file (emitted by build-values.sh). accountId is
# not a build-values output — fall back to the caller's STS identity.
CDK_DEFAULT_REGION="$(jq -r '.region // empty' "$VALUES_FILE")"
[[ -n "$CDK_DEFAULT_REGION" ]] || { echo "ERROR: no region in $VALUES_FILE" >&2; exit 1; }
CDK_DEFAULT_ACCOUNT="$(jq -r '.accountId // empty' "$VALUES_FILE")"
if [[ -z "$CDK_DEFAULT_ACCOUNT" ]]; then
  CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
fi
export CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION
export AWS_REGION="$CDK_DEFAULT_REGION" AWS_DEFAULT_REGION="$CDK_DEFAULT_REGION"

echo "==> Account: $CDK_DEFAULT_ACCOUNT | Region: $CDK_DEFAULT_REGION | Project: $DEST_DIR"
echo "==> Removing old rendered app..."
rm -rf "$DEST_DIR/lib" "$DEST_DIR/bin" "$DEST_DIR/lambda" "$DEST_DIR/flows" \
       "$DEST_DIR/prompts" "$DEST_DIR/package.json" "$DEST_DIR/tsconfig.json" \
       "$DEST_DIR/cdk.json" "$DEST_DIR/node_modules" "$DEST_DIR/cdk.out"

echo "==> Rendering templates..."
"$SCRIPT_DIR/render-templates.sh" "$VALUES_FILE" "$SRC_DIR" "$DEST_DIR"

echo "==> Installing dependencies..."
cd "$DEST_DIR"
# Prefer a reproducible lockfile install; fall back to npm install if no
# package-lock.json is present yet (first deploy of a freshly rendered project).
npm ci --silent 2>/dev/null || npm install --silent

echo "==> Type-checking..."
npx tsc --noEmit -p tsconfig.json

echo "==> Synthesizing (dry run)..."
npx cdk synth --quiet

echo "==> Deploying CDK ($CDK_TARGET)..."
npx cdk deploy "$CDK_TARGET" --require-approval never --outputs-file cdk-outputs.json

echo "==> Done. Outputs written to $DEST_DIR/cdk-outputs.json"
