#!/usr/bin/env bash
set -euo pipefail

REGION="${3:-us-east-1}"

# Usage check
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <instance-id> <contact-flow-id> [region]" >&2
  exit 1
fi

INSTANCE_ID="$1"
CONTACT_FLOW_ID="$2"

# Construct instance ARN
ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region "$REGION")
INSTANCE_ARN="arn:aws:connect:${REGION}:${ACCOUNT}:instance/${INSTANCE_ID}"

echo "→ Checking for existing UK DID on the instance..."

# Idempotency: if a UK DID is already claimed on this instance, reuse it.
# A phone number's TargetArn is always the *instance* ARN (never a contact-flow
# ARN), so we match on a GB DID claimed against this instance rather than on the
# flow binding, which these summaries do not expose.
EXISTING_NUMBER=$(aws connect list-phone-numbers-v2 \
  --instance-id "$INSTANCE_ID" \
  --region "$REGION" \
  --query "ListPhoneNumbersSummaryList[?PhoneNumberCountryCode=='GB'] | [0].{PhoneNumber: PhoneNumber, PhoneNumberId: PhoneNumberId}" \
  --output json 2>/dev/null || echo "{}")

if [[ $(echo "$EXISTING_NUMBER" | jq -r '.PhoneNumber // empty') ]]; then
  PHONE_NUMBER=$(echo "$EXISTING_NUMBER" | jq -r '.PhoneNumber')
  PHONE_NUMBER_ID=$(echo "$EXISTING_NUMBER" | jq -r '.PhoneNumberId')
  echo "✓ UK DID already associated with flow:"
  echo "  PHONE_NUMBER=$PHONE_NUMBER"
  echo "  PHONE_NUMBER_ID=$PHONE_NUMBER_ID"
  exit 0
fi

echo "→ Searching for available UK DIDs..."

# Search for available UK DIDs
AVAILABLE=$(aws connect search-available-phone-numbers \
  --target-arn "$INSTANCE_ARN" \
  --phone-number-country-code GB \
  --phone-number-type DID \
  --max-results 5 \
  --region "$REGION" \
  --output json)

PHONE_NUMBER=$(echo "$AVAILABLE" | jq -r '.AvailableNumbersList[0].PhoneNumber // empty')

if [[ -z "$PHONE_NUMBER" ]]; then
  echo "✗ No UK DIDs available" >&2
  exit 1
fi

echo "→ Found available number: $PHONE_NUMBER"
echo "→ Claiming phone number..."

# Claim the phone number
CLAIM_RESULT=$(aws connect claim-phone-number \
  --target-arn "$INSTANCE_ARN" \
  --phone-number "$PHONE_NUMBER" \
  --region "$REGION" \
  --output json)

PHONE_NUMBER_ID=$(echo "$CLAIM_RESULT" | jq -r '.PhoneNumberId')

if [[ -z "$PHONE_NUMBER_ID" ]]; then
  echo "✗ Failed to claim phone number" >&2
  exit 1
fi

echo "✓ Claimed phone number (ID: $PHONE_NUMBER_ID)"
echo "→ Associating phone number with contact flow..."

# Associate phone number with contact flow
aws connect associate-phone-number-contact-flow \
  --phone-number-id "$PHONE_NUMBER_ID" \
  --instance-id "$INSTANCE_ID" \
  --contact-flow-id "$CONTACT_FLOW_ID" \
  --region "$REGION" >/dev/null

echo "✓ Phone number associated with contact flow"
echo ""
echo "PHONE_NUMBER=$PHONE_NUMBER"
echo "PHONE_NUMBER_ID=$PHONE_NUMBER_ID"
exit 0
