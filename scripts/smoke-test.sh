#!/usr/bin/env bash
set -euo pipefail

REGION="${5:-us-east-1}"
PROJECT_DIR="${6:-}"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Usage check
if [[ $# -lt 4 || $# -gt 6 ]]; then
  echo "Usage: $0 <instance-id> <flow-id> <assistant-id> <ai-agent-id> [region] [project-dir]" >&2
  echo "  project-dir: rendered project containing cdk-outputs.json — enables the" >&2
  echo "  conditional contact-events and knowledge-base checks (skipped if omitted)." >&2
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

# 5. Conditional feature checks — driven by which stacks emitted outputs.
# cdk-outputs.json contains a per-stack key only when that stack was deployed,
# so key presence doubles as the feature flag (no extra arguments needed).
if [[ -n "$PROJECT_DIR" && -f "$PROJECT_DIR/cdk-outputs.json" ]]; then
  OUTPUTS="$PROJECT_DIR/cdk-outputs.json"

  # 5a. Contact events: the EventBridge rule must exist and be ENABLED.
  CE_RULE_ARN=$(jq -r 'to_entries[] | select(.key | endswith("-ContactEvents")) | .value.RuleArn // empty' "$OUTPUTS" | head -n1)
  if [[ -n "$CE_RULE_ARN" ]]; then
    info "Checking contact-events EventBridge rule..."
    CE_RULE_NAME="${CE_RULE_ARN##*/}"
    CE_STATE=$(aws events describe-rule       --name "$CE_RULE_NAME"       --region "$REGION"       --query 'State'       --output text 2>/dev/null || echo "ERROR")
    if [[ "$CE_STATE" == "ENABLED" ]]; then
      ok "Contact-events rule is ENABLED ($CE_RULE_NAME)"
    else
      fail "Contact-events rule state: $CE_STATE (expected ENABLED)"
    fi
  fi

  # 5b. Identity Center SSO: the instance must actually be SAML-managed.
  # (The identity type is immutable — if this mismatches, the instance must be
  # recreated, so surface it loudly.)
  EXPECTED_IDM=$(jq -r 'to_entries[] | select(.key | endswith("-ConnectInstance")) | .value.IdentityManagementType // empty' "$OUTPUTS" | head -n1)
  if [[ "$EXPECTED_IDM" == "SAML" ]]; then
    info "Checking instance identity management type..."
    ACTUAL_IDM=$(aws connect describe-instance       --instance-id "$INSTANCE_ID"       --region "$REGION"       --query 'Instance.IdentityManagementType'       --output text 2>/dev/null || echo "ERROR")
    if [[ "$ACTUAL_IDM" == "SAML" ]]; then
      ok "Instance uses SAML identity management (Identity Center SSO)"
    else
      fail "Instance identity management type: $ACTUAL_IDM (expected SAML — the type is immutable; recreating the instance is the only fix)"
    fi
  fi

  # 5c. Knowledge base: the Bedrock KB must be ACTIVE.
  KB_ID=$(jq -r 'to_entries[] | select(.key | endswith("-Wisdom")) | .value.BedrockKnowledgeBaseId // empty' "$OUTPUTS" | head -n1)
  if [[ -n "$KB_ID" ]]; then
    info "Checking Bedrock knowledge base status..."
    KB_STATUS=$(aws bedrock-agent get-knowledge-base       --knowledge-base-id "$KB_ID"       --region "$REGION"       --query 'knowledgeBase.status'       --output text 2>/dev/null || echo "ERROR")
    if [[ "$KB_STATUS" == "ACTIVE" ]]; then
      ok "Bedrock knowledge base is ACTIVE ($KB_ID)"
    else
      fail "Bedrock knowledge base status: $KB_STATUS (expected ACTIVE)"
    fi
  fi
elif [[ -n "$PROJECT_DIR" ]]; then
  warn "cdk-outputs.json not found in $PROJECT_DIR — skipping contact-events/knowledge-base checks"
else
  warn "no project-dir argument — skipping contact-events/knowledge-base checks"
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
