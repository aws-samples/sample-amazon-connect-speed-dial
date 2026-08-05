#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# args: [customerProfilesEnabled]
# Human transfer, tool calling, call recording, and storage encryption are
# always on — every case exercises them; only customer profiles is toggleable.
"$DIR/test-render-and-synth.sh" true   # customer profiles ON (default)
"$DIR/test-render-and-synth.sh" false  # customer profiles OFF
"$DIR/test-region-language.sh"
echo "PASS: all capability combinations"
