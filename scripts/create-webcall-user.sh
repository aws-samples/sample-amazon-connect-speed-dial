#!/usr/bin/env bash
set -euo pipefail

# create-webcall-user.sh — create a Cognito login for the web-call frontend so a
# user can sign in at the CloudFront site without touching the AWS console.
#
# The user pool has self-signup disabled, so logins must be admin-created. This
# script creates the user (email is a required attribute) and sets a PERMANENT
# password, so the user can sign in immediately — no forced password change.
#
# Idempotent: if the user already exists, the password is (re)set rather than
# failing.
#
# Usage:
#   create-webcall-user.sh <project-dir> <username> <email> [password]
#
# Args:
#   project-dir   rendered project directory (contains cdk-outputs.json)
#   username      the login username
#   email         the user's email (required by the pool's standard attributes)
#   password      optional; if omitted, a compliant password is generated and printed
#
# Password policy (from the stack): >=8 chars, lower + upper + digit + symbol.

REGION="${5:-us-east-1}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
info() { echo "→ $1"; }
fail() { echo -e "${RED}✗ $1${NC}" >&2; exit 1; }

PROJECT_DIR="${1:?usage: create-webcall-user.sh <project-dir> <username> <email> [password]}"
USERNAME="${2:?usage: create-webcall-user.sh <project-dir> <username> <email> [password]}"
EMAIL="${3:?usage: create-webcall-user.sh <project-dir> <username> <email> [password]}"
PASSWORD="${4:-}"

OUTPUTS="$PROJECT_DIR/cdk-outputs.json"
[[ -f "$OUTPUTS" ]] || fail "cdk-outputs.json not found at $OUTPUTS (deploy the project first)"

# --- Resolve the User Pool ID from the deploy outputs ----------------------
USER_POOL_ID="$(jq -r 'to_entries[] | select(.key | endswith("-WebcallWidget")) | .value.UserPoolId // empty' "$OUTPUTS" | head -n1)"
[[ -n "$USER_POOL_ID" ]] || fail "could not find UserPoolId in $OUTPUTS — is the WebcallWidget stack deployed?"
info "User pool: $USER_POOL_ID"

# --- Generate a compliant password if none was supplied --------------------
GENERATED=0
if [[ -z "$PASSWORD" ]]; then
  # Random alphanumeric core (upper+lower+digit) plus a guaranteed
  # upper/lower/digit/symbol suffix so the policy is always satisfied.
  # Read a fixed chunk and filter (no head-closes-pipe SIGPIPE under pipefail).
  RAND="$(LC_ALL=C tr -dc 'A-Za-z0-9' < <(dd if=/dev/urandom bs=1 count=64 2>/dev/null))"
  PASSWORD="${RAND:0:22}aA1!"
  GENERATED=1
fi

# --- Create the user (idempotent) ------------------------------------------
# SUPPRESS: don't send a Cognito invite email (the address may not be real).
if aws cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$USERNAME" --region "$REGION" >/dev/null 2>&1; then
  info "User '$USERNAME' already exists — updating password"
else
  info "Creating user '$USERNAME'..."
  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$USERNAME" \
    --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
    --message-action SUPPRESS \
    --region "$REGION" >/dev/null \
    || fail "admin-create-user failed"
fi

# --- Set a permanent password so the user can sign in immediately ----------
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$USERNAME" \
  --password "$PASSWORD" \
  --permanent \
  --region "$REGION" >/dev/null \
  || fail "admin-set-user-password failed (does the password meet the policy: >=8 chars, upper+lower+digit+symbol?)"
ok "User '$USERNAME' is ready to sign in"

CLOUDFRONT_URL="$(jq -r 'to_entries[] | select(.key | endswith("-WebcallWidget")) | .value.CloudFrontUrl // empty' "$OUTPUTS" | head -n1)"

echo ""
echo "=========================================="
echo "Web-call login created"
echo "=========================================="
[[ -n "$CLOUDFRONT_URL" ]] && echo "Sign in at:  $CLOUDFRONT_URL"
echo "Username:    $USERNAME"
if [[ "$GENERATED" -eq 1 ]]; then
  echo "Password:    $PASSWORD"
  echo -e "${YELLOW}(Generated password — save it now; it is not stored anywhere.)${NC}"
else
  echo "Password:    (the one you provided)"
fi
echo ""
echo -e "${GREEN}✓ Done.${NC} Open the site, sign in, and click to call your AI agent."
