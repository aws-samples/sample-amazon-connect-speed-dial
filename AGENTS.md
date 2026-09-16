# AGENTS.md — guidance for coding assistants

Canonical steering for any AI coding assistant (Claude Code, Kiro, Cursor, Copilot, Codex, …)
working in this repo. Human contributors: see `README.md`. Skill runtime behavior: see `SKILL.md`.

## What this repository is

This is **not a deployable application** — it is a **skill** (a Claude Code / Kiro skill) that
*scaffolds and deploys* an Amazon Connect contact center with a Nova Sonic 2 AI voice agent.

- `SKILL.md` is the orchestration entry point: it drives an interactive, six-phase flow
  (gather inputs → preflight → render → deploy → optional UK DID claim → smoke test).
- `templates/cdk-app/` holds a **CDK project template** full of placeholders.
- At runtime the skill **renders** that template into a fresh project directory in the user's
  working dir (`csp-<projectName>`, e.g. `csp-finalreview/`),
  then runs `cdk deploy` *inside that rendered directory*.

So there are two layers, and keeping them straight is the single most important thing:

| Layer | Path | Edit it? |
|---|---|---|
| **Template (source of truth)** | `templates/cdk-app/` | ✅ Yes — all infra changes go here |
| **Rendered project (generated output)** | `csp-<projectName>/` (e.g. `csp-finalreview/`) | ❌ No — clobbered on next render |

## The golden rule

**Make every infrastructure/CDK change in `templates/cdk-app/`, never in a rendered project dir.**

Rendered dirs (`csp-finalreview/`, `csp-deployment-test/`, …) are throwaway output of
the render step (`csp render`). Editing them directly is almost always a mistake: the next render
overwrites your work, and the change never reaches the template that real users get. (This bites
even careful agents — a temp edit to a rendered file silently disappears on the next render.)

You *may* read a rendered dir to inspect deployed state (e.g. `csp-<projectName>/cdk-outputs.json`
for resource IDs), but write changes to the template.

## The render → deploy → validate loop

After editing anything under `templates/cdk-app/`:

```bash
# 0. Once per checkout: install the CLI's dependencies. There is no launcher
#    script that does this for you — `csp` is an npm script in cli/package.json,
#    and it deliberately does not self-install.
npm --prefix cli run setup
# Shorthand for the rest of this file. --silent keeps npm's banner off stdout;
# the trailing -- hands the remaining flags to the CLI instead of to npm.
csp() { npm --silent --prefix cli run csp -- "$@"; }

# 1. Derive values from the order file, then render the template into the
#    project dir (substitutes {{key}} placeholders)
csp values .connect-skill-order.<projectName>.json csp-<projectName>/.connect-skill-values.json
csp render csp-<projectName>/.connect-skill-values.json templates/cdk-app csp-<projectName>

# 2. npm ci + type-check + synth (no deploy) — catches most errors cheaply
csp synth csp-<projectName> <region>

# 3. Deploy a single stack (preferred while iterating) …
cd csp-<projectName>
npx cdk deploy <projectName>-Wisdom --require-approval never --outputs-file cdk-outputs.json
# … or all stacks, region-pinned with an outputs file:
csp cdk-deploy csp-<projectName> <region>
```

For repo-level validation that exercises every capability combination, run the test matrix
(render + synth + assertions for `customerProfilesEnabled` on/off):

```bash
tests/test-all-capabilities.sh
```

**Some service constraints only surface at `cdk deploy`, not at synth** (e.g. Q in Connect
rejecting a tool config). When validating a change against live AWS, deploy the affected stack
and read the result back with the AWS CLI rather than trusting synth alone. Failed stack updates
roll back cleanly, but a rollback can also revert console-made changes to the same resource — be
aware of that interplay.

## Placeholder conventions (two systems — don't confuse them)

1. **`{{key}}`** — render-time. Substituted by `csp render` from
   `.connect-skill-values.json` (produced by `csp values` from
   `.connect-skill-order.json`). Used in `.ts` (outside `lib/config.ts`), `package.json`, etc.
   Example: `{{projectName}}`, `{{companyName}}`. Deployment flags for the CDK app itself
   (`prefix`, capability booleans, `promptLanguage`, `connectWidgets`) do **not** use `{{...}}`
   — they live in `lib/deployment-values.json`, which `csp render` overwrites and
   `lib/config.ts` imports directly. The checked-in JSON ships with `prefix: ""`, and
   `resolvePrefix()` throws on an empty prefix so an unrendered template fails loudly.
2. **`__PROP__`** — CDK synth-time. Used only in `flows/*.json`. Substituted by
   `contact-flow-stack.ts` from cross-stack values (ARNs, names) that aren't known until synth —
   e.g. `__QUEUE_ARN__`, `__ORCHESTRATION_AGENT_ARN__`, `__LEX_BOT_ALIAS_ARN__`.
   (`__DATA_TABLE_ID__` and `__GET_CUSTOMER_PROFILE_MODULE_ID__` are the late-bound
   cases: they are substituted at synth, once the resources they reference exist —
   see `contact-flow-stack.ts`.)

