#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CSP=(npm --silent --prefix "$ROOT/cli" run csp --)
SRC="$ROOT/templates/cdk-app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

# Render order→values→templates for one combo and assert the rendered values.
check() {
  local region="$1" language="$2" gender="$3" voice="$4" locale="$6" tts="$7" modelPrefix="$8"
  local order="$TMP/order.json" values="$TMP/values.json" dest="$TMP/rendered"
  rm -rf "$dest"
  jq -n --arg r "$region" --arg l "$language" --arg g "$gender" \
    '{projectName:"loc-test", region:$r, language:$l, voiceGender:$g}' > "$order"
  "${CSP[@]}" values "$order" "$values" >/dev/null
  "${CSP[@]}" render "$values" "$SRC" "$dest" >/dev/null

  # The flow must set the contact LanguageCode so Connect calls the Lex V2 bot
  # with the matching locale; without it the contact defaults to en_US and a
  # de_DE-only bot returns ResourceNotFoundException at runtime. The language
  # is resolved dynamically (from the customer-profile module result), no
  # longer a static render-time placeholder.
  grep -q '"LanguageCode": "\$\.Modules\.ResultData\.locale"' "$dest/flows/basic-agent-flow.json" || fail "$region/$language/$gender: flow does not set contact LanguageCode"

  grep -q "localeId: '$locale'" "$dest/lib/wisdom-stack.ts" || fail "$region/$language/$gender: Lex localeId $locale"
  # Amazon Connect agentic voice: the bot locale carries the Advanced ASR model
  # preference (the ASR half), and the caller-facing voice comes from the flow's
  # Set-voice block (the TTS half) — NOT from the bot locale. The old Nova Sonic
  # unifiedSpeechSettings.voiceId must be gone, or it would override the flow.
  grep -q "speechModelPreference: 'Advanced'" "$dest/lib/wisdom-stack.ts" || fail "$region/$language/$gender: bot locale missing Advanced ASR preference"
  # Match the property assignment, not the word — the surrounding comment
  # explains why Sonic was removed and legitimately mentions it by name.
  grep -qE '^[[:space:]]*unifiedSpeechSettings:' "$dest/lib/wisdom-stack.ts" && fail "$region/$language/$gender: Nova Sonic unifiedSpeechSettings still configured — it would override the agentic voice"
  # The flow must select the agentic provider, not a Polly engine.
  grep -q "__TTS_ENGINE__: 'connect:agentic'" "$dest/lib/contact-flow-stack.ts" || fail "$region/$language/$gender: flow does not select connect:agentic"
  grep -q "locale: '$locale'" "$dest/lib/wisdom-stack.ts" || fail "$region/$language/$gender: agent locale $locale"
  # Prompts must instruct the agent to respond in the configured language.
  local plang; case "$language" in de) plang="German";; *) plang="English";; esac
  grep -q "respond in $plang" "$dest/prompts/orchestration.md" || fail "$region/$language/$gender: orchestration prompt language $plang"
  grep -q "Answer in $plang" "$dest/prompts/self-service.md" || fail "$region/$language/$gender: self-service prompt language $plang"
  # The caller-facing voice is seeded into the prompt-texts data table, selected
  # by voiceGender at deploy time — NOT a values field or a flow placeholder
  # anymore. Assert the rendered seed carries the expected agentic voice id for
  # this language/gender under the matching locale row.
  seeded_voice="$(jq -r --arg g "$gender" --arg l "$tts" \
    '(.[$g] // .feminine) | map(select(.language == $l)) | .[0].voice // empty' \
    "$dest/flows/prompt-texts-seed.json")"
  [[ "$seeded_voice" == "$voice" ]] || fail "$region/$language/$gender: seeded voice is '$seeded_voice', expected $voice"
  # TTS language remains a synth-time placeholder in the subs map.
  grep -q "__TTS_LANGUAGE_CODE__: \`$tts\`" "$dest/lib/contact-flow-stack.ts" || fail "$region/$language/$gender: tts $tts"
  # The consent text now lives in the prompt-texts data table seed (both
  # languages always ship; the flow selects by language at runtime), with
  # {{companyName}} rendered.
  grep -q 'Willkommen beim Kundenservice von' "$dest/flows/prompt-texts-seed.json" || fail "$region/$language/$gender: German consent in prompt-texts seed"
  grep -q 'Welcome to loc-test customer service\|Welcome to My Company customer service' "$dest/flows/prompt-texts-seed.json" || fail "$region/$language/$gender: English consent in prompt-texts seed"
  local model; model="$(jq -r '.orchestrationModelId' "$values")"
  [[ "$model" == "$modelPrefix"* ]] || fail "$region/$language/$gender: model prefix $modelPrefix (got $model)"
  # region is emitted to values.json and rendered as a hardcoded pin in the CDK
  # app entry, so the deploy region can never silently fall back to the profile.
  [[ "$(jq -r '.region' "$values")" == "$region" ]] || fail "$region/$language/$gender: region not emitted to values.json"
  grep -q "region: '$region'" "$dest/bin/connect-blueprint.ts" || fail "$region/$language/$gender: region not pinned in bin/connect-blueprint.ts"
  echo "ok: $region / $language / $gender -> $voice $locale $tts ${modelPrefix}*"
}

check us-east-1    en feminine  KATIE     "" en_US en-US "us."
check us-east-1    en masculine RONALD    "" en_US en-US "us."
check us-east-1    de feminine  VIKTORIA  "" de_DE de-DE "us."
check eu-central-1 de masculine SEBASTIAN "" de_DE de-DE "eu."
check eu-central-1 en feminine  KATIE     "" en_US en-US "eu."

echo "PASS: region-language-voice matrix"
