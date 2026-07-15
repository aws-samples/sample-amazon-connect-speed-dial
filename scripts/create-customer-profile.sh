#!/usr/bin/env bash
set -euo pipefail

# create-customer-profile.sh — create (or update) an Amazon Connect Customer
# Profile that defines everything the AI agent should know about a caller:
# identity (name, account id, tier) AND recent-activity context (recent order,
# its status, open cases). When customerProfilesEnabled, the flow's
# profile-lookup Lambda searches for the caller and injects this profile into
# the Q Connect session ({{$.Custom.*}}), overriding the static context-injection
# demo baseline. So this script is how you create "a new user + their injected
# context" without touching the AWS console.
#
# Lookup keys the flow uses (so the profile resolves on a real call):
#   - voice:    the caller's phone number  -> set --phone
#   - web-call: the signed-in Cognito user -> set --cognito-username (its `sub`
#               becomes the profile AccountNumber, which the flow searches as _account)
#
# Idempotent: if a profile with the same AccountNumber already exists, it is
# updated rather than duplicated.
#
# Usage:
#   create-customer-profile.sh <project-dir> --first <First> --last <Last> \
#       [--account <id> | --cognito-username <user>] \
#       [--phone <+E164>] [--tier <Premium|Gold|...>] \
#       [--order-id <ORD-...>] [--order-status <Shipped|...>] [--open-cases <n>]
#
# Examples:
#   # Tie a profile to a web-call user (its Cognito sub becomes the account id):
#   create-customer-profile.sh ./finalreview --first Jordan --last Lee \
#       --cognito-username jordan --tier Gold --order-id ORD-98765 --order-status Delivered
#
#   # A phone caller:
#   create-customer-profile.sh ./finalreview --first Sam --last Rivera \
#       --account CUST777 --phone +15555550100 --tier Standard

REGION="us-east-1"
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
info() { echo "→ $1"; }
fail() { echo -e "${RED}✗ $1${NC}" >&2; exit 1; }

PROJECT_DIR="${1:-}"; shift || true
[[ -n "$PROJECT_DIR" ]] || fail "usage: create-customer-profile.sh <project-dir> --first F --last L [...]"
OUTPUTS="$PROJECT_DIR/cdk-outputs.json"
[[ -f "$OUTPUTS" ]] || fail "cdk-outputs.json not found at $OUTPUTS (deploy the project first)"

FIRST=""; LAST=""; ACCOUNT=""; COGNITO_USER=""; PHONE=""; TIER=""; ORDER_ID=""; ORDER_STATUS=""; OPEN_CASES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --first) FIRST="$2"; shift 2;;
    --last) LAST="$2"; shift 2;;
    --account) ACCOUNT="$2"; shift 2;;
    --cognito-username) COGNITO_USER="$2"; shift 2;;
    --phone) PHONE="$2"; shift 2;;
    --tier) TIER="$2"; shift 2;;
    --order-id) ORDER_ID="$2"; shift 2;;
    --order-status) ORDER_STATUS="$2"; shift 2;;
    --open-cases) OPEN_CASES="$2"; shift 2;;
    *) fail "unknown arg: $1";;
  esac
done

[[ -n "$FIRST" && -n "$LAST" ]] || fail "--first and --last are required"

# The cdk-outputs.json only contains the stacks from the most recent
# `--outputs-file` deploy, which may be a subset. So read it first, then fall
# back to live CloudFormation outputs (by stack name) for anything missing.
# Stack names share the project prefix, derived from any outputs key.
STACK_PREFIX="$(jq -r 'keys[0] | sub("-[^-]+$";"")' "$OUTPUTS" 2>/dev/null)"
cfn_output() { # cfn_output <stackSuffix> <OutputKey>
  aws cloudformation describe-stacks --region "$REGION" --stack-name "${STACK_PREFIX}-$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null | grep -v '^None$' || true
}

DOMAIN="$(jq -r 'to_entries[] | select(.key | endswith("-ConnectInstance")) | .value.CustomerProfilesDomainName // empty' "$OUTPUTS" | head -n1)"
[[ -n "$DOMAIN" ]] || DOMAIN="$(cfn_output ConnectInstance CustomerProfilesDomainName)"
[[ -n "$DOMAIN" ]] || fail "could not find CustomerProfilesDomainName (in $OUTPUTS or CloudFormation) — is customerProfilesEnabled and the instance deployed?"

