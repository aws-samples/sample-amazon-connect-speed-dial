#!/usr/bin/env bash
set -euo pipefail

ORDER="${1:?usage: build-values.sh <order.json> <out.json>}"
OUT="${2:?usage: build-values.sh <order.json> <out.json>}"

[[ -f "$ORDER" ]] || { echo "order file not found: $ORDER" >&2; exit 1; }

# --- region / language / voice: validate, default, then derive -------------
region="$(jq -r '.region // "us-east-1"' "$ORDER")"
case "$region" in
  us-east-1|eu-central-1) ;;
  *) echo "invalid region '$region': must be us-east-1 or eu-central-1" >&2; exit 1 ;;
esac

language="$(jq -r '.language // "en"' "$ORDER")"
case "$language" in
  en|de) ;;
  *) echo "invalid language '$language': must be en or de" >&2; exit 1 ;;
esac

voiceGender="$(jq -r '.voiceGender // "feminine"' "$ORDER")"
case "$voiceGender" in
  feminine|masculine) ;;
  *) echo "invalid voiceGender '$voiceGender': must be feminine or masculine" >&2; exit 1 ;;
esac

# Bedrock inference-profile prefix is region-scoped: us.* in Virginia, eu.* in
# Frankfurt (the us.* profiles do not resolve in eu-central-1).
if [[ "$region" == "eu-central-1" ]]; then
  ORCH_MODEL="eu.anthropic.claude-haiku-4-5-20251001-v1:0"
  ANSWER_MODEL="eu.amazon.nova-pro-v1:0"
else
  ORCH_MODEL="us.anthropic.claude-haiku-4-5-20251001-v1:0"
  ANSWER_MODEL="us.amazon.nova-pro-v1:0"
fi

# Lex locale, TTS language code, Polly voice, prompt language, and the
# self-service fallback are derived from language+gender.
if [[ "$language" == "de" ]]; then
  lexLocaleId="de_DE"; ttsLanguageCode="de-DE"
  promptLanguage="German"
  selfServiceFallback="Ich habe darauf leider keine Antwort."
  if [[ "$voiceGender" == "masculine" ]]; then voiceId="Daniel"; else voiceId="Vicki"; fi
else
  lexLocaleId="en_US"; ttsLanguageCode="en-US"
  promptLanguage="English"
  selfServiceFallback="I don't have an answer."
  if [[ "$voiceGender" == "masculine" ]]; then voiceId="Matthew"; else voiceId="Joanna"; fi
fi

# --- projectName: required + validated -------------------------------------
projectName="$(jq -r '.projectName // ""' "$ORDER")"
if [[ -z "$projectName" ]]; then
  echo "projectName is required" >&2; exit 1
