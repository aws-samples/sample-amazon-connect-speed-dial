#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRITER="$ROOT/scripts/build-values.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

# 1. Express order → all defaults applied, exactly the expected keys, booleans typed.
# (region IS emitted — it is rendered into bin/connect-blueprint.ts to pin the
# deploy region deterministically instead of relying on shell env vars.)
"$WRITER" "$ROOT/tests/fixtures/order-express.json" "$TMP/express.json"
keys=$(jq -r 'keys_unsorted | join(",")' "$TMP/express.json" | tr ',' '\n' | sort | paste -sd, -)
expected="answerGenModelId,companyName,contactEventsEnabled,customerProfilesEnabled,dataLakeEnabled,frontendEnabled,identityCenterEnabled,kbParsingModelId,knowledgeBaseEnabled,lexLocaleId,orchestrationModelId,projectName,promptLanguage,region,retainData,selfServiceFallback,sonicVoiceId,ttsLanguageCode,voiceGender,voiceId"
[[ "$keys" == "$expected" ]] || fail "express keys: got [$keys] want [$expected]"
[[ "$(jq -r '.projectName' "$TMP/express.json")" == "acme-support" ]] || fail "projectName"
[[ "$(jq -r '.companyName' "$TMP/express.json")" == "My Company" ]] || fail "default companyName"
# customer profiles default-true when omitted
[[ "$(jq '.customerProfilesEnabled' "$TMP/express.json")" == "true" ]] || fail "default customerProfilesEnabled should be true"
[[ "$(jq -r '.orchestrationModelId' "$TMP/express.json")" == "us.anthropic.claude-haiku-4-5-20251001-v1:0" ]] || fail "orchestrationModelId"
[[ "$(jq -r '.answerGenModelId' "$TMP/express.json")" == "us.amazon.nova-pro-v1:0" ]] || fail "answerGenModelId"
# express omits region → defaults to us-east-1, emitted for deterministic pinning
[[ "$(jq -r '.region' "$TMP/express.json")" == "us-east-1" ]] || fail "express default region us-east-1"

# 2. greeting is NO LONGER a values key — localized intros live in the data
# table seed (flows/prompt-texts-seed.json, aiAssistantIntro). A legacy
# greeting key in an order file must be ignored, never emitted.
echo '{ "projectName": "p1", "companyName": "Globex", "greeting": "Hi!" }' > "$TMP/o2.json"
"$WRITER" "$TMP/o2.json" "$TMP/v2.json"
[[ "$(jq 'has("greeting")' "$TMP/v2.json")" == "false" ]] || fail "legacy greeting key must not be emitted"

