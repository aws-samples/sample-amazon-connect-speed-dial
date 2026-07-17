#!/usr/bin/env bash
set -euo pipefail

# Usage: test-render-and-synth.sh <transferEnabled> <toolEnabled> [contextInjectionEnabled] [recordingEnabled] [encryptionEnabled] [customerProfilesEnabled]  (booleans)
TRANSFER="${1:-false}"
TOOL="${2:-false}"
CONTEXT="${3:-false}"
RECORDING="${4:-false}"
ENCRYPTION="${5:-true}"
PROFILES="${6:-true}"
LABEL="t${TRANSFER}-x${TOOL}-c${CONTEXT}-r${RECORDING}-e${ENCRYPTION}-p${PROFILES}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/templates/cdk-app"
DEST="$ROOT/tests/.rendered/$LABEL"
VALUES="$ROOT/tests/fixtures/sample-values.json"

rm -rf "$DEST"; mkdir -p "$DEST"

TMP_VALUES="$(mktemp)"
trap 'rm -f "$TMP_VALUES"' EXIT
jq --argjson t "$TRANSFER" --argjson x "$TOOL" --argjson c "$CONTEXT" --argjson r "$RECORDING" --argjson e "$ENCRYPTION" --argjson p "$PROFILES" \
  '.transferEnabled=$t | .toolEnabled=$x | .contextInjectionEnabled=$c | .recordingEnabled=$r | .encryptionEnabled=$e | .customerProfilesEnabled=$p' "$VALUES" > "$TMP_VALUES"

"$ROOT/scripts/render-templates.sh" "$TMP_VALUES" "$SRC" "$DEST"

cd "$DEST"
npm install --silent 2>&1 | tail -5
npx cdk synth --quiet 2>&1

TEMPLATE_PREFIX="$DEST/cdk.out/test-blueprint"

assert_resource_count() {
  local template="$1" type="$2" expected="$3"
  local actual
  actual=$(jq "[.Resources | to_entries[] | select(.value.Type == \"$type\")] | length" "$template")
  if [[ "$actual" -lt "$expected" ]]; then
    echo "FAIL: expected >=$expected $type in $(basename "$template"), got $actual" >&2; exit 1
  fi
}

assert_resource_count "$TEMPLATE_PREFIX-ConnectInstance.template.json" "AWS::Connect::Instance" 1
assert_resource_count "$TEMPLATE_PREFIX-Queues.template.json" "AWS::Connect::Queue" 1
assert_resource_count "$TEMPLATE_PREFIX-Wisdom.template.json" "AWS::Lex::Bot" 1
assert_resource_count "$TEMPLATE_PREFIX-Wisdom.template.json" "AWS::Wisdom::Assistant" 1
assert_resource_count "$TEMPLATE_PREFIX-Wisdom.template.json" "AWS::Wisdom::AIAgent" 2
assert_resource_count "$TEMPLATE_PREFIX-ContactFlow.template.json" "AWS::Connect::ContactFlow" 1
assert_resource_count "$TEMPLATE_PREFIX-PostDeploy.template.json" "Custom::AWS" 1

# Tool flavor → sample Lambda present in the ContactFlow stack.
if [[ "$TOOL" == "true" ]]; then
  assert_resource_count "$TEMPLATE_PREFIX-ContactFlow.template.json" "AWS::Lambda::Function" 1
fi

# AgentCore gateway is always registered with the instance as an MCP server:
# an AppIntegrations MCP_SERVER application + a Connect APPLICATION association.
assert_resource_count "$TEMPLATE_PREFIX-AgentCoreGateway.template.json" "AWS::AppIntegrations::Application" 1
assert_resource_count "$TEMPLATE_PREFIX-AgentCoreGateway.template.json" "AWS::Connect::IntegrationAssociation" 1
GW_APP_TYPE=$(jq -r '.Resources | to_entries[] | select(.value.Type=="AWS::AppIntegrations::Application") | .value.Properties.ApplicationType' "$TEMPLATE_PREFIX-AgentCoreGateway.template.json")
[[ "$GW_APP_TYPE" == "MCP_SERVER" ]] || { echo "FAIL: MCP application type is '$GW_APP_TYPE', expected MCP_SERVER" >&2; exit 1; }