## Capabilities

Human transfer (Escalate → human-transfer queue), tool calling (sample tool Lambda + the
AgentCore gateway's MCP tools wired into the orchestration agent), and storage encryption
(customer-managed KMS key) are ALWAYS on — they ship built into the default contact flow and
stacks and have no config flags (dynamically toggling them kept breaking the backend wiring).

Call recording **ships as a module, not wired into the default flow**: the deploy always
creates the `consent-analytics-setup` contact-flow module (DTMF/view consent gate that records
Agent + Customer and enables Contact Lens analytics on consent), but the base flow's only
`InvokeFlowModule` targets `get-customer-profile` — so recording is off out of the box. To
enable it, add an `InvokeFlowModule` step referencing the module to the base flow (see README
"Capabilities").

Optional capability flags in `lib/config.ts`, set from the user's order (all seven booleans in
`cli/src/core/schema.ts`; defaults in parentheses):

- `customerProfilesEnabled` (`true`) — Customer Profiles domain + caller lookup in the flow.
- `frontendEnabled` (`false`) — deploys the web-call frontend (CloudFront + Cognito + API Gateway).
- `dataLakeEnabled` (`false`) — enables the Connect analytics data lake.
- `contactEventsEnabled` (`false`) — EventBridge rule + Lambda logging contact lifecycle events.
- `knowledgeBaseEnabled` (`false`) — Bedrock Managed Knowledge Base wired to the assistant.
- `identityCenterEnabled` (`false`) — IAM Identity Center (SAML) sign-in, fixed at instance creation.
- `retainData` (`true`) — data-bearing resources survive `cdk destroy`.

The base flow is `flows/basic-agent-flow.json`, deployed as-is with only ARN/name placeholder
substitution (the composable synth-time transforms in `lib/flow-compose.ts` are disabled).

> The old three-flavor system (qa / transfer / tool) is **gone** — don't reintroduce it. If you
> see "flavor" anywhere, it's stale.

## Stacks (rendered project, deployed to the selected region)

`bin/connect-blueprint.ts` wires these; stack IDs are `<projectName>-<Suffix>`:

ConnectInstance · Queues · Wisdom · ContactFlow · AgentCoreGateway · FlowLambdas · PostDeploy,
plus **ContactEvents** (only when `contactEventsEnabled`) and **WebcallWidget** (only when
`frontendEnabled`). The Lex V2 bot is part of the Wisdom stack — there is no separate LexBot
stack.

Naming flows through one `ResourceNamer` (`lib/config.ts`) keyed off `config.prefix` (=
`projectName`), so every physical name is prefixed deterministically. Use `this.namer.*` for
names; keep construct IDs prefix-free so logical IDs don't churn on rename.

## Where to look

- `SKILL.md` — the authoritative description of the six-phase flow and how the assistant
  drives the `csp` commands through it (the CLI itself is the contract for each step).
- `references/` — architecture deep-dives (`connect-ai-agent-block.md`, which also carries
  the captured AWS naming conventions, e.g. the AgentCore MCP tool integration) and
  `troubleshooting.md`. Captured-from-console knowledge lives here and in `SKILL.md`.
- `cli/` — the `csp` deployment CLI, the single implementation of the whole
  pipeline: pre-deploy (values/preflight/render/synth/cdk-deploy/deploy) AND post-deploy
  (init-prompts/claim-did/sync-kb/smoke-test/setup-widget/setup-test-users/
  teardown, all native AWS SDK); `npm --silent --prefix cli run csp -- --help`.
- `scripts/` — only `release-to-github.sh` (maintainer release helper); the old
  deployment scripts are gone, the CLI replaced them.
- `tests/` — `test-all-capabilities.sh`, `test-render-and-synth.sh`, `test-deploy-cli.sh`,
  and friends — all retargeted at the `csp` CLI. The CLI's own unit tests live in `cli/test/`
  (`cd cli && npm test`).

## Conventions

- **Region is user-selectable: `us-east-1` (Virginia, default) or `eu-central-1` (Frankfurt).**
  Both run the full Connect + Q in Connect + Lex + Nova Sonic voice stack. `region` is an
  `order.json` input; `csp values` derives the Bedrock inference-profile prefix from it
  (`us.*` vs `eu.*`) and emits language/voice values. It **also emits `region` to `values.json`**,
  which `csp render` hardcodes into the rendered `bin/connect-blueprint.ts`
  (`region: '<region>'`) so the CDK app is pinned to the selected region regardless of shell env.
  This is deliberate: relying on `CDK_DEFAULT_REGION` alone is fragile — if the inline env var
  fails to reach the node process, CDK silently falls back to the profile's region and deploys
  everything to the wrong place (e.g. us-east-1 with `eu.*` model IDs, which then fail QConnect
  validation as "not available in this region"). The same `region` value still drives
  `CDK_DEFAULT_REGION`/`AWS_REGION` and the `[region]` argument of the `csp` commands
  (`preflight`, `synth`, `cdk-deploy`, `claim-did`, `sync-kb`, `smoke-test`, `setup-widget`, `teardown`).