# 3. Full order preserves explicit booleans and free text.
"$WRITER" "$ROOT/tests/fixtures/order-full.json" "$TMP/full.json"
# transfer/tool/recording/encryption are ALWAYS on — legacy keys in an order
# file (the fixture carries them) must be ignored, never emitted to values.
for k in transferEnabled toolEnabled recordingEnabled encryptionEnabled; do
  [[ "$(jq "has(\"$k\")" "$TMP/full.json")" == "false" ]] || fail "legacy $k must be ignored (feature is always on)"
done
[[ "$(jq '.customerProfilesEnabled' "$TMP/full.json")" == "false" ]] || fail "customerProfilesEnabled explicit false preserved"

# 4. Free text with quotes is escaped into valid JSON.
echo '{ "projectName": "p3", "companyName": "Say \"hi\" Co" }' > "$TMP/o4.json"
"$WRITER" "$TMP/o4.json" "$TMP/v4.json"
jq -e . "$TMP/v4.json" >/dev/null || fail "output not valid JSON with quotes"
[[ "$(jq -r '.companyName' "$TMP/v4.json")" == 'Say "hi" Co' ]] || fail "quote escaping"

# 5. Invalid projectName (uppercase) is rejected.
echo '{ "projectName": "Bad-Name" }' > "$TMP/o5.json"
if "$WRITER" "$TMP/o5.json" "$TMP/v5.json" 2>/dev/null; then fail "uppercase projectName accepted"; fi

# 6. Invalid projectName (too long) is rejected.
echo '{ "projectName": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }' > "$TMP/o6.json"
if "$WRITER" "$TMP/o6.json" "$TMP/v6.json" 2>/dev/null; then fail "33-char projectName accepted"; fi

# 7. Missing projectName is rejected (no safe default for a name).
echo '{ "companyName": "X" }' > "$TMP/o7.json"
if "$WRITER" "$TMP/o7.json" "$TMP/v7.json" 2>/dev/null; then fail "missing projectName accepted"; fi

# 8. No dead keys: accountId/blueprintFlavor/novaModelId and the always-on
# feature flags never appear.
# (region is intentionally NOT a dead key — it is emitted to pin the deploy region.)
"$WRITER" "$ROOT/tests/fixtures/order-express.json" "$TMP/dead.json"
for k in accountId blueprintFlavor novaModelId encryptionEnabled transferEnabled toolEnabled recordingEnabled; do
  [[ "$(jq "has(\"$k\")" "$TMP/dead.json")" == "false" ]] || fail "dead key present: $k"
done

# 9. Invalid projectName (consecutive hyphens) is rejected.
echo '{ "projectName": "test--name" }' > "$TMP/o9.json"
if "$WRITER" "$TMP/o9.json" "$TMP/v9.json" 2>/dev/null; then fail "consecutive hyphens projectName accepted"; fi

# 10. Invalid projectName (leading hyphen) is rejected.
echo '{ "projectName": "-test" }' > "$TMP/o10.json"
if "$WRITER" "$TMP/o10.json" "$TMP/v10.json" 2>/dev/null; then fail "leading hyphen projectName accepted"; fi

# 11. Invalid projectName (trailing hyphen) is rejected.
echo '{ "projectName": "test-" }' > "$TMP/o11.json"
if "$WRITER" "$TMP/o11.json" "$TMP/v11.json" 2>/dev/null; then fail "trailing hyphen projectName accepted"; fi

# 12. CompanyName with backtick is rejected (breaks TypeScript template literals).
echo '{ "projectName": "p12", "companyName": "Say `hi` Co" }' > "$TMP/o12.json"
if "$WRITER" "$TMP/o12.json" "$TMP/v12.json" 2>/dev/null; then fail "companyName with backtick accepted"; fi

# 13. CompanyName with ${ sequence is rejected (breaks TypeScript template literals).
echo '{ "projectName": "p13", "companyName": "Cost: ${price}" }' > "$TMP/o13.json"
if "$WRITER" "$TMP/o13.json" "$TMP/v13.json" 2>/dev/null; then fail "companyName with \${ accepted"; fi

# 14. CompanyName with backslash is rejected (breaks TypeScript template literals).
echo '{ "projectName": "p14", "companyName": "Back\\slash Co" }' > "$TMP/o14.json"
if "$WRITER" "$TMP/o14.json" "$TMP/v14.json" 2>/dev/null; then fail "companyName with backslash accepted"; fi

# 15. CompanyName with double quotes is still accepted (quote escaping works).
echo '{ "projectName": "p15", "companyName": "Say \"hello\" Co" }' > "$TMP/o15.json"
"$WRITER" "$TMP/o15.json" "$TMP/v15.json"
[[ "$(jq -r '.companyName' "$TMP/v15.json")" == 'Say "hello" Co' ]] || fail "companyName with double quotes rejected"

# 16. Express defaults derive en/US/feminine values + us.* model profiles.
"$WRITER" "$ROOT/tests/fixtures/order-express.json" "$TMP/loc-def.json"
[[ "$(jq -r '.lexLocaleId' "$TMP/loc-def.json")" == "en_US" ]] || fail "default lexLocaleId"
[[ "$(jq -r '.ttsLanguageCode' "$TMP/loc-def.json")" == "en-US" ]] || fail "default ttsLanguageCode"
[[ "$(jq -r '.voiceId' "$TMP/loc-def.json")" == "Tiffany" ]] || fail "default voiceId"
[[ "$(jq -r '.sonicVoiceId' "$TMP/loc-def.json")" == "tiffany" ]] || fail "default sonicVoiceId"
[[ "$(jq -r '.orchestrationModelId' "$TMP/loc-def.json")" == "us.anthropic.claude-haiku-4-5-20251001-v1:0" ]] || fail "default us orchestration model"
[[ "$(jq -r '.answerGenModelId' "$TMP/loc-def.json")" == "us.amazon.nova-pro-v1:0" ]] || fail "default us answer model"

# 17. region=eu-central-1 → eu.* model profiles; region emitted verbatim for pinning.
echo '{ "projectName": "p17", "region": "eu-central-1" }' > "$TMP/o17.json"
"$WRITER" "$TMP/o17.json" "$TMP/v17.json"
[[ "$(jq -r '.orchestrationModelId' "$TMP/v17.json")" == "eu.anthropic.claude-haiku-4-5-20251001-v1:0" ]] || fail "eu orchestration model"
[[ "$(jq -r '.answerGenModelId' "$TMP/v17.json")" == "eu.amazon.nova-pro-v1:0" ]] || fail "eu answer model"
[[ "$(jq -r '.region' "$TMP/v17.json")" == "eu-central-1" ]] || fail "region must be emitted to values.json for deploy pinning"

# 18. language=de → de_DE locale + de-DE TTS + feminine voices (Sonic: tina;
# flow TTS: Vicki, since Tina is not in the Polly generative catalog).
echo '{ "projectName": "p18", "language": "de" }' > "$TMP/o18.json"
"$WRITER" "$TMP/o18.json" "$TMP/v18.json"
[[ "$(jq -r '.lexLocaleId' "$TMP/v18.json")" == "de_DE" ]] || fail "de lexLocaleId"
[[ "$(jq -r '.ttsLanguageCode' "$TMP/v18.json")" == "de-DE" ]] || fail "de ttsLanguageCode"
[[ "$(jq -r '.voiceId' "$TMP/v18.json")" == "Vicki" ]] || fail "de feminine flow voice Vicki"
[[ "$(jq -r '.sonicVoiceId' "$TMP/v18.json")" == "tina" ]] || fail "de feminine sonic voice tina"
# (greeting localization moved to the data table seed — see
# flows/prompt-texts-seed.json aiAssistantIntro; no greeting in values.)

# 19. masculine voices per language: en→Matthew/matthew, de→Lennart/lennart.
echo '{ "projectName": "p19a", "voiceGender": "masculine" }' > "$TMP/o19a.json"
"$WRITER" "$TMP/o19a.json" "$TMP/v19a.json"
[[ "$(jq -r '.voiceId' "$TMP/v19a.json")" == "Matthew" ]] || fail "en masculine voice Matthew"
[[ "$(jq -r '.sonicVoiceId' "$TMP/v19a.json")" == "matthew" ]] || fail "en masculine sonic voice matthew"
echo '{ "projectName": "p19b", "language": "de", "voiceGender": "masculine" }' > "$TMP/o19b.json"
"$WRITER" "$TMP/o19b.json" "$TMP/v19b.json"
[[ "$(jq -r '.voiceId' "$TMP/v19b.json")" == "Lennart" ]] || fail "de masculine voice Lennart"
[[ "$(jq -r '.sonicVoiceId' "$TMP/v19b.json")" == "lennart" ]] || fail "de masculine sonic voice lennart"

# 20. German + Frankfurt fixture: de_DE + eu.* together.
"$WRITER" "$ROOT/tests/fixtures/order-de-frankfurt.json" "$TMP/v20.json"
[[ "$(jq -r '.voiceId' "$TMP/v20.json")" == "Lennart" ]] || fail "frankfurt-de voiceId"
[[ "$(jq -r '.sonicVoiceId' "$TMP/v20.json")" == "lennart" ]] || fail "frankfurt-de sonicVoiceId"
[[ "$(jq -r '.lexLocaleId' "$TMP/v20.json")" == "de_DE" ]] || fail "frankfurt-de lexLocaleId"
[[ "$(jq -r '.orchestrationModelId' "$TMP/v20.json")" == "eu.anthropic.claude-haiku-4-5-20251001-v1:0" ]] || fail "frankfurt-de eu model"

# 21. Invalid region / language / voiceGender are rejected.
echo '{ "projectName": "p21", "region": "eu-west-1" }' > "$TMP/o21.json"
if "$WRITER" "$TMP/o21.json" "$TMP/v21.json" 2>/dev/null; then fail "invalid region accepted"; fi
echo '{ "projectName": "p21b", "language": "fr" }' > "$TMP/o21b.json"
if "$WRITER" "$TMP/o21b.json" "$TMP/v21b.json" 2>/dev/null; then fail "invalid language accepted"; fi
echo '{ "projectName": "p21c", "voiceGender": "robot" }' > "$TMP/o21c.json"
if "$WRITER" "$TMP/o21c.json" "$TMP/v21c.json" 2>/dev/null; then fail "invalid voiceGender accepted"; fi

# 22. Default language en → promptLanguage English + English self-service fallback.
"$WRITER" "$ROOT/tests/fixtures/order-express.json" "$TMP/v22.json"
[[ "$(jq -r '.promptLanguage' "$TMP/v22.json")" == "English" ]] || fail "en promptLanguage"
[[ "$(jq -r '.selfServiceFallback' "$TMP/v22.json")" == "I don't have an answer." ]] || fail "en selfServiceFallback"

# 23. language=de → German promptLanguage + German fallback.
echo '{ "projectName": "p23", "language": "de", "companyName": "Globex" }' > "$TMP/o23.json"
"$WRITER" "$TMP/o23.json" "$TMP/v23.json"
[[ "$(jq -r '.promptLanguage' "$TMP/v23.json")" == "German" ]] || fail "de promptLanguage"
[[ "$(jq -r '.selfServiceFallback' "$TMP/v23.json")" == "Ich habe darauf leider keine Antwort." ]] || fail "de selfServiceFallback"

echo "PASS: build-values"
