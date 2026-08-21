#!/usr/bin/env bash
set -euo pipefail

# test-capability-flags.sh — synth coverage for the optional flags that no other
# suite exercises.
#
# test-render-and-synth.sh covers the default shape (and customerProfilesEnabled
# on/off); test-region-language.sh covers region × language × voice. That left
# three order-file flags with NO automated coverage at all — every one of them
# adds or removes real infrastructure, and one (identityCenterEnabled) is fixed
# irreversibly at instance creation:
#
#   contactEventsEnabled  → the conditional ContactEvents stack (EventBridge)
#   dataLakeEnabled       → the Connect analytics data-lake association
#   retainData            → DeletionPolicy on every data-bearing resource
#   identityCenterEnabled → SAML instance + IAM SAML provider (+ its hard fail
#                           when saml-metadata.xml is missing)
#
# Two synths, so this is slow (a few minutes) and local-only — CI cannot run it
# because `cdk synth` needs a container runtime for asset bundling. Run it
# before merging template changes.
#
# Usage: tests/test-capability-flags.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CSP=(npm --silent --prefix "$ROOT/cli" run csp --)

# shellcheck source=tests/lib/container-runtime.sh
source "$ROOT/tests/lib/container-runtime.sh"
require_container_runtime

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "  ok: $1"; }

# jq helper: does any resource of the given type carry this DeletionPolicy?
policy_of() {  # <template> <logical-id-fragment>
  jq -r --arg frag "$2" '
    .Resources | to_entries
    | map(select(.key | contains($frag)))
    | .[0].value.DeletionPolicy // "(none)"' "$1"
}

# --- case 1: contactEvents + dataLake + knowledgeBase on, retainData off ------
echo "== case 1: contactEvents/dataLake/kb on, retainData off (de/masculine) =="
cat > "$WORK/order-flags.json" <<'JSON'
{
  "projectName": "flagtest",
  "companyName": "Flag Test Co",
  "region": "us-east-1",
  "language": "de",
  "voiceGender": "masculine",
  "contactEventsEnabled": true,
  "dataLakeEnabled": true,
  "knowledgeBaseEnabled": true,
  "retainData": false
}
JSON

"${CSP[@]}" values "$WORK/order-flags.json" "$WORK/values-flags.json" >/dev/null
"${CSP[@]}" render "$WORK/values-flags.json" "$ROOT/templates/cdk-app" "$WORK/proj-flags" >/dev/null
( cd "$WORK/proj-flags" && "${CSP[@]}" synth . us-east-1 ) > "$WORK/synth-flags.log" 2>&1 \
  || { tail -30 "$WORK/synth-flags.log" >&2; fail "synth failed for the flags-on case"; }

OUT="$WORK/proj-flags/cdk.out"

# contactEventsEnabled → the conditional stack is synthesized with its rule.
[[ -f "$OUT/flagtest-ContactEvents.template.json" ]] \
  || fail "contactEventsEnabled=true but no ContactEvents template was synthesized"
RULES=$(jq '[.Resources[] | select(.Type == "AWS::Events::Rule")] | length' \
  "$OUT/flagtest-ContactEvents.template.json")
[[ "$RULES" -ge 1 ]] || fail "ContactEvents stack has no AWS::Events::Rule (got $RULES)"
pass "ContactEvents stack synthesized with an EventBridge rule"

# dataLakeEnabled → the analytics-data-set association is wired in.
grep -q "connect:BatchAssociateAnalyticsDataSet" "$OUT/flagtest-ConnectInstance.template.json" \
  || fail "dataLakeEnabled=true but no analytics data-set association in ConnectInstance"
pass "data-lake association present"

# knowledgeBaseEnabled → the Bedrock KB and its S3 Vectors index exist.
jq -e '[.Resources[] | select(.Type == "AWS::Bedrock::KnowledgeBase")] | length >= 1' \
  "$OUT/flagtest-Wisdom.template.json" >/dev/null \
  || fail "knowledgeBaseEnabled=true but no AWS::Bedrock::KnowledgeBase in Wisdom"
pass "Bedrock knowledge base present"

