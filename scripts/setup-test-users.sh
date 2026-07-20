#!/usr/bin/env bash
set -euo pipefail

# setup-test-users.sh — provision a test user end to end: a Cognito login for
# the web-call frontend (temporary password delivered by EMAIL, not printed to
# the terminal) plus a matching Amazon Connect Customer Profile so the AI agent
# has this caller's identity and context on a web-call.
#
# If the WebcallWidget stack is not deployed (no Cognito pool), the Cognito
# user creation is skipped and only the Customer Profile is created. This
# supports phone-only deployments where the profile is resolved by ANI.
#
# This composes two patterns in one script:
#   - Cognito user creation (admin-create-user with temp password by email).
#     The user must change it on first sign-in (FORCE_CHANGE_PASSWORD).
#   - Customer Profile creation/update (search-profiles + create-profile/
#     update-profile, keyed by AccountNumber = the new user's Cognito `sub`
#     for web-call lookup, or by phone for phone-only deployments).
#
# Idempotent:
#   - Cognito: if the user already exists and is still pending first sign-in
#     (FORCE_CHANGE_PASSWORD), --message-action RESEND generates a NEW
#     temporary password and re-sends it by email. A user who already
#     completed first sign-in (CONFIRMED) is left untouched — RESEND is
#     invalid for that state, so the script skips it and prints the
#     admin-reset-user-password command instead.
#   - Customer Profile: existing profile for the same AccountNumber is updated
#     rather than duplicated.
#
# Requires: customerProfilesEnabled (Customer Profiles domain). The
# WebcallWidget stack (Cognito pool) is optional — if absent, only the
# Customer Profile is created.
#
# Usage:
#   setup-test-users.sh <project-dir> <username> <first> <last> <email> \
#       <phone-e164> <customer-number>
#
# Args:
#   project-dir      rendered project directory (contains cdk-outputs.json)
#   username         Cognito login username
#   first            first name
#   last             last name
#   email            email address — required Cognito attribute AND the
#                     address the temporary password is sent to
#   phone-e164       phone number in +<countrycode><number> format (E.164),
#                     e.g. +15555550100 — stored on the Customer Profile only
#   customer-number  an arbitrary customer/account number for this test user,
#                     stored as a custom Attribute on the Customer Profile
#                     (kept separate from the Cognito `sub`, which is used as
#                     the profile's AccountNumber / web-call lookup key)
#   region           deploy region (optional). Precedence: this arg, then the
#                     `region` key in .connect-skill-values.json, then us-east-1.
#                     (matches setup-widget.sh — do NOT
#                     just default to us-east-1, or an eu-central-1 deploy's
#                     Cognito user pool / Customer Profiles domain resolves as
#                     "does not exist" even though the outputs file has real IDs)
#
# Example:
#   setup-test-users.sh ./finalreview jordan Jordan Lee jordan@example.com \
#       +15555550100 0000100042

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
info() { echo "→ $1"; }
fail() { echo -e "${RED}✗ $1${NC}" >&2; exit 1; }

USAGE="usage: setup-test-users.sh <project-dir> <username> <first> <last> <email> <phone-e164> <customer-number> [region]"
PROJECT_DIR="${1:?$USAGE}"
USERNAME="${2:?$USAGE}"
FIRST="${3:?$USAGE}"
LAST="${4:?$USAGE}"
EMAIL="${5:?$USAGE}"
PHONE="${6:?$USAGE}"
CUSTOMER_NUMBER="${7:?$USAGE}"
REGION_ARG="${8:-}"

# Resolve region: explicit arg wins, else .connect-skill-values.json (repo
# root, two levels up from this script), else us-east-1. Same precedence as
# setup-widget.sh, and for the same reason: build-values.sh does not emit
# `region` into the rendered project, and silently defaulting to us-east-1
# would query the wrong region's resources with no useful error.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Project-scoped values first (<project-dir>/.connect-skill-values.json);
# repo-root location is the legacy fallback for pre-project-scoping deployments.
VALUES_FILE="$PROJECT_DIR/.connect-skill-values.json"
[[ -f "$VALUES_FILE" ]] || VALUES_FILE="$REPO_ROOT/.connect-skill-values.json"
if [[ -n "$REGION_ARG" ]]; then
  REGION="$REGION_ARG"