# Tool flavor → the orchestration agent allow-lists the gateway's MCP tools by
# their namespace-qualified id (`gateway_<gatewayId>__<target>___<tool>`), and
# the AI-agent security profile grants the same tools (type MCP).
ORCH_TOOLS=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Wisdom::AIAgent") | .value.Properties.Configuration.OrchestrationAIAgentConfiguration.ToolConfigurations[]? | select(.ToolId != null) | (.ToolId | tostring)] | join(",")' "$TEMPLATE_PREFIX-Wisdom.template.json")
SP_APPS=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Connect::SecurityProfile") | .value.Properties.Applications[]? | .Type] | join(",")' "$TEMPLATE_PREFIX-Wisdom.template.json")
if [[ "$TOOL" == "true" ]]; then
  echo "$ORCH_TOOLS" | grep -q "gateway_.*__SapOrderLookup___get_order_status" || { echo "FAIL: tool enabled but gateway MCP tool not allow-listed on agent with namespace-qualified id (got: $ORCH_TOOLS)" >&2; exit 1; }
  echo "$SP_APPS" | grep -q "MCP" || { echo "FAIL: tool enabled but AI-agent security profile has no MCP application grant (got: $SP_APPS)" >&2; exit 1; }
else
  if echo "$ORCH_TOOLS" | grep -q "SapOrderLookup___"; then echo "FAIL: tool disabled but gateway MCP tool present on agent" >&2; exit 1; fi
  if echo "$SP_APPS" | grep -q "MCP"; then echo "FAIL: tool disabled but MCP application grant present on security profile" >&2; exit 1; fi
fi

# Transfer flavor → the flow JSON contains a TransferContactToQueue action.
FLOW_CONTENT=$(jq -r '.Resources | to_entries[] | select(.value.Type=="AWS::Connect::ContactFlow") | .value.Properties.Content' "$TEMPLATE_PREFIX-ContactFlow.template.json")

# Default voice + language must reach the synthesized flow / Lex bot.
# (FLOW_CONTENT is JSON-within-JSON, so quotes arrive backslash-escaped;
# match tolerantly across the "<key>":"<value>" boundary.)
echo "$FLOW_CONTENT" | grep -qE 'TextToSpeechVoice.{0,6}Tiffany' || { echo "FAIL: default voice Tiffany missing from flow" >&2; exit 1; }
echo "$FLOW_CONTENT" | grep -qE 'languageCode.{0,6}en-US' || { echo "FAIL: default TTS languageCode en-US missing from flow metadata" >&2; exit 1; }
LEX_LOCALES=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lex::Bot") | .value.Properties.BotLocales[]?.LocaleId] | join(",")' "$TEMPLATE_PREFIX-Wisdom.template.json")

# Nova 2 Sonic speech-to-speech must be configured on the bot locale:
# UnifiedSpeechSettings with the region-scoped foundation-model ARN and the
# lowercase Sonic voice. This is the bot-level half of the S2S configuration;
# the flow's Generative Set-voice block is the other half.
LEX_USS=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lex::Bot") | .value.Properties.BotLocales[]?.UnifiedSpeechSettings.SpeechFoundationModel] | first' "$TEMPLATE_PREFIX-Wisdom.template.json")
echo "$LEX_USS" | grep -q "foundation-model/amazon.nova-2-sonic-v1:0" || { echo "FAIL: Nova 2 Sonic model ARN missing from bot locale UnifiedSpeechSettings (got: $LEX_USS)" >&2; exit 1; }
echo "$LEX_USS" | grep -q '"VoiceId": "tiffany"' || { echo "FAIL: Sonic voiceId tiffany missing from bot locale UnifiedSpeechSettings (got: $LEX_USS)" >&2; exit 1; }

echo "$LEX_LOCALES" | grep -q "en_US" || { echo "FAIL: default Lex locale en_US missing (got: $LEX_LOCALES)" >&2; exit 1; }

if [[ "$TRANSFER" == "true" ]]; then
  echo "$FLOW_CONTENT" | grep -q "TransferContactToQueue" || { echo "FAIL: transfer enabled but no TransferContactToQueue in flow" >&2; exit 1; }
else
  if echo "$FLOW_CONTENT" | grep -q "TransferContactToQueue"; then echo "FAIL: transfer disabled but TransferContactToQueue present" >&2; exit 1; fi