fi
if [[ ! "$projectName" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "invalid projectName '$projectName': use lowercase letters, digits, and single hyphens (no leading/trailing hyphen)" >&2
  exit 1
fi
if (( ${#projectName} > 32 )); then
  echo "invalid projectName '$projectName': max 32 characters" >&2; exit 1
fi

# --- defaults --------------------------------------------------------------
companyName="$(jq -r '.companyName // "My Company"' "$ORDER")"
# Greeting localization. The greeting question is asked before language is known
# (and the UI seeds a default), so an order can carry a default greeting written
# in the wrong language for the chosen language. Treat a greeting that equals
# EITHER language's default (or is absent) as "user kept the default" and emit
# the default for the selected language; only a genuinely custom greeting is
# used verbatim. This guarantees a German instance never ships an English
# default greeting (and vice versa).
greetingEn="Hello, welcome to ${companyName}. How can I assist you today?"
greetingDe="Hallo, willkommen bei ${companyName}. Wie kann ich Ihnen helfen?"
suppliedGreeting="$(jq -r '.greeting // ""' "$ORDER")"
if [[ "$language" == "de" ]]; then
  localizedDefault="$greetingDe"
else
  localizedDefault="$greetingEn"
fi
if [[ -z "$suppliedGreeting" || "$suppliedGreeting" == "$greetingEn" || "$suppliedGreeting" == "$greetingDe" ]]; then
  greeting="$localizedDefault"
else
  greeting="$suppliedGreeting"
fi
transferEnabled="$(jq -r '.transferEnabled // false | if type=="boolean" then . else error("transferEnabled must be boolean") end' "$ORDER")"
toolEnabled="$(jq -r '.toolEnabled // false | if type=="boolean" then . else error("toolEnabled must be boolean") end' "$ORDER")"
contextInjectionEnabled="$(jq -r '.contextInjectionEnabled // false | if type=="boolean" then . else error("contextInjectionEnabled must be boolean") end' "$ORDER")"
recordingEnabled="$(jq -r '.recordingEnabled // false | if type=="boolean" then . else error("recordingEnabled must be boolean") end' "$ORDER")"
# Encryption defaults to TRUE (secure by default) — unlike the other capability flags.
# NB: use an explicit null check, not `// true` — jq's `//` also treats `false`
# as empty, which would clobber an explicit `encryptionEnabled: false`.
encryptionEnabled="$(jq -r 'if .encryptionEnabled == null then true else .encryptionEnabled end | if type=="boolean" then . else error("encryptionEnabled must be boolean") end' "$ORDER")"
# Customer Profiles also defaults TRUE (same explicit-null-check rationale).
customerProfilesEnabled="$(jq -r 'if .customerProfilesEnabled == null then true else .customerProfilesEnabled end | if type=="boolean" then . else error("customerProfilesEnabled must be boolean") end' "$ORDER")"
frontendEnabled="$(jq -r '.frontendEnabled // false | if type=="boolean" then . else error("frontendEnabled must be boolean") end' "$ORDER")"
dataLakeEnabled="$(jq -r '.dataLakeEnabled // false | if type=="boolean" then . else error("dataLakeEnabled must be boolean") end' "$ORDER")"

# --- validate free text for TypeScript string-literal target ---------------
for pair in "companyName:$companyName" "greeting:$greeting"; do
  name="${pair%%:*}"; val="${pair#*:}"
  case "$val" in
    *'`'*|*'${'*|*'\'*)
      echo "invalid $name: must not contain backticks, \${ , or backslashes (they break the generated TypeScript)" >&2; exit 1 ;;
  esac
done

# --- emit (jq builds valid JSON; free text escaped automatically) ----------
jq -n \
  --arg projectName "$projectName" \
  --arg companyName "$companyName" \
  --arg greeting "$greeting" \
  --arg region "$region" \
  --argjson transferEnabled "$transferEnabled" \
  --argjson toolEnabled "$toolEnabled" \
  --argjson contextInjectionEnabled "$contextInjectionEnabled" \
  --argjson recordingEnabled "$recordingEnabled" \
  --argjson encryptionEnabled "$encryptionEnabled" \
  --argjson customerProfilesEnabled "$customerProfilesEnabled" \
  --argjson frontendEnabled "$frontendEnabled" \
  --argjson dataLakeEnabled "$dataLakeEnabled" \
  --arg lexLocaleId "$lexLocaleId" \
  --arg ttsLanguageCode "$ttsLanguageCode" \
  --arg voiceId "$voiceId" \
  --arg promptLanguage "$promptLanguage" \
  --arg selfServiceFallback "$selfServiceFallback" \
  --arg orchestrationModelId "$ORCH_MODEL" \
  --arg answerGenModelId "$ANSWER_MODEL" \
  '{projectName:$projectName, companyName:$companyName, greeting:$greeting, region:$region,
    transferEnabled:$transferEnabled, toolEnabled:$toolEnabled,
    contextInjectionEnabled:$contextInjectionEnabled, recordingEnabled:$recordingEnabled,
    encryptionEnabled:$encryptionEnabled, customerProfilesEnabled:$customerProfilesEnabled,
    frontendEnabled:$frontendEnabled, dataLakeEnabled:$dataLakeEnabled,
    lexLocaleId:$lexLocaleId, ttsLanguageCode:$ttsLanguageCode, voiceId:$voiceId,
    promptLanguage:$promptLanguage, selfServiceFallback:$selfServiceFallback,
    orchestrationModelId:$orchestrationModelId, answerGenModelId:$answerGenModelId}' \
  > "$OUT"

echo "wrote $OUT"
