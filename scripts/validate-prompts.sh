#!/usr/bin/env bash
set -euo pipefail

# Validate that customized agent prompt files keep the scaffolding Q Connect
# requires. A user may freely rewrite the persona/instructions, but dropping a
# required runtime variable or the message-formatting structure breaks the
# deployed agent — so we fail loudly here, before render/deploy.
#
# Usage: validate-prompts.sh <prompts-dir>
#   <prompts-dir> must contain orchestration.md and self-service.md

PROMPTS_DIR="${1:?usage: validate-prompts.sh <prompts-dir>}"

ORCH="$PROMPTS_DIR/orchestration.md"
SELF="$PROMPTS_DIR/self-service.md"

fail() { echo "ERROR: $1" >&2; exit 1; }

require() {
  # require <file> <needle> <human description>
  local file="$1" needle="$2" desc="$3"
  grep -qF "$needle" "$file" || fail "$(basename "$file") is missing $desc ('$needle')"
}

[[ -f "$ORCH" ]] || fail "orchestration prompt not found: $ORCH"
[[ -f "$SELF" ]] || fail "self-service prompt not found: $SELF"

# Orchestration: needs the system block, the conversation-history runtime
# variable, and the <message> formatting tag the orchestrator wraps replies in.
require "$ORCH" 'system:'                  'the system block'
require "$ORCH" '{{$.conversationHistory}}' 'the conversation-history variable'
require "$ORCH" '<message>'                 'the <message> formatting tag'

# Self-service: needs the content-excerpt runtime variable (the retrieved KB
# documents are injected there for answer generation).
require "$SELF" '{{$.contentExcerpt}}' 'the content-excerpt variable'

echo "prompts valid: $PROMPTS_DIR"
