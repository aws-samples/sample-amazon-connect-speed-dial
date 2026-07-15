#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# args: transferEnabled toolEnabled [contextInjectionEnabled] [recordingEnabled] [encryptionEnabled]
# encryptionEnabled defaults to true, so the cases below exercise the on-path; the
# last case flips it off.
"$DIR/test-render-and-synth.sh" false false              # base Q&A only (encryption on by default)
"$DIR/test-render-and-synth.sh" true  false              # + human transfer
"$DIR/test-render-and-synth.sh" false true               # + tool calling
"$DIR/test-render-and-synth.sh" true  true               # + transfer & tool
"$DIR/test-render-and-synth.sh" false false true         # + context injection only
"$DIR/test-render-and-synth.sh" false true  true         # + tool calling & context injection
"$DIR/test-render-and-synth.sh" false false false true   # + call recording only
"$DIR/test-render-and-synth.sh" true  true  true  true   # + everything (encryption + profiles on by default)
"$DIR/test-render-and-synth.sh" false false false false false  # encryption OFF
# args: transfer tool context recording encryption customerProfiles
"$DIR/test-render-and-synth.sh" false false false false true  false  # customer profiles OFF
"$DIR/test-region-language.sh"
echo "PASS: all capability combinations"
