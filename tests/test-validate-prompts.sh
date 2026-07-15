#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VALIDATE="$ROOT/scripts/validate-prompts.sh"
INIT="$ROOT/scripts/init-prompts.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

# 1. The shipped template defaults must validate.
"$VALIDATE" "$ROOT/templates/cdk-app/prompts" >/dev/null || fail "template default prompts should validate"

# 2. init-prompts seeds both files, and the seeded copies validate.
"$INIT" "$ROOT" "$TMP" >/dev/null
[[ -f "$TMP/prompts/orchestration.md" && -f "$TMP/prompts/self-service.md" ]] || fail "init-prompts did not seed both files"
"$VALIDATE" "$TMP/prompts" >/dev/null || fail "seeded prompts should validate"

# 3. init-prompts is idempotent — it must not clobber an existing edit.
echo "CUSTOM EDIT {{\$.conversationHistory}} <message> system:" > "$TMP/prompts/orchestration.md"
"$INIT" "$ROOT" "$TMP" >/dev/null
grep -q "CUSTOM EDIT" "$TMP/prompts/orchestration.md" || fail "init-prompts clobbered an existing prompt"

# 4. Missing orchestration scaffolding fails (each required token).
mk_orch() { printf '%s\n' "$1" > "$TMP/prompts/orchestration.md"; cp "$ROOT/templates/cdk-app/prompts/self-service.md" "$TMP/prompts/self-service.md"; }

mk_orch 'system: |
  hi
  - role: assistant
    content: <message>'   # missing {{$.conversationHistory}}
"$VALIDATE" "$TMP/prompts" 2>/dev/null && fail "should reject missing conversationHistory"

mk_orch 'system: |
  hi
  - "{{$.conversationHistory}}"'   # missing <message>
"$VALIDATE" "$TMP/prompts" 2>/dev/null && fail "should reject missing <message>"

# 5. Missing self-service contentExcerpt fails.
cp "$ROOT/templates/cdk-app/prompts/orchestration.md" "$TMP/prompts/orchestration.md"
printf 'prompt: |\n  no excerpt var here\n' > "$TMP/prompts/self-service.md"
"$VALIDATE" "$TMP/prompts" 2>/dev/null && fail "should reject missing contentExcerpt"

# 6. Missing file fails.
rm -f "$TMP/prompts/self-service.md"
"$VALIDATE" "$TMP/prompts" 2>/dev/null && fail "should reject missing self-service file"

echo "PASS: validate-prompts"
