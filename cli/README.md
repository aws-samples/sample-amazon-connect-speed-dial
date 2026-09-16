# csp — deployment CLI

The single implementation of the Connect blueprint deployment pipeline — there is no
bash or Python left in it.

There is no launcher script. The CLI is two npm scripts in `package.json`:
`setup` installs its dependencies (`npm ci`), and `csp` runs it. Install once,
then invoke from anywhere:

    npm --prefix cli run setup                # once per checkout
    npm --silent --prefix cli run csp -- deploy

`--silent` keeps npm's banner off stdout, `--prefix` locates this package from
any directory, and `--` hands the remaining flags to the CLI instead of to npm.
Relative path arguments resolve against *your* directory, not `cli/`. Defining a
shell function makes the examples below work verbatim:

    csp() { npm --silent --prefix cli run csp -- "$@"; }

    csp deploy                                # interview → full deployment
    csp deploy --order-file o.json --yes      # headless (e2e)
    csp values|preflight|render|synth|cdk-deploy …   # step commands
    csp redeploy csp-<name>                   # re-render + redeploy
    csp --help                                # everything else

- The six step commands (`values`, `render`, `preflight`, `synth`, `cdk-deploy`,
  `validate-prompts`) accept `--json` to emit a machine-readable result object
  as the last stdout line. The post-deploy commands do not take the flag.
- `csp deploy` takes `--claim-uk-did` and `--kb-content <pathOrSample>` as
  overrides of the order file's orchestration prefs (claim a UK number after
  deploy; ingest KB content from a path, or `sample` for the bundled data).
- Post-deploy commands (`init-prompts`, `claim-did`, `sync-kb`, `smoke-test`,
  `setup-widget`, `setup-test-users`, `teardown`) are native AWS SDK — no
  bash is invoked anywhere in the pipeline anymore.
- The old `scripts/` entry points were removed in stage 3 — invoke the `csp`
  npm script directly.
- `csp smoke-test <project-dir>` reads the instance/flow/assistant/agent ids
  from the project's `cdk-outputs.json`; `--no-did-expected` treats "no DID
  claimed" as a pass instead of a failure (for stacks deployed without a
  phone number).
- `csp setup-test-users <project-dir>` takes named options: `--user --first
  --last --email --locale` (required) plus `--phone --customer-number`
  (required only when Customer Profiles is enabled).
- `csp teardown` keeps the typed project-name confirmation; set
  `FORCE_TEARDOWN=1` to skip it in automation.
- The bash-parity harness was retired in stage 3; the CLI is validated by its
  unit tests plus the integration suites under `tests/`.
- Unit tests: `cd cli && npm test`. No AWS credentials or network needed.
- `csp preflight` requires `--bootstrap` to run `cdk bootstrap` (the old
  script did it silently).
- `csp preflight` checks CDK availability (`cdk` on PATH, else
  `npx --no-install cdk`) and fails with install guidance otherwise, matching
  the legacy script's "Checking CDK installation" step.
