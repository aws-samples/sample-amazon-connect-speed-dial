#!/usr/bin/env bash
set -euo pipefail

# Redeploy script: re-renders from template, type-checks, and deploys via CDK.
# Usage: ./scripts/redeploy.sh [stack-name-or-pattern]
#   If no argument given, deploys all stacks (--all).
#   Reads account/region from .connect-skill-values.json.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VALUES_FILE="$PROJECT_ROOT/.connect-skill-values.json"
SRC_DIR="$PROJECT_ROOT/templates/cdk-app"
DEST_DIR="$PROJECT_ROOT/cnsb-dev"

if [[ ! -f "$VALUES_FILE" ]]; then
  echo "ERROR: values file not found: $VALUES_FILE" >&2
  exit 1
fi

# Read account and region from the values file
CDK_DEFAULT_ACCOUNT="$(jq -r '.accountId' "$VALUES_FILE")"
CDK_DEFAULT_REGION="$(jq -r '.region' "$VALUES_FILE")"
export CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION

CDK_TARGET="${1:---all}"

echo "==> Account: $CDK_DEFAULT_ACCOUNT | Region: $CDK_DEFAULT_REGION"
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
