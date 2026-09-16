#!/usr/bin/env bash
# Shared container-runtime guard for the synth suites.
#
# CDK asset bundling (the boto3 Lambda layer) runs in a container. Without a
# runtime, `cdk synth` dies with a bare "spawnSync docker ENOENT" inside a
# LayerVersion stack trace, which reads like a blueprint defect but is purely a
# missing local dependency. Mirror csp deploy's resolution order — explicit
# CDK_DOCKER, then docker, then Finch — and say so plainly if neither is
# available, instead of failing 200 lines later for the wrong reason.
#
# Usage:  require_container_runtime   # exits 0 with a SKIP message if none
#
# Sourced by tests/test-render-and-synth.sh and tests/test-capability-flags.sh;
# `exit 0` inside a sourced function exits the calling script, which is the
# intended "skip this suite" behavior.
require_container_runtime() {
  [[ -n "${CDK_DOCKER:-}" ]] && return 0

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    return 0   # docker daemon is up; CDK's default works
  fi

  if command -v finch >/dev/null 2>&1; then
    if [[ "$(finch vm status 2>/dev/null)" != "Running" ]]; then
      echo "SKIP: Finch VM is not running — start it with 'finch vm start' (or 'finch vm init'), or start Docker Desktop" >&2
      exit 0
    fi
    CDK_DOCKER="$(command -v finch)"
    export CDK_DOCKER
    echo "using Finch as the container runtime (CDK_DOCKER=$CDK_DOCKER)"
    return 0
  fi

  echo "SKIP: no container runtime for CDK asset bundling — start Docker Desktop or install Finch (brew install finch)" >&2
  exit 0
}
