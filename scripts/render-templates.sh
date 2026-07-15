#!/usr/bin/env bash
set -euo pipefail

VALUES_FILE="${1:?usage: render-templates.sh <values.json> <src-dir> <dest-dir>}"
SRC_DIR="${2:?usage: render-templates.sh <values.json> <src-dir> <dest-dir>}"
DEST_DIR="${3:?usage: render-templates.sh <values.json> <src-dir> <dest-dir>}"

if [[ ! -f "$VALUES_FILE" ]]; then echo "values file not found: $VALUES_FILE" >&2; exit 1; fi
if [[ ! -d "$SRC_DIR" ]]; then echo "source dir not found: $SRC_DIR" >&2; exit 1; fi

mkdir -p "$DEST_DIR"
cp -R "$SRC_DIR/." "$DEST_DIR/"

# Agent prompts: if the working dir (where the values file lives) has its own
# prompts/, use those instead of the blueprint defaults. This is how a user's
# customized prompts reach the deployed agents while surviving a re-render —
# the template's seed prompts are only the fallback. Then validate the prompts
# that will actually be deployed, so missing scaffolding fails before substitution.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(cd "$(dirname "$VALUES_FILE")" && pwd)"
if [[ -d "$WORK_DIR/prompts" ]]; then
  for name in orchestration self-service; do
    if [[ -f "$WORK_DIR/prompts/$name.md" ]]; then
      cp "$WORK_DIR/prompts/$name.md" "$DEST_DIR/prompts/$name.md"
    fi
  done
fi

# When context injection OR customer profiles is enabled, append the
# context-usage instruction to the orchestration prompt's `system:` block (just
# before the `messages:` line) so the agent uses the {{$.Custom.*}} caller
# context. Both features populate the same session keys, so the one snippet
# serves both — and is appended at most once. Kept out of the base prompt so
# default deployments and user edits are unaffected.
ORCH="$DEST_DIR/prompts/orchestration.md"
SNIPPET="$DEST_DIR/prompts/context-injection.snippet.md"
CONTEXT_ON="$(jq -r '.contextInjectionEnabled // false' "$VALUES_FILE")"
PROFILES_ON="$(jq -r 'if .customerProfilesEnabled == null then true else .customerProfilesEnabled end' "$VALUES_FILE")"
if [[ ( "$CONTEXT_ON" == "true" || "$PROFILES_ON" == "true" ) && -f "$ORCH" && -f "$SNIPPET" ]]; then
  awk 'FNR==NR { snip[NR]=$0; n=NR; next }
       /^messages:/ { for (i=1;i<=n;i++) print snip[i] }
       { print }' "$SNIPPET" "$ORCH" > "$ORCH.tmp" && mv "$ORCH.tmp" "$ORCH"
fi
# The snippet is a build-time fragment, not a deployable prompt — drop it from
# the rendered project so only orchestration.md / self-service.md remain.
rm -f "$SNIPPET"

"$SCRIPT_DIR/validate-prompts.sh" "$DEST_DIR/prompts"

SED_EXPR=""
while IFS=$'\t' read -r key value; do
  esc=$(printf '%s\n' "$value" | sed -e 's/[\/&]/\\&/g')
  SED_EXPR="$SED_EXPR;s/{{$key}}/$esc/g"
done < <(jq -r 'to_entries[] | "\(.key)\t\(.value)"' "$VALUES_FILE")

find "$DEST_DIR" -type f \( -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name '*.sh' \) \
  -not -path '*/node_modules/*' -not -path '*/cdk.out/*' -print0 | \
  while IFS= read -r -d '' f; do
    [[ "$(basename "$f")" == ".placeholder" ]] && continue
    sed -i.bak "$SED_EXPR" "$f"
    rm -f "$f.bak"
  done

if grep -r --include='*.ts' --include='*.json' --include='*.md' \
  --exclude-dir=node_modules --exclude-dir=cdk.out \
  -l '{{[a-zA-Z_]' "$DEST_DIR" 2>/dev/null; then
  echo "ERROR: unsubstituted placeholders remain in rendered output" >&2
  grep -rn --include='*.ts' --include='*.json' --include='*.md' \
    --exclude-dir=node_modules --exclude-dir=cdk.out \
    '{{[a-zA-Z_]' "$DEST_DIR" >&2
  exit 1
fi

echo "rendered $SRC_DIR -> $DEST_DIR"
