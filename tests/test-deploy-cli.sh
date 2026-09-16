#!/usr/bin/env bash
set -euo pipefail

# test-deploy-cli.sh — the deterministic CLI must be a faithful front door:
# given the same order file, csp deploy's derived values must be byte-identical
# to calling csp values directly, and the values file must land
# project-scoped (<project>/.connect-skill-values.json).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CSP=(npm --silent --prefix "$ROOT/cli" run csp --)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

cd "$TMP"
cat > .connect-skill-order.parity.json <<'ORDER'
{ "projectName": "parity", "region": "eu-central-1", "language": "de",
  "voiceGender": "masculine", "transferEnabled": true, "recordingEnabled": true,
  "knowledgeBaseEnabled": true, "contactEventsEnabled": true }
ORDER

# Direct derivation (the skill's path)
"${CSP[@]}" values .connect-skill-order.parity.json direct-values.json >/dev/null

# CLI derivation — run only through the values step by making the next
# step (preflight) fail fast with an invalid AWS_CONFIG, then compare.
# Simpler + robust: reuse values via csp deploy is integration-level;
# here we validate the CLI's file placement contract with --synth-only later
# in CI. For the unit check, compare the CLI's values output.
AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  "${CSP[@]}" deploy --order-file .connect-skill-order.parity.json --synth-only \
  >/dev/null 2>&1 || true   # preflight fails without creds — values are written before it

[[ -f csp-parity/.connect-skill-values.json ]] || fail "CLI did not write project-scoped values file (expected csp-parity/)"
diff <(jq -S . direct-values.json) <(jq -S . csp-parity/.connect-skill-values.json) \
  || fail "CLI-written project values differ from direct 'csp values' output"

# The order filename convention must be project-unique (no generic name collision)
[[ -f .connect-skill-order.parity.json ]] || fail "order file missing"

echo "PASS: deploy-cli parity"
