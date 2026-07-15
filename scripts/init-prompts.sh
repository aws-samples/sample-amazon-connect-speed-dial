#!/usr/bin/env bash
set -euo pipefail

# Seed editable agent-prompt files into the working directory so users can
# customize the orchestration and self-service prompts. Copies the blueprint
# defaults only when a file does not already exist — so it is safe to re-run
# and never clobbers a user's edits.
#
# Usage: init-prompts.sh <skill-dir> <working-dir>
#   Seeds <working-dir>/prompts/{orchestration,self-service}.md from
#   <skill-dir>/templates/cdk-app/prompts/.

SKILL_DIR="${1:?usage: init-prompts.sh <skill-dir> <working-dir>}"
WORK_DIR="${2:?usage: init-prompts.sh <skill-dir> <working-dir>}"

SRC="$SKILL_DIR/templates/cdk-app/prompts"
DEST="$WORK_DIR/prompts"

[[ -d "$SRC" ]] || { echo "seed prompts not found: $SRC" >&2; exit 1; }

mkdir -p "$DEST"
for name in orchestration self-service; do
  if [[ -f "$DEST/$name.md" ]]; then
    echo "kept existing $DEST/$name.md"
  else
    cp "$SRC/$name.md" "$DEST/$name.md"
    echo "seeded $DEST/$name.md"
  fi
done
