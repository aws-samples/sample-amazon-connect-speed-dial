#!/usr/bin/env bash
set -euo pipefail

# Usage: test-render-and-synth.sh [customerProfilesEnabled]  (boolean)
# Human transfer, tool calling, call recording, and storage encryption are
# ALWAYS on (built into the default flow / stacks) — no parameters for them.
PROFILES="${1:-true}"
LABEL="p${PROFILES}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/templates/cdk-app"
DEST="$ROOT/tests/.rendered/$LABEL"
VALUES="$ROOT/tests/fixtures/sample-values.json"

rm -rf "$DEST"; mkdir -p "$DEST"

TMP_VALUES="$(mktemp)"
trap 'rm -f "$TMP_VALUES"' EXIT
jq --argjson p "$PROFILES" '.customerProfilesEnabled=$p' "$VALUES" > "$TMP_VALUES"

"$ROOT/scripts/render-templates.sh" "$TMP_VALUES" "$SRC" "$DEST"

# Container runtime for CDK asset bundling (the boto3 Lambda layer is built in a
# container). Without one, `cdk synth` dies with a bare "spawnSync docker ENOENT"
# inside a LayerVersion stack trace, which reads like a blueprint defect but is
# purely a missing local dependency. Mirror deploy.py's resolution order —
# explicit CDK_DOCKER, then docker, then Finch — and say so plainly if neither
# is available, instead of failing 200 lines later for the wrong reason.
if [[ -z "${CDK_DOCKER:-}" ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    : # docker daemon is up; CDK's default works
  elif command -v finch >/dev/null 2>&1; then
    if [[ "$(finch vm status 2>/dev/null)" != "Running" ]]; then
      echo "SKIP: Finch VM is not running — start it with 'finch vm start' (or 'finch vm init'), or start Docker Desktop" >&2
      exit 0
    fi
    export CDK_DOCKER="$(command -v finch)"
    echo "using Finch as the container runtime (CDK_DOCKER=$CDK_DOCKER)"
  else
    echo "SKIP: no container runtime for CDK asset bundling — start Docker Desktop or install Finch (brew install finch)" >&2
    exit 0
  fi
fi

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

# Tool calling is always on → sample Lambda present in the ContactFlow stack.
assert_resource_count "$TEMPLATE_PREFIX-ContactFlow.template.json" "AWS::Lambda::Function" 1

# AgentCore gateway is always registered with the instance as an MCP server:
# an AppIntegrations MCP_SERVER application + a Connect APPLICATION association.
assert_resource_count "$TEMPLATE_PREFIX-AgentCoreGateway.template.json" "AWS::AppIntegrations::Application" 1
assert_resource_count "$TEMPLATE_PREFIX-AgentCoreGateway.template.json" "AWS::Connect::IntegrationAssociation" 1
GW_APP_TYPE=$(jq -r '.Resources | to_entries[] | select(.value.Type=="AWS::AppIntegrations::Application") | .value.Properties.ApplicationType' "$TEMPLATE_PREFIX-AgentCoreGateway.template.json")
[[ "$GW_APP_TYPE" == "MCP_SERVER" ]] || { echo "FAIL: MCP application type is '$GW_APP_TYPE', expected MCP_SERVER" >&2; exit 1; }

# The orchestration agent always allow-lists the gateway's MCP tools by their
# namespace-qualified id (`gateway_<gatewayId>__<target>___<tool>`), and the
# AI-agent security profile grants the same tools (type MCP).
ORCH_TOOLS=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Wisdom::AIAgent") | .value.Properties.Configuration.OrchestrationAIAgentConfiguration.ToolConfigurations[]? | select(.ToolId != null) | (.ToolId | tostring)] | join(",")' "$TEMPLATE_PREFIX-Wisdom.template.json")
SP_APPS=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Connect::SecurityProfile") | .value.Properties.Applications[]? | .Type] | join(",")' "$TEMPLATE_PREFIX-Wisdom.template.json")
echo "$ORCH_TOOLS" | grep -q "gateway_.*__SapOrderLookup___get_order_status" || { echo "FAIL: gateway MCP tool not allow-listed on agent with namespace-qualified id (got: $ORCH_TOOLS)" >&2; exit 1; }
echo "$SP_APPS" | grep -q "MCP" || { echo "FAIL: AI-agent security profile has no MCP application grant (got: $SP_APPS)" >&2; exit 1; }

FLOW_CONTENT=$(jq -r '.Resources | to_entries[] | select(.value.Type=="AWS::Connect::ContactFlow") | .value.Properties.Content' "$TEMPLATE_PREFIX-ContactFlow.template.json")

# Voice and language are no longer static in the flow: the flow sets both
# dynamically from the prompts data table (per-profile). The rendered
# ttsLanguageCode instead becomes the data table's DefaultLanguage — assert it
# reached the synthesized template there.
SEED_DEFAULT_LANG=$(jq -r '.Resources | to_entries[] | select(.value.Type=="AWS::CloudFormation::CustomResource") | .value.Properties.DefaultLanguage // empty' "$TEMPLATE_PREFIX-ContactFlow.template.json" | head -1)
[[ "$SEED_DEFAULT_LANG" == "en-US" ]] || { echo "FAIL: rendered ttsLanguageCode en-US missing from prompt-texts seed DefaultLanguage (got: $SEED_DEFAULT_LANG)" >&2; exit 1; }
LEX_LOCALES=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lex::Bot") | .value.Properties.BotLocales[]?.LocaleId] | join(",")' "$TEMPLATE_PREFIX-Wisdom.template.json")

# Amazon Connect agentic voice, bot-level half: the locale must request the
# Advanced ASR model preference. The caller-facing voice is NOT set here — it
# comes from the flow's Set-voice block — and the old Nova Sonic
# UnifiedSpeechSettings must be absent, since its own VoiceId took priority
# during the bot session and would silently override the agentic voice.
LEX_ASR=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lex::Bot") | .value.Properties.BotLocales[]?.SpeechRecognitionSettings.SpeechModelPreference] | first' "$TEMPLATE_PREFIX-Wisdom.template.json")
[[ "$LEX_ASR" == "Advanced" ]] || { echo "FAIL: bot locale SpeechModelPreference is '$LEX_ASR', expected Advanced (agentic voice ASR)" >&2; exit 1; }
LEX_USS=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lex::Bot") | .value.Properties.BotLocales[]?.UnifiedSpeechSettings] | map(select(. != null)) | length' "$TEMPLATE_PREFIX-Wisdom.template.json")
[[ "$LEX_USS" == "0" ]] || { echo "FAIL: bot locale still carries Nova Sonic UnifiedSpeechSettings ($LEX_USS found) — it would override the agentic voice" >&2; exit 1; }

# Agentic voice, flow-level half: the Set-voice block's engine must be the
# agentic provider, and the voice must be an agentic-catalog id. Anything else
# (a Polly engine, or "Agentic") deploys fine and then fails at call time.
FLOW_TTS_ENGINE=$(echo "$FLOW_CONTENT" | grep -o 'connect:agentic' | head -1)
[[ "$FLOW_TTS_ENGINE" == "connect:agentic" ]] || { echo "FAIL: flow does not set TextToSpeechEngine connect:agentic" >&2; exit 1; }
echo "$FLOW_CONTENT" | grep -q '"generative"' && { echo "FAIL: flow still sets the Polly 'generative' engine" >&2; exit 1; }
# The seeded voice must be an uppercase agentic id for the deployed locale
# (en-US fixture -> KATIE), not a Polly voice name.
SEED_VOICE=$(jq -r '.Resources | to_entries[] | select(.value.Type=="AWS::CloudFormation::CustomResource") | .value.Properties.Records // empty' "$TEMPLATE_PREFIX-ContactFlow.template.json" | head -1 | python3 -c "
import json,sys
raw=sys.stdin.read().strip()
if not raw: print(''); raise SystemExit
rows=json.loads(raw)
print(next((r['voice'] for r in rows if r.get('language')=='en-US'), ''))
")
[[ "$SEED_VOICE" == "KATIE" ]] || { echo "FAIL: seeded en-US voice is '$SEED_VOICE', expected the agentic id KATIE" >&2; exit 1; }

echo "$LEX_LOCALES" | grep -q "en_US" || { echo "FAIL: default Lex locale en_US missing (got: $LEX_LOCALES)" >&2; exit 1; }

# Human transfer is always on → the flow contains a TransferContactToQueue action.
echo "$FLOW_CONTENT" | grep -q "TransferContactToQueue" || { echo "FAIL: no TransferContactToQueue in flow (transfer is always on)" >&2; exit 1; }

# Call recording is always on → the consent-analytics module carries the DTMF
# consent gate (GetParticipantInput) and the recording toggle actions.
CONSENT_MODULE=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Connect::ContactFlowModule") | .value.Properties.Content | tostring] | join("\n")' "$TEMPLATE_PREFIX-ContactFlow.template.json")
echo "$CONSENT_MODULE" | grep -q "GetParticipantInput" || { echo "FAIL: consent module has no GetParticipantInput gate (recording is always on)" >&2; exit 1; }
echo "$CONSENT_MODULE" | grep -q "UpdateContactRecordingAndAnalyticsBehavior" || { echo "FAIL: consent module has no recording toggle (recording is always on)" >&2; exit 1; }

# Agent prompts: rendered as files with {{companyName}} substituted and the
# Q Connect runtime variables left intact, and the text reaches the synthesized
# AWS::Wisdom::AIPrompt resources.
ORCH_PROMPT="$DEST/prompts/orchestration.md"
SELF_PROMPT="$DEST/prompts/self-service.md"
[[ -f "$ORCH_PROMPT" && -f "$SELF_PROMPT" ]] || { echo "FAIL: rendered prompt files missing" >&2; exit 1; }
grep -q "Test Co" "$ORCH_PROMPT" || { echo "FAIL: {{companyName}} not substituted in orchestration prompt" >&2; exit 1; }
grep -qF '{{$.conversationHistory}}' "$ORCH_PROMPT" || { echo "FAIL: orchestration runtime var clobbered" >&2; exit 1; }
grep -qF '{{$.contentExcerpt}}' "$SELF_PROMPT" || { echo "FAIL: self-service runtime var clobbered" >&2; exit 1; }
[[ -f "$DEST/prompts/context-injection.snippet.md" ]] && { echo "FAIL: snippet fragment should not ship in rendered project" >&2; exit 1; }

PROMPT_TEXT=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Wisdom::AIPrompt") | .value.Properties.TemplateConfiguration.TextFullAIPromptEditTemplateConfiguration.Text] | join("\n")' "$TEMPLATE_PREFIX-Wisdom.template.json")
echo "$PROMPT_TEXT" | grep -q "Test Co" || { echo "FAIL: synthesized AIPrompt text missing rendered company name" >&2; exit 1; }

# The {{$.Custom.*}} prompt snippet is appended (exactly once) when customer
# profiles is on — profiles populate those session keys. Absent when off.
if [[ "$PROFILES" == "true" ]]; then
  [[ "$(grep -c "may already be identified" "$ORCH_PROMPT")" == "1" ]] || { echo "FAIL: profile snippet should appear exactly once (profiles=$PROFILES)" >&2; exit 1; }
else
  if grep -q "may already be identified" "$ORCH_PROMPT"; then echo "FAIL: snippet appended but profiles off" >&2; exit 1; fi
fi

# Storage encryption is ALWAYS on: a customer-managed KMS key exists, the
# storage bucket uses aws:kms, and every storage config carries EncryptionConfig
# (EncryptionType KMS).
CI_TEMPLATE="$TEMPLATE_PREFIX-ConnectInstance.template.json"
python3 - "$CI_TEMPLATE" <<'PY' || { echo "FAIL: storage encryption not wired correctly (must always be on)" >&2; exit 1; }
import json,sys
R=json.load(open(sys.argv[1]))['Resources']
kms=[k for k,v in R.items() if v['Type']=='AWS::KMS::Key']
configs=[v for v in R.values() if v['Type']=='AWS::Connect::InstanceStorageConfig']
bucket=next(v for v in R.values() if v['Type']=='AWS::S3::Bucket')
algo=bucket['Properties'].get('BucketEncryption',{}).get('ServerSideEncryptionConfiguration',[{}])[0].get('ServerSideEncryptionByDefault',{})
assert kms, 'no KMS key — storage encryption must always be on'
assert algo.get('SSEAlgorithm')=='aws:kms', 'bucket not aws:kms: '+str(algo)
for c in configs:
    ec=c['Properties']['S3Config'].get('EncryptionConfig')
    assert ec and ec.get('EncryptionType')=='KMS', 'storage config missing KMS EncryptionConfig: '+c['Properties'].get('ResourceType','?')
PY

# Customer Profiles: when on, the FlowLambdas stack deploys the
# UpdateSessionContext Lambda (caller lookup → Q Connect session data).
# When off, it must be absent.
LAMBDA_LOGICAL_IDS=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function") | .key] | join(",")' "$TEMPLATE_PREFIX-FlowLambdas.template.json")
if [[ "$PROFILES" == "true" ]]; then
  echo "$LAMBDA_LOGICAL_IDS" | grep -qi "UpdateSessionContext" || { echo "FAIL: customer profiles on but UpdateSessionContext Lambda not deployed" >&2; exit 1; }
else
  if echo "$LAMBDA_LOGICAL_IDS" | grep -qi "UpdateSessionContext"; then echo "FAIL: customer profiles off but UpdateSessionContext Lambda deployed" >&2; exit 1; fi
fi

echo "PASS: render-and-synth profiles=$PROFILES"
