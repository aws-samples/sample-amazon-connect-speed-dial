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
# the DynamoDB query missed. The function ships in two handlers (the runtime
# tool lambda/tools/sap-order and the ingest lambda/tools/sap-document-ingest,
# which must stay behaviourally identical — write side and query side share
# the DynamoDB key format); this exercises BOTH copies directly, so a
# regression or divergence in the real shipped code is caught.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="$ROOT/templates/cdk-app/lambda/tools"

python3 - "$TOOLS_DIR" <<'PY'
import re, sys, types

tools_dir = sys.argv[1]

def load_normalize(handler_path):
    src = open(handler_path).read()
    fn = re.search(r'\ndef normalize_order_number\(raw\):.*?(?=\n\ndef )', src, re.S)
    assert fn, f"normalize_order_number not found in {handler_path}"
    mod = types.ModuleType("sap_norm")
    mod.re = re
    exec(fn.group(0), mod.__dict__)
    return mod.normalize_order_number

normalizers = {
    'sap-order (query side)': load_normalize(f"{tools_dir}/sap-order/index.py"),
    'sap-document-ingest (write side)': load_normalize(f"{tools_dir}/sap-document-ingest/index.py"),
}

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
for name, normalize in normalizers.items():
    print(f"-- {name}")
    for raw, exp, note in cases:
        got = normalize(raw)
        ok = got == exp
        print(f"  {'ok ' if ok else 'BAD'} {str(raw)!r:22s} -> {got!r:14s} (expect {exp!r}) — {note}")
        if not ok:
            fails.append(f"{name} / {raw!r}: got {got!r}, expected {exp!r} ({note})")

    # Honesty check: a wrong DIGIT COUNT (extra zero) is NOT recoverable here and
    # this test does not pretend otherwise — 1000042 is a valid 7-digit id and
    # pads to a different customer. Documented as an upstream problem, asserted so
    # nobody later "fixes" the normalizer to mangle it into 100042.
    assert normalize('1000042') == '0001000042', \
        f"{name}: 7-digit input should pad as-is, not be guessed into 100042"

if fails:
    print("\nFAIL:", file=sys.stderr)
    for f in fails:
        print("  " + f, file=sys.stderr)
    sys.exit(1)
print("PASS: both copies handle grouping + reject overflow; wrong-digit-count left to upstream")
PY
