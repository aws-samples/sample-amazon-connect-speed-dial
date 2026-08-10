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
# Optional: path to the order JSON — enables the Identity Center prerequisite
# gate when the order has identityCenterEnabled=true.
ORDER_FILE="${2:-}"
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
# Probe the answer-generation base model: it is a real dependency of the
# deployment in every region. (This used to probe amazon.nova-2-sonic-v1:0,
# which is no longer used — the voice pipeline is Amazon Connect agentic voice,
# Connect-hosted rather than a Bedrock model the account has to enable.)
BEDROCK_MODEL="${NOVA_MODEL_ID:-amazon.nova-pro-v1:0}"
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

# 5. Identity Center prerequisites (only when the order enables it).
# The identity management type is IMMUTABLE after instance creation, and the
# CDK synth requires saml-metadata.xml (connect-instance-stack.ts throws
# without it) — so both must be settled BEFORE render/deploy, not after.
if [[ -n "$ORDER_FILE" && -f "$ORDER_FILE" ]]; then
  IDC_ENABLED="$(jq -r '.identityCenterEnabled // false' "$ORDER_FILE" 2>/dev/null || echo false)"
  if [[ "$IDC_ENABLED" == "true" ]]; then
    info "Identity Center is enabled — checking prerequisites..."

    # 5a. The SAML metadata file must exist in the working dir (next to the
    # order file); render-templates.sh carries it into the rendered project.
    WORK_DIR="$(cd "$(dirname "$ORDER_FILE")" && pwd)"
    if [[ -f "$WORK_DIR/saml-metadata.xml" ]]; then
      # Cheap sanity check: it should be a SAML EntityDescriptor document.
      if grep -q "EntityDescriptor" "$WORK_DIR/saml-metadata.xml"; then
        ok "saml-metadata.xml found and looks like SAML metadata"
      else
        fail "saml-metadata.xml exists but does not look like SAML metadata (no EntityDescriptor element). Re-download it from: IAM Identity Center → Applications → your Connect app → IAM Identity Center metadata"
      fi
    else
      echo "" >&2
      echo "Identity Center SSO requires a MANUAL step before deployment:" >&2
      echo "  1. IAM Identity Center console → Applications → Add application" >&2
      echo "     → 'Add custom SAML 2.0 application' (or the Amazon Connect catalog app)" >&2
      echo "  2. Download the 'IAM Identity Center SAML metadata file'" >&2
      echo "  3. Save it as: $WORK_DIR/saml-metadata.xml" >&2
      echo "" >&2
      fail "saml-metadata.xml not found at $WORK_DIR/saml-metadata.xml — complete the manual Identity Center step first (the identity type cannot be changed after the instance is created)"
    fi

    # 5b. Soft probe: is an Identity Center instance visible from this account?
    # Not authoritative — org instances often live in the management account and
    # may not be listable from a member account — so this only warns.
    if aws sso-admin list-instances --region "$REGION" --query 'Instances[0].InstanceArn' --output text 2>/dev/null | grep -q "^arn:"; then
      ok "IAM Identity Center instance visible from this account"
    else
      warn "No Identity Center instance visible from this account/region — fine if Identity Center lives in your organization's management account (the SAML flow is browser-based and needs no cross-account trust)"
    fi
  fi
fi

echo ""
ok "All preflight checks passed!"
exit 0
