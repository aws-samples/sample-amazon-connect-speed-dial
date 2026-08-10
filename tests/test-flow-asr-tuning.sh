#!/usr/bin/env bash
set -euo pipefail

# test-flow-asr-tuning.sh — the flow must not override Amazon Connect agentic
# voice's end-of-turn detection with a fixed silence window.
#
# Regression guard: the flow carried `x-amz-lex:audio:end-timeout-ms:*:* = 1000`
# from the Nova Sonic era. Under agentic voice, end-of-turn is decided primarily
# by a CONFIDENCE model that predicts when the caller has finished speaking; the
# silence timeout is only a fallback. Pinning that fallback globally (`*:*`)
# forces a ~1s dead-air wait on EVERY turn, which reads as "barge-in is broken"
# and generally unsmooth conversation. AWS's guidance is explicit that applying a
# `*:*` default to tune one case changes pacing for the whole bot.
#
# Defaults (from the agentic voice best-practices guide): confidence threshold
# 0.7 (range 0.5-0.9), silence timeout 640ms (range 500-10000ms), barge-in on.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLOW="$ROOT/templates/cdk-app/flows/basic-agent-flow.json"

python3 - "$FLOW" <<'PY' || exit 1
import json, sys

flow = json.load(open(sys.argv[1]))
failures = []
seen_agent_block = False

for a in flow['Actions']:
    if a['Type'] != 'ConnectParticipantWithLexBot':
        continue
    seen_agent_block = True
    attrs = a.get('Parameters', {}).get('LexSessionAttributes', {}) or {}

    # 1. No global end-of-turn overrides. A scoped override on a specific
    #    intent/slot is legitimate (e.g. relaxing detection while collecting an
    #    account number); a `*:*` default is not.
    for key in attrs:
        if 'end-timeout-ms' in key or 'end-confidence-threshold' in key:
            if key.endswith(':*:*'):
                failures.append(
                    f"{a['Identifier']}: global end-of-turn override {key!r}={attrs[key]!r} — "
                    "this pins the silence fallback for every turn and defeats agentic "
                    "voice's confidence-based end-of-turn detection. Scope it to the "
                    "intent/slot that needs it, or drop it.")

    # 2. Barge-in must not be disabled globally: the caller has to be able to
    #    interrupt the agent for the conversation to feel natural.
    for key, val in attrs.items():
        if 'allow-interrupt' in key and key.endswith(':*:*'):
            if str(val).lower() != 'true':
                failures.append(
                    f"{a['Identifier']}: barge-in disabled globally ({key}={val!r}) — "
                    "only disable it on specific disclaimer/compliance prompts.")

    # 3. Any end-of-turn value that IS present must be in the supported range.
    #    Out-of-range confidence is rejected outright; timeout is silently clamped.
    for key, val in attrs.items():
        try:
            num = float(val)
        except (TypeError, ValueError):
            continue
        if 'end-confidence-threshold' in key and not (0.5 <= num <= 0.9):
            failures.append(f"{a['Identifier']}: {key}={val} outside the supported 0.5-0.9 range (request is rejected)")
        if 'end-timeout-ms' in key and not (500 <= num <= 10000):
            failures.append(f"{a['Identifier']}: {key}={val} outside the supported 500-10000ms range (silently clamped)")

if not seen_agent_block:
    failures.append("no ConnectParticipantWithLexBot action found — the AI agent block is missing")

if failures:
    for f in failures:
        print("FAIL: " + f, file=sys.stderr)
    sys.exit(1)
print("PASS: no global end-of-turn override; barge-in left enabled")
PY