elif [[ -f "$VALUES_FILE" ]]; then
  REGION="$(jq -r '.region // "us-east-1"' "$VALUES_FILE")"
else
  REGION="us-east-1"
fi
info "Region: $REGION"

[[ "$PHONE" =~ ^\+[1-9][0-9]{7,14}$ ]] || fail "phone '$PHONE' is not in E.164 format (e.g. +15555550100)"
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "email '$EMAIL' doesn't look valid"

OUTPUTS="$PROJECT_DIR/cdk-outputs.json"
[[ -f "$OUTPUTS" ]] || fail "cdk-outputs.json not found at $OUTPUTS (deploy the project first)"

# cdk-outputs.json only reflects the most recent `--outputs-file` deploy, which
# may be a subset of stacks. Read it first, then fall back to live
# CloudFormation outputs by stack name.
STACK_PREFIX="$(jq -r 'keys[0] | sub("-[^-]+$";"")' "$OUTPUTS" 2>/dev/null)"
cfn_output() { # cfn_output <stackSuffix> <OutputKey>
  aws cloudformation describe-stacks --region "$REGION" --stack-name "${STACK_PREFIX}-$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null | grep -v '^None$' || true
}

# --- Resolve the Cognito User Pool ID (optional — skipped if no WebcallWidget) ---
USER_POOL_ID="$(jq -r 'to_entries[] | select(.key | endswith("-WebcallWidget")) | .value.UserPoolId // empty' "$OUTPUTS" | head -n1)"
[[ -n "$USER_POOL_ID" ]] || USER_POOL_ID="$(cfn_output WebcallWidget UserPoolId)"

HAS_WEBCALL=false
if [[ -n "$USER_POOL_ID" ]]; then
  HAS_WEBCALL=true
  info "User pool: $USER_POOL_ID"
else
  info "No WebcallWidget stack found — skipping Cognito user creation (profile-only mode)"
fi

# --- Resolve the Customer Profiles domain -----------------------------------
# Read from CloudFormation stack output directly (cdk-outputs.json may be stale).
DOMAIN="$(cfn_output ConnectInstance CustomerProfilesDomainName)"
[[ -n "$DOMAIN" ]] || fail "could not find CustomerProfilesDomainName from CloudFormation stack ${STACK_PREFIX}-ConnectInstance — is customerProfilesEnabled and the instance deployed?"

# --- Create (or re-invite) the Cognito user, temp password sent by email ---
# Skipped entirely when there is no WebcallWidget stack (phone-only deployments).
SUB=""
if [[ "$HAS_WEBCALL" == "true" ]]; then
  # No --temporary-password: Cognito generates one. No --message-action SUPPRESS:
  # Cognito sends its default invitation email (subject/body from the pool's
  # message customization, or the built-in default if unset) containing the
  # username and temporary password. --desired-delivery-mediums EMAIL pins the
  # channel (the pool has no phone_number attribute configured, so EMAIL is the
  # only usable medium here anyway).
  if aws cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$USERNAME" --region "$REGION" >/dev/null 2>&1; then
    # RESEND is only valid while the user is still in FORCE_CHANGE_PASSWORD
    # (i.e. never completed first sign-in). For a CONFIRMED user Cognito
    # rejects it, so skip the resend and leave their password untouched.
    USER_STATUS="$(aws cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$USERNAME" --region "$REGION" \
      --query 'UserStatus' --output text 2>/dev/null)"
    if [[ "$USER_STATUS" == "FORCE_CHANGE_PASSWORD" ]]; then
      info "User '$USERNAME' already exists (pending first sign-in) — resending a new temporary password by email"
      aws cognito-idp admin-create-user \
        --user-pool-id "$USER_POOL_ID" \
        --username "$USERNAME" \
        --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
        --desired-delivery-mediums EMAIL \
        --message-action RESEND \
        --region "$REGION" >/dev/null \
        || fail "admin-create-user (RESEND) failed"
    else
      info "User '$USERNAME' already exists (status: $USER_STATUS) — keeping their existing password"
      echo "  (To reset it, use: aws cognito-idp admin-reset-user-password --user-pool-id $USER_POOL_ID --username $USERNAME --region $REGION)"
    fi
  else
    info "Creating user '$USERNAME'..."
    aws cognito-idp admin-create-user \
      --user-pool-id "$USER_POOL_ID" \
      --username "$USERNAME" \
      --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
      --desired-delivery-mediums EMAIL \
      --region "$REGION" >/dev/null \
      || fail "admin-create-user failed"
  fi
  ok "Temporary password emailed to $EMAIL"

  # --- Look up the sub (used as the Customer Profile AccountNumber) ----------
  SUB="$(aws cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$USERNAME" --region "$REGION" \
    --query 'UserAttributes[?Name==`sub`].Value' --output text 2>/dev/null)" || fail "could not look up Cognito user '$USERNAME'"
  [[ -n "$SUB" ]] || fail "no sub found for Cognito user '$USERNAME'"
  ok "Cognito sub: $SUB (used as the profile AccountNumber → web-call lookup key)"