fi

# Recording consent gate: when recordingEnabled, a GetParticipantInput consent
# prompt is spliced in AFTER the voice/language preamble (set-language) so it is
# spoken in the configured TTS voice, branching to enable/disable recording
# (UpdateContactRecordingAndAnalyticsBehavior, IVR recording enabled on consent),
# both rejoining the action that originally followed set-language (set-queue);
# the prompt's company name is resolved from {{companyName}}. The flow still
# starts at enable-logs. When off, none of those actions appear.
echo "$FLOW_CONTENT" | RECORDING="$RECORDING" python3 -c "
import sys,os,json
c=json.loads(sys.stdin.read())
if isinstance(c,dict) and 'Fn::Join' in c:
    c=''.join(p if isinstance(p,str) else '__ARN__' for p in c['Fn::Join'][1])
f=json.loads(c) if isinstance(c,str) else c
A={a['Identifier']:a for a in f['Actions']}
on=os.environ['RECORDING']=='true'
if on:
    # Gate is spoken after the voice/language preamble, not at the very start.
    assert f['StartAction']=='enable-logs', 'StartAction should remain enable-logs, is '+f['StartAction']
    assert A['set-language']['Transitions']['NextAction']=='recording-consent', 'set-language must flow into the consent gate'
    assert A['recording-consent']['Type']=='GetParticipantInput', 'consent block wrong type'
    assert A['enable-recording']['Parameters']['VoiceBehavior']['VoiceRecordingBehavior']['IVRRecordingBehavior']=='Enabled', 'IVR recording not enabled on consent path'
    conds={tuple(c['Condition']['Operands']):c['NextAction'] for c in A['recording-consent']['Transitions']['Conditions']}
    assert conds.get(('1',))=='enable-recording', 'press-1 does not enable recording'
    # Both branches rejoin the action that originally followed set-language.
    assert A['enable-recording']['Transitions']['NextAction']=='set-queue', 'enable-recording must rejoin set-queue'
    assert A['disable-recording']['Transitions']['NextAction']=='set-queue', 'disable-recording must rejoin set-queue'
    assert 'Test Co' in A['recording-consent']['Parameters']['Text'], 'company name not resolved in consent prompt'
else:
    assert f['StartAction']=='enable-logs', 'StartAction should be enable-logs when recording off, is '+f['StartAction']
    assert 'recording-consent' not in A, 'recording disabled but consent block present'
    assert 'enable-recording' not in A, 'recording disabled but enable-recording present'
    assert A['set-language']['Transitions']['NextAction']=='set-queue', 'set-language should flow to set-queue when recording off'
" || { echo "FAIL: recording consent gate not wired correctly (recording=$RECORDING)" >&2; exit 1; }

# Agent prompts: rendered as files with {{companyName}} substituted and the
# Q Connect runtime variables left intact, and the text reaches the synthesized
# AWS::Wisdom::AIPrompt resources.
ORCH_PROMPT="$DEST/prompts/orchestration.md"
SELF_PROMPT="$DEST/prompts/self-service.md"
[[ -f "$ORCH_PROMPT" && -f "$SELF_PROMPT" ]] || { echo "FAIL: rendered prompt files missing" >&2; exit 1; }
grep -q "Test Co" "$ORCH_PROMPT" || { echo "FAIL: {{companyName}} not substituted in orchestration prompt" >&2; exit 1; }
grep -qF '{{$.conversationHistory}}' "$ORCH_PROMPT" || { echo "FAIL: orchestration runtime var clobbered" >&2; exit 1; }
grep -qF '{{$.contentExcerpt}}' "$SELF_PROMPT" || { echo "FAIL: self-service runtime var clobbered" >&2; exit 1; }

PROMPT_TEXT=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Wisdom::AIPrompt") | .value.Properties.TemplateConfiguration.TextFullAIPromptEditTemplateConfiguration.Text] | join("\n")' "$TEMPLATE_PREFIX-Wisdom.template.json")
echo "$PROMPT_TEXT" | grep -q "Test Co" || { echo "FAIL: synthesized AIPrompt text missing rendered company name" >&2; exit 1; }