# Resolve the account id: explicit --account, else the Cognito user's sub.
if [[ -n "$COGNITO_USER" ]]; then
  POOL_ID="$(jq -r 'to_entries[] | select(.key | endswith("-WebcallWidget")) | .value.UserPoolId // empty' "$OUTPUTS" | head -n1)"
  [[ -n "$POOL_ID" ]] || POOL_ID="$(cfn_output WebcallWidget UserPoolId)"
  [[ -n "$POOL_ID" ]] || fail "--cognito-username given but no UserPoolId found (in outputs or CloudFormation) — is the WebcallWidget/frontend stack deployed?"
  info "Resolving Cognito sub for user '$COGNITO_USER' in pool $POOL_ID"
  ACCOUNT="$(aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$COGNITO_USER" --region "$REGION" \
    --query 'UserAttributes[?Name==`sub`].Value' --output text 2>/dev/null)" || fail "could not look up Cognito user '$COGNITO_USER'"
  [[ -n "$ACCOUNT" ]] || fail "no sub found for Cognito user '$COGNITO_USER'"
  ok "Cognito sub: $ACCOUNT (used as the profile AccountNumber → web-call lookup key)"
fi
[[ -n "$ACCOUNT" ]] || fail "provide --account <id> or --cognito-username <user> (the flow needs a lookup key)"

# Build the custom Attributes map (only non-empty ones).
ATTRS="$(jq -nc \
  --arg tier "$TIER" --arg oid "$ORDER_ID" --arg ost "$ORDER_STATUS" --arg oc "$OPEN_CASES" \
  '{} | (if $tier!="" then .accountTier=$tier else . end)
      | (if $oid!="" then .recentOrderId=$oid else . end)
      | (if $ost!="" then .orderStatus=$ost else . end)
      | (if $oc!="" then .openCaseCount=$oc else . end)')"

# Idempotency: is there already a profile for this AccountNumber?
EXISTING="$(aws customer-profiles search-profiles --domain-name "$DOMAIN" --region "$REGION" \
  --key-name _account --values "$ACCOUNT" --query 'Items[0].ProfileId' --output text 2>/dev/null || true)"

COMMON_ARGS=(--domain-name "$DOMAIN" --region "$REGION"
  --account-number "$ACCOUNT" --first-name "$FIRST" --last-name "$LAST"
  --party-type INDIVIDUAL --attributes "$ATTRS")
[[ -n "$PHONE" ]] && COMMON_ARGS+=(--phone-number "$PHONE")

if [[ -n "$EXISTING" && "$EXISTING" != "None" ]]; then
  info "Profile for account '$ACCOUNT' exists ($EXISTING) — updating"
  aws customer-profiles update-profile --profile-id "$EXISTING" "${COMMON_ARGS[@]}" >/dev/null \
    || fail "update-profile failed"
  ok "Updated profile $EXISTING"
else
  info "Creating profile for account '$ACCOUNT' in domain '$DOMAIN'"
  PID="$(aws customer-profiles create-profile "${COMMON_ARGS[@]}" --query 'ProfileId' --output text)" \
    || fail "create-profile failed"
  ok "Created profile $PID"
fi

echo
echo "Injected context this profile will give the agent ({{\$.Custom.*}}):"
echo "  customerName  = $FIRST $LAST"
echo "  customerId    = $ACCOUNT"
[[ -n "$TIER" ]]         && echo "  accountTier   = $TIER"
[[ -n "$ORDER_ID" ]]     && echo "  recentOrderId = $ORDER_ID"
[[ -n "$ORDER_STATUS" ]] && echo "  orderStatus   = $ORDER_STATUS"
[[ -n "$OPEN_CASES" ]]   && echo "  openCaseCount = $OPEN_CASES"
echo
if [[ -n "$COGNITO_USER" ]]; then
  ok "Call from the web-call app signed in as '$COGNITO_USER' — the agent will greet $FIRST."
else
  echo -e "${YELLOW}→ Voice: call from $PHONE to match this profile. (Web-call matches by Cognito user only.)${NC}"
fi