- Match surrounding code style. Lambda handler source lives under `templates/cdk-app/lambda/`
  (one folder per function, `index.py` / `index.ts`); stacks reference them via
  `lambda.Code.fromAsset(...)`. Edit the handler source there, not in any rendered copy.
- Never echo or commit secrets (widget signing keys, generated user passwords).
- Idempotency: the `csp` commands are written to be safely re-runnable; preserve that.

### CLI structure (`cli/src/`)

Four directories, by layer. Nothing but the two entry points sits at the top level:

```
src/
  main.ts        entry point — execs the command tree, nothing else
  program.ts     the command tree (a factory: importing it must not parse argv)
  commands/      one module per csp command, plus its <command>.live.ts wiring
                 render/ is a subfolder (render, text, prompts)
  core/          contracts and domain logic, no I/O — ports, schema, prefs
  adapters/      one module per AWS SDK client; the only @aws-sdk/* importers
  lib/           cross-cutting utilities — errors, ui, proc
```

A command's name maps to its file: `csp setup-test-users` → `commands/setupTestUsers.ts`
(pure, ports-injected) + `commands/setupTestUsers.live.ts` (real wiring). Test doubles are
never in `src/` — the fakes live beside the tests in `cli/test/`.

Four rules, in order. Every command follows them; a new one should too.

1. **Commands are functions over ports.** A command takes its collaborators as a final
   `aws` argument typed against interfaces from `cli/src/core/ports.ts`. It never imports
   `@aws-sdk/*` and never spawns a process. Declare only the methods you use
   (`Pick<PhoneNumbers, 'listClaimed'>`), so a fake stays small and a reader can see the
   command's whole reach at a glance.
2. **No sentinel values.** A port returns the real answer or throws. Deciding that a
   failure is "a failed check" rather than fatal is the *command's* job — see
   `smokeTest`'s `attempt()`. Adapters that swallow errors turn an `AccessDenied` into a
   wrong diagnosis; the only permitted swallow is one where absence is genuinely the
   answer (`Stacks.exists`, `UserPool.getUser`), and it must match on the specific error.
3. **Policy lives in the command, not the adapter.** `'GB'`, `'DID'`, `MaxResults: 5`,
   poll intervals, retain lists — named constants in the command, passed as arguments.
   Adapters translate; they do not decide. This is what makes policy testable.
4. **Commands return data; one renderer prints it.** `smokeTest` → `SmokeTestReport` +
   `renderReport()`. Tests then assert data, not console transcripts.

Wiring lives in `<command>.live.ts`: it resolves the region, does the file I/O,
dynamically imports the adapters, calls the command, prints, and decides the exit code.
`program.ts` imports only the `*Live` function. That indirection is load-bearing —
statically importing the AWS SDK from the entry path costs ~99 ms per client pair against
a ~200 ms `csp --help`, so `cli/test/startup-cost.test.ts` fails the build if `main.ts`,
`program.ts`, or any `*.live.ts` reaches an adapter or `@aws-sdk/*` statically.

Adapters live one-per-SDK-client in `cli/src/adapters/`, construct their client once,
and hold the only static `@aws-sdk/*` imports in the repo.

**Validate where data enters the program, not at every hop.** The entry points are
files and argv; everything downstream of a validated read is already trustworthy, and
re-checking it is noise that hides where the real guarantee comes from.

- Files: `readJsonObject()` (must be a JSON object) and `readCdkOutputs()` /
  `parseCdkOutputs()` (must be stack → key → string) are zod-backed and used by every
  reader. `cdk-outputs.json` alone is read from four places and was previously an
  unchecked `as CdkOutputs` cast, so a truncated file surfaced as an undefined id far
  downstream.
- argv: `claimDid` zod-checks its ids, because commander guarantees a required argument
  is *present*, not that it is non-empty.
- Order files are validated by `parseOrder` (`schema.ts`), NOT by zod, and deliberately:
  every one of its messages is a product contract asserted by `schema.test.ts`
  (`invalid projectName 'x': …`, the companyName character rule). Expressing those in
  zod means a custom message per field anyway, so it would add indirection without
  removing a line — and TypeScript already prevents `Order` drifting from what
  `parseOrder` builds. If you extend the order schema, extend `parseOrder`.
- Commands do NOT re-validate what a validated reader handed them (`smokeTest` takes a
  plain interface). Where a guarantee comes from should be obvious from one place.
