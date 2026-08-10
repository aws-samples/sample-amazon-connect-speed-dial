#!/usr/bin/env bash
set -euo pipefail

# test-flow-profile-miss.sh — a customer-profile miss must never hang up on the
# caller, and must not cost personalization when the profile IS found.
#
# Regression guard: get-customer-profile returns the literal sentinel '#unknown'
# in ResultData on its unknown branch. basic-agent-flow.json passed that straight
# into UpdateContactData.LanguageCode, which rejects it — the flow then fell
# through to an empty error prompt and Disconnect ~1.5s in, before the AI agent
# block. Every anonymous caller (anyone not in Customer Profiles) was hung up on
# in silence, and every e2e conversation test failed its first observation.
#
# Asserted on the flow graph rather than a live call: cheap, deterministic, and it
# fails on the exact edit that would reintroduce the bug.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLOW="$ROOT/templates/cdk-app/flows/basic-agent-flow.json"

python3 - "$FLOW" <<'PY' || exit 1
import json, sys

flow = json.load(open(sys.argv[1]))
acts = {a['Identifier']: a for a in flow['Actions']}
INVOKE = '990357be-823d-409a-b931-887c2c7df9d4'   # InvokeFlowModule get-customer-profile
failures = []

def walk(start, first_hop):
    """Follow NextAction from `start` via `first_hop`; return the action types seen."""
    seen, path, cur = set(), [], first_hop
    while cur and cur in acts and cur not in seen:
        seen.add(cur)
        a = acts[cur]
        path.append(a['Type'])
        if a['Type'] in ('DisconnectParticipant', 'ConnectParticipantWithLexBot'):
            break
        cur = a.get('Transitions', {}).get('NextAction')
    return path

t = acts[INVOKE]['Transitions']
branches = {c['Condition']['Operands'][0]: c['NextAction'] for c in t['Conditions']}
branches['<default>'] = t['NextAction']
for e in t['Errors']:
    branches['err:' + e['ErrorType']] = e['NextAction']

# 1. EVERY branch out of the profile lookup must reach the AI agent, never a
#    disconnect. 'success', 'unknown', 'multiple', the default, and the error
#    transitions (the last of which is what a non-imported placeholder module hits).
for name, target in branches.items():
    path = walk(INVOKE, target)
    if 'ConnectParticipantWithLexBot' not in path:
        failures.append(f"branch {name!r} never reaches the AI agent: {' -> '.join(path)}")
    if 'DisconnectParticipant' in path:
        failures.append(f"branch {name!r} disconnects the caller: {' -> '.join(path)}")

# 2. No branch may feed a module ResultData reference into LanguageCode unless it
#    is the success branch — that is the sentinel bug.
for name, target in branches.items():
    if name == 'success':
        continue
    cur, seen = target, set()
    while cur and cur in acts and cur not in seen:
        seen.add(cur)
        a = acts[cur]
        if a['Type'] == 'UpdateContactData':
            lang = a['Parameters'].get('LanguageCode', '')
            if 'Modules.ResultData' in lang:
                failures.append(
                    f"branch {name!r} passes {lang!r} to LanguageCode; on a miss that is "
                    "the literal '#unknown' and the action errors")
        if a['Type'] in ('DisconnectParticipant', 'ConnectParticipantWithLexBot'):
            break
        cur = a.get('Transitions', {}).get('NextAction')

# 3. The success branch must KEEP personalization — the point of the lookup.
#    Guards against "fixing" this by deleting the feature.
succ, seen = branches.get('success'), set()
found_personalization = False
while succ and succ in acts and succ not in seen:
    seen.add(succ)
    a = acts[succ]
    if a['Type'] == 'UpdateContactAttributes':
        attrs = a['Parameters'].get('Attributes', {})
        if any(k in attrs for k in ('FirstName', 'LastName', 'CustomerNumber')):
            found_personalization = True
    if a['Type'] in ('DisconnectParticipant', 'ConnectParticipantWithLexBot'):
        break
    succ = a.get('Transitions', {}).get('NextAction')
if not found_personalization:
    failures.append("success branch sets no FirstName/LastName/CustomerNumber — "
                    "profile personalization was dropped instead of guarded")

if failures:
    for f in failures:
        print("FAIL: " + f, file=sys.stderr)
    sys.exit(1)
print(f"PASS: all {len(branches)} profile-lookup branches reach the agent; "
      "success keeps personalization")
PY
