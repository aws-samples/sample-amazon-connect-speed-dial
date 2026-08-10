#!/usr/bin/env bash
set -euo pipefail

# test-sap-normalize.sh — normalize_order_number (SAP customer/order id) must
# handle conventionally-formatted numbers and reject out-of-range ones, so a
# tool lookup does not silently miss on a valid-but-wrong id.
#
# Root cause this guards (found on a live de-DE call): a German-locale voice
# model formats numbers with grouping separators, and the caller/ASR can add
# stray digits. The old normalizer stripped separators then blind zero-padded,
# so a >10-digit or mis-grouped value became a different, valid-looking id and
# the DynamoDB query missed. The function is embedded as inline Python inside
# agentcore-gateway-stack.ts (twice: the runtime tool and the ingest handler);
# this extracts the runtime copy and exercises it directly, so a regression in
# the real shipped code is caught rather than a paraphrase.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK="$ROOT/templates/cdk-app/lib/agentcore-gateway-stack.ts"

python3 - "$STACK" <<'PY'
import re, sys, types

src = open(sys.argv[1]).read()

# Pull the runtime SAP tool handler (the first inline Python block) and grab
# just the normalize_order_number def out of it.
m = re.search(r'const SAP_ORDER_TOOL_HANDLER = `(.*?)`;', src, re.S)
assert m, "SAP_ORDER_TOOL_HANDLER inline code not found"
handler = m.group(1)
fn = re.search(r'\ndef normalize_order_number\(raw\):.*?(?=\n\ndef )', handler, re.S)
assert fn, "normalize_order_number not found in the tool handler"

mod = types.ModuleType("sap_norm")
mod.re = re
exec(fn.group(0), mod.__dict__)
normalize = mod.normalize_order_number

CANON = '0000100042'   # seeded customer 100042
cases = [
    # (input, expected, note)
    ('100042',       CANON, 'plain digits (English happy path)'),
    ('0000100042',   CANON, 'already padded'),
    ('100.042',      CANON, 'German grouping separator'),
    ('100 042',      CANON, 'space grouping'),
    ('Kundennummer 100042', CANON, 'spoken prefix'),
    ('0000012345',   '0000012345', 'seeded order number'),
    ('12345',        '0000012345', 'order, unpadded'),
    ('',             '', 'empty'),
    (None,           '', 'none'),
    # Out of range: must be REJECTED, not truncated to a valid-but-wrong id.
    ('12345678901',  '', '11 digits -> rejected (was silently truncated before)'),
    ('1.000.000.0429','', 'over-grouped to 11 digits -> rejected'),
]
fails = []
for raw, exp, note in cases:
    got = normalize(raw)
    ok = got == exp
    print(f"  {'ok ' if ok else 'BAD'} {str(raw)!r:22s} -> {got!r:14s} (expect {exp!r}) — {note}")
    if not ok:
        fails.append(f"{raw!r}: got {got!r}, expected {exp!r} ({note})")

# Honesty check: a wrong DIGIT COUNT (extra zero) is NOT recoverable here and
# this test does not pretend otherwise — 1000042 is a valid 7-digit id and
# pads to a different customer. Documented as an upstream problem, asserted so
# nobody later "fixes" the normalizer to mangle it into 100042.
assert normalize('1000042') == '0001000042', "7-digit input should pad as-is, not be guessed into 100042"

if fails:
    print("\nFAIL:", file=sys.stderr)
    for f in fails:
        print("  " + f, file=sys.stderr)
    sys.exit(1)
print("PASS: normalize handles grouping + rejects overflow; wrong-digit-count left to upstream")
PY
