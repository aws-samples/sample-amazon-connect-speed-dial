#!/usr/bin/env bash
set -euo pipefail

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
fail() {
  echo -e "${RED}✗ $1${NC}" >&2
  exit 1
}

ok() {
  echo -e "${GREEN}✓ $1${NC}"
}

warn() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

info() {
  echo "→ $1"
}

# Deploy region (default Virginia). Frankfurt is also supported.
REGION="${1:-us-east-1}"
case "$REGION" in
  us-east-1|eu-central-1) ;;
  *) fail "unsupported region '$REGION' (use us-east-1 or eu-central-1)";;
esac

# 1. Check AWS credentials
info "Checking AWS credentials..."
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  fail "AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE."
fi
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ok "AWS credentials valid (Account: $ACCOUNT)"

# 2. Check CDK installed
info "Checking CDK installation..."
if command -v cdk >/dev/null 2>&1; then
  CDK_VERSION=$(cdk --version 2>&1 | head -n1)
  ok "CDK installed: $CDK_VERSION"
  CDK_CMD="cdk"
elif npx --no-install cdk --version >/dev/null 2>&1; then
  CDK_VERSION=$(npx --no-install cdk --version 2>&1 | head -n1)
  ok "CDK available via npx: $CDK_VERSION"
  CDK_CMD="npx cdk"
else
  fail "CDK not installed. Run 'npm install -g aws-cdk@2.1128.0' or 'npm install'."
fi

# 3. Check CDK bootstrap in the target region
info "Checking CDK bootstrap state in $REGION..."
if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" >/dev/null 2>&1; then
  warn "CDKToolkit stack not found in $REGION. Bootstrapping..."
  if ! $CDK_CMD bootstrap "aws://$ACCOUNT/$REGION"; then
    fail "CDK bootstrap failed"
  fi
  ok "CDK bootstrap completed"
else
  ok "CDK bootstrap verified in $REGION"
fi

# 4. Check Bedrock reachability in the target region.
# us-east-1: the Nova Sonic voice model is listable and is the canonical probe.
# eu-central-1: Nova Sonic is delivered via Amazon Connect (not directly
#   listable in Bedrock there), so probe the answer-gen base model instead.
if [[ "$REGION" == "eu-central-1" ]]; then
  BEDROCK_MODEL="${NOVA_MODEL_ID:-amazon.nova-pro-v1:0}"
else
  BEDROCK_MODEL="${NOVA_MODEL_ID:-amazon.nova-2-sonic-v1:0}"
fi
info "Checking Bedrock model access for $BEDROCK_MODEL in $REGION..."
if aws bedrock get-foundation-model --model-identifier "$BEDROCK_MODEL" --region "$REGION" >/dev/null 2>&1; then
  ok "Bedrock model $BEDROCK_MODEL accessible"
else
  warn "Bedrock model $BEDROCK_MODEL not accessible"
  echo ""
  echo "Please enable model access in the Bedrock console:"
  echo "  https://console.aws.amazon.com/bedrock/home?region=$REGION#/modelaccess"
  echo ""
  fail "Bedrock model $BEDROCK_MODEL not accessible"
fi

echo ""
ok "All preflight checks passed!"
exit 0