# Context injection → the flow invokes provide-agent-context, the FlowLambdas
# stack deploys the UpdateSessionContext Lambda, and the orchestration prompt
# gains the context-usage snippet. When off, none of these appear (and the
# snippet fragment never ships in the rendered prompts dir).
LAMBDA_LOGICAL_IDS=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function") | .key] | join(",")' "$TEMPLATE_PREFIX-FlowLambdas.template.json")
[[ -f "$DEST/prompts/context-injection.snippet.md" ]] && { echo "FAIL: snippet fragment should not ship in rendered project" >&2; exit 1; }
if [[ "$CONTEXT" == "true" ]]; then
  echo "$FLOW_CONTENT" | grep -q "provide-agent-context" || { echo "FAIL: context injection enabled but provide-agent-context not in flow" >&2; exit 1; }
  echo "$LAMBDA_LOGICAL_IDS" | grep -qi "UpdateSessionContext" || { echo "FAIL: context injection enabled but UpdateSessionContext Lambda not deployed" >&2; exit 1; }
  # The AI Agent compound block (create-wisdom-session -> update-contact-data ->
  # connect-lex-bot) must stay intact, or the Connect console drops the "Enable
  # AI Agent" recognition. Precall Lambdas run BEFORE it, never spliced between
  # its children. provide-agent-context must reach the compound (possibly via
  # another precall Lambda, e.g. provide-profile-context).
  # Content may be a plain JSON string or a CFN Fn::Join (tool path injects an
  # ARN ref). Read the raw property and normalize either form to flow JSON.
  jq -r '.Resources | to_entries[] | select(.value.Type=="AWS::Connect::ContactFlow") | .value.Properties.Content' "$TEMPLATE_PREFIX-ContactFlow.template.json" | PROFILES="$PROFILES" python3 -c "
import sys,json
raw=sys.stdin.read().strip()
c=json.loads(raw)
if isinstance(c,dict) and 'Fn::Join' in c:
    c=''.join(p if isinstance(p,str) else '__ARN__' for p in c['Fn::Join'][1])
f=json.loads(c) if isinstance(c,str) else c
import os
profiles_on=os.environ.get('PROFILES')=='true'
nxt={a['Identifier']:a['Transitions'].get('NextAction') for a in f['Actions']}
assert nxt.get('create-wisdom-session')=='update-contact-data', 'compound split: create-wisdom-session -> '+str(nxt.get('create-wisdom-session'))
assert nxt.get('update-contact-data')=='connect-lex-bot', 'compound split: update-contact-data -> '+str(nxt.get('update-contact-data'))
# Precall run order: context injection (baseline) runs BEFORE Customer Profiles
# (per-user override). When both on: context -> profile -> compound, so context's
# next is the profile lambda and profile's next is the compound. When profiles
# off, context's next is the compound directly.
if profiles_on:
    assert nxt.get('provide-agent-context')=='provide-profile-context', 'expected context before profile: provide-agent-context -> '+str(nxt.get('provide-agent-context'))
    assert nxt.get('provide-profile-context')=='create-wisdom-session', 'profile lambda not last-before-compound: -> '+str(nxt.get('provide-profile-context'))
else:
    assert nxt.get('provide-agent-context')=='create-wisdom-session', 'context lambda not last-before-compound: -> '+str(nxt.get('provide-agent-context'))
" || { echo "FAIL: AI Agent compound block not intact / precall order wrong" >&2; exit 1; }
else
  if echo "$FLOW_CONTENT" | grep -q "provide-agent-context"; then echo "FAIL: context injection disabled but provide-agent-context present in flow" >&2; exit 1; fi
  if echo "$LAMBDA_LOGICAL_IDS" | grep -qi "UpdateSessionContext"; then echo "FAIL: context injection disabled but UpdateSessionContext Lambda deployed" >&2; exit 1; fi
fi

# The shared {{$.Custom.*}} prompt snippet is appended when EITHER context
# injection or customer profiles is on (both populate the same session keys),
# and exactly once. When both are off, it must be absent.
if [[ "$CONTEXT" == "true" || "$PROFILES" == "true" ]]; then
  [[ "$(grep -c "may already be identified" "$ORCH_PROMPT")" == "1" ]] || { echo "FAIL: context/profile snippet should appear exactly once (context=$CONTEXT profiles=$PROFILES)" >&2; exit 1; }
