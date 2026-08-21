#!/usr/bin/env bash
set -euo pipefail

# test-e2e-greeting-resolution.sh — the e2e harness must assert the greeting the
# flow actually plays.
#
# Regression guard: the greeting moved out of the values file into the
# prompt-texts data table (8c43128) as `aiAssistantIntro`, but the harness kept
# reading `.greeting`. jq printed the literal string "null", so every
# conversation test asserted a greeting of "null" and failed — for a week of red
# nightly builds, with the real cause masked by an unrelated flow bug.
#
# This locks the contract the harness depends on:
#   1. the values file carries NO `greeting` field (so nothing regresses to it)
#   2. the rendered seed yields the deployed greeting for gender+language
#   3. a de-DE deployment resolves the German text, not the English one
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CSP=(npm --silent --prefix "$ROOT/cli" run csp --)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

# The exact expression run-tests.sh / run-e2e.sh use to resolve the greeting.
resolve() { # <seed> <gender> <lang>
  jq -r --arg g "$2" --arg l "$3" \
    '(.[$g] // .feminine) | map(select(.language == $l)) | .[0].aiAssistantIntro // empty' "$1"
}

# --- 1. csp values must not emit a `greeting` field --------------------------
cat > "$TMP/order.json" <<'ORDER'
{ "projectName": "greet", "companyName": "E2E Test Co", "region": "us-east-1",
  "language": "en", "voiceGender": "feminine", "knowledgeBaseEnabled": true }
ORDER
"${CSP[@]}" values "$TMP/order.json" "$TMP/values.json" >/dev/null
[[ "$(jq -r 'has("greeting")' "$TMP/values.json")" == "false" ]] \
  || fail "values file carries a 'greeting' field again — update the harness or drop it"

# --- 2. en-US render resolves the English greeting with companyName applied --
render() { # <values> <dest>
  "${CSP[@]}" render "$1" "$ROOT/templates/cdk-app" "$2" >/dev/null 2>&1
}
render "$TMP/values.json" "$TMP/en"
SEED="$TMP/en/flows/prompt-texts-seed.json"
[[ -f "$SEED" ]] || fail "rendered project dir has no flows/prompt-texts-seed.json"

GREETING="$(resolve "$SEED" feminine en-US)"
[[ -n "$GREETING" ]] || fail "en-US/feminine greeting resolved empty"
[[ "$GREETING" != "null" ]] || fail "greeting resolved to the literal string 'null' (the original bug)"
[[ "$GREETING" == *"E2E Test Co"* ]] || fail "companyName not substituted: $GREETING"
[[ "$GREETING" != *'{{'* ]] || fail "greeting holds unsubstituted placeholders: $GREETING"
case "$GREETING" in
  "Hello, welcome to"*) : ;;
  *) fail "en-US greeting is not the English text: $GREETING" ;;
esac

# --- 3. a de-DE deployment must resolve the German text ---------------------
# Guards a subtle failure: asserting the en-US greeting against a German
# deployment would fail only on the localized run.
cat > "$TMP/order-de.json" <<'ORDER'
{ "projectName": "greetde", "companyName": "E2E Test Co", "region": "eu-central-1",
  "language": "de", "voiceGender": "masculine", "knowledgeBaseEnabled": true }
ORDER
"${CSP[@]}" values "$TMP/order-de.json" "$TMP/values-de.json" >/dev/null
render "$TMP/values-de.json" "$TMP/de"
DE_LANG="$(jq -r '.ttsLanguageCode' "$TMP/values-de.json")"
DE_GENDER="$(jq -r '.voiceGender' "$TMP/values-de.json")"
DE_GREETING="$(resolve "$TMP/de/flows/prompt-texts-seed.json" "$DE_GENDER" "$DE_LANG")"
[[ -n "$DE_GREETING" ]] || fail "de-DE/$DE_GENDER greeting resolved empty"
case "$DE_GREETING" in
  "Hallo, willkommen bei"*) : ;;
  *) fail "de-DE greeting is not the German text: $DE_GREETING" ;;
esac

echo "PASS: greeting resolves from the rendered seed (en-US + de-DE), no 'greeting' values field"
