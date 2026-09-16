#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRITER=(npm --silent --prefix "$ROOT/cli" run csp -- values)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

# 1. Express order → all defaults applied, exactly the expected keys, booleans typed.
# (region IS emitted — it is rendered into bin/connect-blueprint.ts to pin the
# deploy region deterministically instead of relying on shell env vars.)
"${WRITER[@]}" "$ROOT/tests/fixtures/order-express.json" "$TMP/express.json"
keys=$(jq -r 'keys_unsorted | join(",")' "$TMP/express.json" | tr ',' '\n' | sort | paste -sd, -)
expected="answerGenModelId,companyName,contactEventsEnabled,customerProfilesEnabled,dataLakeEnabled,frontendEnabled,identityCenterEnabled,kbParsingModelId,knowledgeBaseEnabled,lexLocaleId,orchestrationModelId,projectName,promptLanguage,region,retainData,selfServiceFallback,ttsLanguageCode,voiceGender"
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
"${WRITER[@]}" "$TMP/o2.json" "$TMP/v2.json"
[[ "$(jq 'has("greeting")' "$TMP/v2.json")" == "false" ]] || fail "legacy greeting key must not be emitted"

# 3. Full order preserves explicit booleans and free text.
"${WRITER[@]}" "$ROOT/tests/fixtures/order-full.json" "$TMP/full.json"
# transfer/tool/recording/encryption are ALWAYS on — legacy keys in an order
# file (the fixture carries them) must be ignored, never emitted to values.
for k in transferEnabled toolEnabled recordingEnabled encryptionEnabled; do
  [[ "$(jq "has(\"$k\")" "$TMP/full.json")" == "false" ]] || fail "legacy $k must be ignored (feature is always on)"
done
[[ "$(jq '.customerProfilesEnabled' "$TMP/full.json")" == "false" ]] || fail "customerProfilesEnabled explicit false preserved"

# 4. A companyName containing a double quote is REJECTED. It used to be accepted
#    and this case asserted the escaping "worked" — but companyName is
#    substituted verbatim into generated JSON (flows/prompt-texts-seed.json),
#    which the contact-flow stack JSON.parses at synth, so the deployment failed
#    later with a SyntaxError that named neither companyName nor the order file.
echo '{ "projectName": "p3", "companyName": "Say \"hi\" Co" }' > "$TMP/o4.json"
if "${WRITER[@]}" "$TMP/o4.json" "$TMP/v4.json" 2>/dev/null; then fail "companyName with double quote accepted"; fi

# 4b. Ordinary free text (no shell/JSON metacharacters) still round-trips.
echo '{ "projectName": "p3b", "companyName": "Muller & Sons, Inc." }' > "$TMP/o4b.json"
"${WRITER[@]}" "$TMP/o4b.json" "$TMP/v4b.json"
jq -e . "$TMP/v4b.json" >/dev/null || fail "output not valid JSON for ordinary free text"
[[ "$(jq -r '.companyName' "$TMP/v4b.json")" == 'Muller & Sons, Inc.' ]] || fail "free-text round trip"

# 5. Invalid projectName (uppercase) is rejected.
echo '{ "projectName": "Bad-Name" }' > "$TMP/o5.json"
if "${WRITER[@]}" "$TMP/o5.json" "$TMP/v5.json" 2>/dev/null; then fail "uppercase projectName accepted"; fi

# 6. Invalid projectName (too long) is rejected.
echo '{ "projectName": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }' > "$TMP/o6.json"
if "${WRITER[@]}" "$TMP/o6.json" "$TMP/v6.json" 2>/dev/null; then fail "33-char projectName accepted"; fi

# 7. Missing projectName is rejected (no safe default for a name).
echo '{ "companyName": "X" }' > "$TMP/o7.json"
if "${WRITER[@]}" "$TMP/o7.json" "$TMP/v7.json" 2>/dev/null; then fail "missing projectName accepted"; fi

# 8. No dead keys: accountId/blueprintFlavor/novaModelId and the always-on
# feature flags never appear.
# (region is intentionally NOT a dead key — it is emitted to pin the deploy region.)
"${WRITER[@]}" "$ROOT/tests/fixtures/order-express.json" "$TMP/dead.json"
for k in accountId blueprintFlavor novaModelId encryptionEnabled transferEnabled toolEnabled recordingEnabled; do
  [[ "$(jq "has(\"$k\")" "$TMP/dead.json")" == "false" ]] || fail "dead key present: $k"
done

# 9. Invalid projectName (consecutive hyphens) is rejected.
echo '{ "projectName": "test--name" }' > "$TMP/o9.json"
if "${WRITER[@]}" "$TMP/o9.json" "$TMP/v9.json" 2>/dev/null; then fail "consecutive hyphens projectName accepted"; fi

# 10. Invalid projectName (leading hyphen) is rejected.
echo '{ "projectName": "-test" }' > "$TMP/o10.json"
if "${WRITER[@]}" "$TMP/o10.json" "$TMP/v10.json" 2>/dev/null; then fail "leading hyphen projectName accepted"; fi

# 11. Invalid projectName (trailing hyphen) is rejected.
echo '{ "projectName": "test-" }' > "$TMP/o11.json"
if "${WRITER[@]}" "$TMP/o11.json" "$TMP/v11.json" 2>/dev/null; then fail "trailing hyphen projectName accepted"; fi

# 12. CompanyName with backtick is rejected (unsupported character — the owned
#     companyName rule: ` " \ ${ and line breaks are not supported, see
#     cli/src/core/schema.ts).
echo '{ "projectName": "p12", "companyName": "Say `hi` Co" }' > "$TMP/o12.json"
if "${WRITER[@]}" "$TMP/o12.json" "$TMP/v12.json" 2>/dev/null; then fail "companyName with backtick accepted"; fi

# 13. CompanyName with ${ sequence is rejected (unsupported character — owned companyName rule).
echo '{ "projectName": "p13", "companyName": "Cost: ${price}" }' > "$TMP/o13.json"
if "${WRITER[@]}" "$TMP/o13.json" "$TMP/v13.json" 2>/dev/null; then fail "companyName with \${ accepted"; fi

# 14. CompanyName with backslash is rejected (unsupported character — owned companyName rule).
echo '{ "projectName": "p14", "companyName": "Back\\slash Co" }' > "$TMP/o14.json"
if "${WRITER[@]}" "$TMP/o14.json" "$TMP/v14.json" 2>/dev/null; then fail "companyName with backslash accepted"; fi

# 15. CompanyName with double quotes is rejected, with the character named in the
#     message (see case 4 for why: it breaks the generated prompt-texts JSON).
echo '{ "projectName": "p15", "companyName": "Say \"hello\" Co" }' > "$TMP/o15.json"
if "${WRITER[@]}" "$TMP/o15.json" "$TMP/v15.json" 2>/dev/null; then fail "companyName with double quotes accepted"; fi
MSG="$("${WRITER[@]}" "$TMP/o15.json" "$TMP/v15.json" 2>&1 || true)"
case "$MSG" in
  *'invalid companyName'*'are not supported'*) : ;;
  *) fail "companyName rejection message does not explain the rule: $MSG" ;;
esac

# 16. Express defaults derive en/US/feminine values + us.* model profiles.
"${WRITER[@]}" "$ROOT/tests/fixtures/order-express.json" "$TMP/loc-def.json"
[[ "$(jq -r '.lexLocaleId' "$TMP/loc-def.json")" == "en_US" ]] || fail "default lexLocaleId"
[[ "$(jq -r '.ttsLanguageCode' "$TMP/loc-def.json")" == "en-US" ]] || fail "default ttsLanguageCode"
# Voice itself is no longer a values field — it is seeded into the prompt-texts
# data table by voiceGender (see prompt-texts-seed.json / test-region-language.sh).
# Here we only assert the gender selector defaults to feminine.
[[ "$(jq -r '.voiceGender' "$TMP/loc-def.json")" == "feminine" ]] || fail "default voiceGender feminine"
[[ "$(jq -r 'has("voiceId")' "$TMP/loc-def.json")" == "false" ]] || fail "voiceId should no longer be emitted"
[[ "$(jq -r '.orchestrationModelId' "$TMP/loc-def.json")" == "us.anthropic.claude-haiku-4-5-20251001-v1:0" ]] || fail "default us orchestration model"
[[ "$(jq -r '.answerGenModelId' "$TMP/loc-def.json")" == "us.amazon.nova-pro-v1:0" ]] || fail "default us answer model"

# 17. region=eu-central-1 → eu.* model profiles; region emitted verbatim for pinning.
echo '{ "projectName": "p17", "region": "eu-central-1" }' > "$TMP/o17.json"
"${WRITER[@]}" "$TMP/o17.json" "$TMP/v17.json"
[[ "$(jq -r '.orchestrationModelId' "$TMP/v17.json")" == "eu.anthropic.claude-haiku-4-5-20251001-v1:0" ]] || fail "eu orchestration model"
[[ "$(jq -r '.answerGenModelId' "$TMP/v17.json")" == "eu.amazon.nova-pro-v1:0" ]] || fail "eu answer model"
[[ "$(jq -r '.region' "$TMP/v17.json")" == "eu-central-1" ]] || fail "region must be emitted to values.json for deploy pinning"

# 18. language=de → de_DE locale + de-DE TTS. (Voice comes from the seed table
# by voiceGender, asserted in test-region-language.sh, not from values.)
echo '{ "projectName": "p18", "language": "de" }' > "$TMP/o18.json"
"${WRITER[@]}" "$TMP/o18.json" "$TMP/v18.json"
[[ "$(jq -r '.lexLocaleId' "$TMP/v18.json")" == "de_DE" ]] || fail "de lexLocaleId"
[[ "$(jq -r '.ttsLanguageCode' "$TMP/v18.json")" == "de-DE" ]] || fail "de ttsLanguageCode"
[[ "$(jq -r '.voiceGender' "$TMP/v18.json")" == "feminine" ]] || fail "de default voiceGender feminine"
# (greeting localization moved to the data table seed — see
# flows/prompt-texts-seed.json aiAssistantIntro; no greeting in values.)

# 19. voiceGender is emitted verbatim (it selects the seed slice at deploy time).
echo '{ "projectName": "p19a", "voiceGender": "masculine" }' > "$TMP/o19a.json"
"${WRITER[@]}" "$TMP/o19a.json" "$TMP/v19a.json"
[[ "$(jq -r '.voiceGender' "$TMP/v19a.json")" == "masculine" ]] || fail "en masculine voiceGender"
echo '{ "projectName": "p19b", "language": "de", "voiceGender": "masculine" }' > "$TMP/o19b.json"
"${WRITER[@]}" "$TMP/o19b.json" "$TMP/v19b.json"
[[ "$(jq -r '.voiceGender' "$TMP/v19b.json")" == "masculine" ]] || fail "de masculine voiceGender"

# 20. German + Frankfurt fixture: de_DE + eu.* together.
"${WRITER[@]}" "$ROOT/tests/fixtures/order-de-frankfurt.json" "$TMP/v20.json"
[[ "$(jq -r '.lexLocaleId' "$TMP/v20.json")" == "de_DE" ]] || fail "frankfurt-de lexLocaleId"
[[ "$(jq -r '.orchestrationModelId' "$TMP/v20.json")" == "eu.anthropic.claude-haiku-4-5-20251001-v1:0" ]] || fail "frankfurt-de eu model"

# 21. Invalid region / language / voiceGender are rejected.
echo '{ "projectName": "p21", "region": "eu-west-1" }' > "$TMP/o21.json"
if "${WRITER[@]}" "$TMP/o21.json" "$TMP/v21.json" 2>/dev/null; then fail "invalid region accepted"; fi
echo '{ "projectName": "p21b", "language": "fr" }' > "$TMP/o21b.json"
if "${WRITER[@]}" "$TMP/o21b.json" "$TMP/v21b.json" 2>/dev/null; then fail "invalid language accepted"; fi
echo '{ "projectName": "p21c", "voiceGender": "robot" }' > "$TMP/o21c.json"
if "${WRITER[@]}" "$TMP/o21c.json" "$TMP/v21c.json" 2>/dev/null; then fail "invalid voiceGender accepted"; fi

# 22. Default language en → promptLanguage English + English self-service fallback.
"${WRITER[@]}" "$ROOT/tests/fixtures/order-express.json" "$TMP/v22.json"
[[ "$(jq -r '.promptLanguage' "$TMP/v22.json")" == "English" ]] || fail "en promptLanguage"
[[ "$(jq -r '.selfServiceFallback' "$TMP/v22.json")" == "I don't have an answer." ]] || fail "en selfServiceFallback"

# 23. language=de → German promptLanguage + German fallback.
echo '{ "projectName": "p23", "language": "de", "companyName": "Globex" }' > "$TMP/o23.json"
"${WRITER[@]}" "$TMP/o23.json" "$TMP/v23.json"
[[ "$(jq -r '.promptLanguage' "$TMP/v23.json")" == "German" ]] || fail "de promptLanguage"
[[ "$(jq -r '.selfServiceFallback' "$TMP/v23.json")" == "Ich habe darauf leider keine Antwort." ]] || fail "de selfServiceFallback"

echo "PASS: build-values"