else
  if grep -q "may already be identified" "$ORCH_PROMPT"; then echo "FAIL: snippet appended but context and profiles both off" >&2; exit 1; fi
fi

# Storage encryption: when on, a customer-managed KMS key exists, the storage
# bucket uses aws:kms, and all three storage configs carry EncryptionConfig
# (EncryptionType KMS). When off, no KMS key and no EncryptionConfig.
CI_TEMPLATE="$TEMPLATE_PREFIX-ConnectInstance.template.json"
ENCRYPTION="$ENCRYPTION" python3 - "$CI_TEMPLATE" <<'PY' || { echo "FAIL: storage encryption not wired correctly (encryption=$ENCRYPTION)" >&2; exit 1; }
import json,os,sys
R=json.load(open(sys.argv[1]))['Resources']
on=os.environ['ENCRYPTION']=='true'
kms=[k for k,v in R.items() if v['Type']=='AWS::KMS::Key']
configs=[v for v in R.values() if v['Type']=='AWS::Connect::InstanceStorageConfig']
bucket=next(v for v in R.values() if v['Type']=='AWS::S3::Bucket')
algo=bucket['Properties'].get('BucketEncryption',{}).get('ServerSideEncryptionConfiguration',[{}])[0].get('ServerSideEncryptionByDefault',{})
if on:
    assert kms, 'encryption on but no KMS key'
    assert algo.get('SSEAlgorithm')=='aws:kms', 'bucket not aws:kms: '+str(algo)
    for c in configs:
        ec=c['Properties']['S3Config'].get('EncryptionConfig')
        assert ec and ec.get('EncryptionType')=='KMS', 'storage config missing KMS EncryptionConfig: '+c['Properties'].get('ResourceType','?')
else:
    assert not kms, 'encryption off but KMS key present'
    assert algo.get('SSEAlgorithm')=='AES256', 'bucket should be SSE-S3 when off: '+str(algo)
    for c in configs:
        assert 'EncryptionConfig' not in c['Properties']['S3Config'], 'encryption off but storage config has EncryptionConfig'
PY

# Customer Profiles: when on, the flow invokes provide-profile-context (before
# the AI Agent compound), the ProfileLookup Lambda is deployed, and a demo
# profile is seeded (CreateProfile custom resource). When off, none present.
PROFILE_LAMBDAS=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function") | .key] | join(",")' "$TEMPLATE_PREFIX-FlowLambdas.template.json")
if [[ "$PROFILES" == "true" ]]; then
  echo "$FLOW_CONTENT" | grep -q "provide-profile-context" || { echo "FAIL: customer profiles on but provide-profile-context not in flow" >&2; exit 1; }
  echo "$PROFILE_LAMBDAS" | grep -qi "ProfileLookup" || { echo "FAIL: customer profiles on but ProfileLookup Lambda not deployed" >&2; exit 1; }
  # The compound block must remain intact even with the extra precall Lambda.
  echo "$FLOW_CONTENT" | python3 -c "
import sys,json
c=json.loads(sys.stdin.read())
if isinstance(c,dict) and 'Fn::Join' in c:
    c=''.join(p if isinstance(p,str) else '__ARN__' for p in c['Fn::Join'][1])
f=json.loads(c) if isinstance(c,str) else c
nxt={a['Identifier']:a['Transitions'].get('NextAction') for a in f['Actions']}
assert nxt.get('create-wisdom-session')=='update-contact-data' and nxt.get('update-contact-data')=='connect-lex-bot', 'compound split by profile lookup'
" || { echo "FAIL: profile lookup split the AI Agent compound" >&2; exit 1; }
else
  if echo "$FLOW_CONTENT" | grep -q "provide-profile-context"; then echo "FAIL: customer profiles off but provide-profile-context present" >&2; exit 1; fi
  if echo "$PROFILE_LAMBDAS" | grep -qi "ProfileLookup"; then echo "FAIL: customer profiles off but ProfileLookup Lambda deployed" >&2; exit 1; fi
fi

echo "PASS: render-and-synth transfer=$TRANSFER tool=$TOOL context=$CONTEXT recording=$RECORDING encryption=$ENCRYPTION profiles=$PROFILES"