# retainData=false → nothing data-bearing survives a destroy.
for pair in \
  "flagtest-ConnectInstance:StorageBucket" \
  "flagtest-ConnectInstance:StorageKey" \
  "flagtest-ConnectInstance:Instance" \
  "flagtest-Wisdom:KnowledgeBaseBucket" \
  "flagtest-AgentCoreGateway:SapOrdersTable" ; do
  TPL="${pair%%:*}"; FRAG="${pair##*:}"
  GOT="$(policy_of "$OUT/$TPL.template.json" "$FRAG")"
  [[ "$GOT" == "Delete" ]] \
    || fail "retainData=false but $TPL/$FRAG has DeletionPolicy=$GOT (want Delete)"
done
pass "retainData=false → DeletionPolicy=Delete on all data-bearing resources"

# The language/voice pair reached the derived values (guards the de/masculine mix
# that case 1 renders with).
jq -e '.lexLocaleId == "de_DE" and .voiceGender == "masculine"' "$WORK/values-flags.json" >/dev/null \
  || fail "derived values lost the de/masculine selection"
pass "de/masculine survived into the values file"

# --- case 2: identityCenterEnabled ------------------------------------------
echo "== case 2: identityCenterEnabled (SAML) =="
cat > "$WORK/order-sso.json" <<'JSON'
{
  "projectName": "ssotest",
  "companyName": "SSO Test Co",
  "region": "us-east-1",
  "identityCenterEnabled": true
}
JSON

"${CSP[@]}" values "$WORK/order-sso.json" "$WORK/values-sso.json" >/dev/null

# 2a. Missing saml-metadata.xml must fail with the actionable message, not a
#     CloudFormation-level surprise later.
"${CSP[@]}" render "$WORK/values-sso.json" "$ROOT/templates/cdk-app" "$WORK/proj-sso-nometa" >/dev/null
if ( cd "$WORK/proj-sso-nometa" && "${CSP[@]}" synth . us-east-1 ) > "$WORK/synth-nometa.log" 2>&1; then
  fail "identityCenterEnabled=true synthesized WITHOUT saml-metadata.xml (expected a hard failure)"
fi
grep -q "saml-metadata.xml is missing" "$WORK/synth-nometa.log" \
  || { tail -20 "$WORK/synth-nometa.log" >&2; fail "missing-metadata failure did not name saml-metadata.xml"; }
pass "missing saml-metadata.xml fails synth with the actionable message"

# 2b. With metadata present, the instance is SAML and the provider is created.
#     Minimal but structurally valid SAML metadata — the stack only reads the
#     file contents into the IAM SAML provider.
cat > "$WORK/saml-metadata.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://example.test/sso">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
                         Location="https://example.test/sso/login"/>
  </IDPSSODescriptor>
</EntityDescriptor>
XML
# render copies saml-metadata.xml from the values file's parent dir (the working
# dir) into the project — mirror how a real deployment supplies it.
"${CSP[@]}" render "$WORK/values-sso.json" "$ROOT/templates/cdk-app" "$WORK/proj-sso" >/dev/null
[[ -f "$WORK/proj-sso/saml-metadata.xml" ]] \
  || fail "render did not copy saml-metadata.xml into the project dir"
( cd "$WORK/proj-sso" && "${CSP[@]}" synth . us-east-1 ) > "$WORK/synth-sso.log" 2>&1 \
  || { tail -30 "$WORK/synth-sso.log" >&2; fail "synth failed for the identity-center case"; }

SSO_TPL="$WORK/proj-sso/cdk.out/ssotest-ConnectInstance.template.json"
jq -e '[.Resources[] | select(.Type == "AWS::Connect::Instance")
        | select(.Properties.IdentityManagementType == "SAML")] | length >= 1' "$SSO_TPL" >/dev/null \
  || fail "identityCenterEnabled=true but the instance is not IdentityManagementType SAML"
pass "instance synthesized with IdentityManagementType=SAML"

jq -e '[.Resources[] | select(.Type == "AWS::IAM::SAMLProvider")] | length >= 1' "$SSO_TPL" >/dev/null \
  || fail "no AWS::IAM::SAMLProvider in the identity-center instance stack"
pass "IAM SAML provider created"

echo "PASS: capability flags (contactEvents, dataLake, retainData, identityCenter)"