fi

# --- Create (or update) the matching Customer Profile -----------------------
ATTRS="$(jq -nc --arg cn "$CUSTOMER_NUMBER" '{customerNumber: $cn}')"

# When we have a Cognito sub (web-call), AccountNumber = sub and the profile is
# found via _account lookup. When there's no Cognito (phone-only), AccountNumber
# = customer_number and the profile is found via _phone lookup (ANI match).
if [[ -n "$SUB" ]]; then
  ACCOUNT_NUMBER="$SUB"
  SEARCH_KEY="_account"
  SEARCH_VALUE="$SUB"
else
  ACCOUNT_NUMBER="$CUSTOMER_NUMBER"
  SEARCH_KEY="_phone"
  SEARCH_VALUE="$PHONE"
fi

EXISTING="$(aws customer-profiles search-profiles --domain-name "$DOMAIN" --region "$REGION" \
  --key-name "$SEARCH_KEY" --values "$SEARCH_VALUE" --query 'Items[0].ProfileId' --output text 2>/dev/null || true)"

COMMON_ARGS=(--domain-name "$DOMAIN" --region "$REGION"
  --account-number "$ACCOUNT_NUMBER" --first-name "$FIRST" --last-name "$LAST"
  --party-type INDIVIDUAL --phone-number "$PHONE" --email-address "$EMAIL"
  --attributes "$ATTRS")

if [[ -n "$EXISTING" && "$EXISTING" != "None" ]]; then
  info "Profile for '$SEARCH_KEY=$SEARCH_VALUE' exists ($EXISTING) — updating"
  aws customer-profiles update-profile --profile-id "$EXISTING" "${COMMON_ARGS[@]}" >/dev/null \
    || fail "update-profile failed"
  ok "Updated profile $EXISTING"
else
  info "Creating profile (account=$ACCOUNT_NUMBER) in domain '$DOMAIN'"
  PID="$(aws customer-profiles create-profile "${COMMON_ARGS[@]}" --query 'ProfileId' --output text)" \
    || fail "create-profile failed"
  ok "Created profile $PID"
fi

CLOUDFRONT_URL="$(jq -r 'to_entries[] | select(.key | endswith("-WebcallWidget")) | .value.CloudFrontUrl // empty' "$OUTPUTS" | head -n1)"

echo ""
echo "=========================================="
echo "Test user ready"
echo "=========================================="
[[ -n "$CLOUDFRONT_URL" ]] && echo "Sign in at:      $CLOUDFRONT_URL"
echo "Username:        $USERNAME"
echo "Email:           $EMAIL"
echo "Phone:           $PHONE"
echo "Customer number: $CUSTOMER_NUMBER"
[[ -n "$SUB" ]] && echo "Cognito sub:     $SUB"
echo ""
if [[ "$HAS_WEBCALL" == "true" ]]; then
  echo -e "${YELLOW}→ Temporary password was emailed to $EMAIL (not shown here). The user must set a new password on first sign-in.${NC}"
  echo -e "${GREEN}✓ Done.${NC} Sign in and call — the agent will greet $FIRST with this profile's context."
else
  echo -e "${YELLOW}→ No web-call frontend — call from $PHONE to reach the agent (profile resolves by ANI).${NC}"
  echo -e "${GREEN}✓ Done.${NC} Customer Profile created — the agent will greet $FIRST with this profile's context."
fi
