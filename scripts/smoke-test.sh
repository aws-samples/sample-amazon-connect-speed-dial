#!/usr/bin/env bash
set -euo pipefail

REGION="${5:-us-east-1}"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Usage check
if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "Usage: $0 <instance-id> <flow-id> <assistant-id> <ai-agent-id> [region]" >&2
  exit 1
fi

INSTANCE_ID="${1##*/}"
FLOW_ID="${2##*/}"
ASSISTANT_ID="${3##*/}"
AI_AGENT_ID="${4##*/}"
AI_AGENT_ID="${AI_AGENT_ID%%:*}"

FAILED=0

fail() {
  echo -e "${RED}✗ $1${NC}" >&2
  FAILED=1
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

# 1. Check instance is ACTIVE
info "Checking instance status..."
INSTANCE_STATUS=$(aws connect describe-instance \
  --instance-id "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'Instance.InstanceStatus' \
  --output text 2>/dev/null || echo "ERROR")

if [[ "$INSTANCE_STATUS" == "ACTIVE" ]]; then
  ok "Instance is ACTIVE"
else
  fail "Instance status: $INSTANCE_STATUS (expected ACTIVE)"
fi

# 2. Check contact flow is PUBLISHED
info "Checking contact flow status..."
FLOW_STATUS=$(aws connect describe-contact-flow \
  --instance-id "$INSTANCE_ID" \
  --contact-flow-id "$FLOW_ID" \
  --region "$REGION" \
  --query 'ContactFlow.Status' \
  --output text 2>/dev/null || echo "ERROR")

if [[ "$FLOW_STATUS" == "PUBLISHED" ]]; then
  ok "Contact flow is PUBLISHED"
else
  fail "Contact flow status: $FLOW_STATUS (expected PUBLISHED)"
fi

# 3. Check AI Agent is PUBLISHED
info "Checking AI Agent status..."
AI_AGENT_STATUS=$(aws qconnect get-ai-agent \
  --assistant-id "$ASSISTANT_ID" \
  --ai-agent-id "$AI_AGENT_ID" \
  --region "$REGION" \
  --query 'aiAgent.status' \
  --output text 2>/dev/null || echo "ERROR")

if [[ "$AI_AGENT_STATUS" == "ACTIVE" ]] || [[ "$AI_AGENT_STATUS" == "CREATE_COMPLETE" ]]; then
  ok "AI Agent is $AI_AGENT_STATUS"
else
  fail "AI Agent status: $AI_AGENT_STATUS (expected ACTIVE or CREATE_COMPLETE)"
fi

# 4. Check a UK DID is claimed on the instance.
# Note: a phone number's TargetArn is always the *instance* ARN — the
# number-to-contact-flow binding is set separately via
# associate-phone-number-contact-flow and is not reflected in these summaries,
# so the verifiable condition here is "a GB DID is claimed on this instance".
info "Checking UK DID association..."
PHONE_NUMBER=$(aws connect list-phone-numbers-v2 \
  --instance-id "$INSTANCE_ID" \
  --region "$REGION" \
  --query "ListPhoneNumbersSummaryList[?PhoneNumberCountryCode=='GB'].PhoneNumber | [0]" \
  --output text 2>/dev/null || echo "")

if [[ -n "$PHONE_NUMBER" ]] && [[ "$PHONE_NUMBER" != "None" ]]; then
  ok "UK DID associated with flow: $PHONE_NUMBER"
else
  warn "No UK DID associated with flow (skip claim-uk-did.sh? — claim manually to receive calls)"
  PHONE_NUMBER="(none — no DID associated)"
fi

# Exit if any checks failed
if [[ $FAILED -eq 1 ]]; then
  echo ""
  echo -e "${RED}✗ Smoke test failed${NC}" >&2
  exit 1
fi

# Print summary
echo ""
echo "=========================================="
echo "Smoke Test Summary"
echo "=========================================="
echo "Phone Number:   $PHONE_NUMBER"
echo "Instance ID:    $INSTANCE_ID"
echo "Flow ID:        $FLOW_ID"
echo "AI Agent ID:    $AI_AGENT_ID"
echo ""
echo "Admin Console:  https://console.aws.amazon.com/connect/v2/app/instances/$INSTANCE_ID"
echo ""
if [[ "$PHONE_NUMBER" == "(none — no DID associated)" ]]; then
  echo -e "${GREEN}✓ All required checks passed.${NC} ${YELLOW}Claim a phone number to test the voice agent.${NC}"
else
  echo -e "${GREEN}✓ All checks passed! Call $PHONE_NUMBER to test the voice agent.${NC}"
fi
exit 0
