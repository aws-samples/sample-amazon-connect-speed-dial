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
  working dir (named after their `projectName`, e.g. `finalreview/`, `deployment-test/`),
  then runs `cdk deploy` *inside that rendered directory*.

So there are two layers, and keeping them straight is the single most important thing:

| Layer | Path | Edit it? |
|---|---|---|
| **Template (source of truth)** | `templates/cdk-app/` | ✅ Yes — all infra changes go here |
| **Rendered project (generated output)** | `<projectName>/` (e.g. `finalreview/`) | ❌ No — clobbered on next render |

## The golden rule

**Make every infrastructure/CDK change in `templates/cdk-app/`, never in a rendered project dir.**

Rendered dirs (`finalreview/`, `deployment-test/`, `abnahmetest/`, …) are throwaway output of
`scripts/render-templates.sh`. Editing them directly is almost always a mistake: the next render
overwrites your work, and the change never reaches the template that real users get. (This bites
even careful agents — a temp edit to a rendered file silently disappears on the next render.)

You *may* read a rendered dir to inspect deployed state (e.g. `<projectName>/cdk-outputs.json`
for resource IDs), but write changes to the template.

## The render → deploy → validate loop

After editing anything under `templates/cdk-app/`:

```bash
# 1. Render the template into the project dir (substitutes {{key}} placeholders)
./scripts/render-templates.sh \
  "$(pwd)/.connect-skill-values.json" \
  "$(pwd)/templates/cdk-app" \
  "$(pwd)/<projectName>"

# 2. Type-check + synth (no deploy) — catches most errors cheaply
cd <projectName>
npx tsc --noEmit -p tsconfig.json
CDK_DEFAULT_ACCOUNT=<acct> CDK_DEFAULT_REGION=us-east-1 npx cdk synth

# 3. Deploy a single stack (preferred while iterating) or all
npx cdk deploy <projectName>-Wisdom --require-approval never --outputs-file cdk-outputs.json
```

For repo-level validation that exercises every capability combination, run the test matrix
(render + synth + assertions for `transferEnabled` × `toolEnabled`):

```bash
tests/test-all-capabilities.sh
```

**Some service constraints only surface at `cdk deploy`, not at synth** (e.g. Q in Connect
rejecting a tool config). When validating a change against live AWS, deploy the affected stack
and read the result back with the AWS CLI rather than trusting synth alone. Failed stack updates
roll back cleanly, but a rollback can also revert console-made changes to the same resource — be
aware of that interplay.

## Placeholder conventions (two systems — don't confuse them)

1. **`{{key}}`** — render-time. Substituted by `render-templates.sh` from
   `.connect-skill-values.json` (produced by `scripts/build-values.sh` from
   `.connect-skill-order.json`). Used in `.ts`, `package.json`, etc. Example: `{{projectName}}`,
   `{{companyName}}`, `{{transferEnabled}}`. `resolvePrefix()` in `lib/config.ts` throws if a
   `{{...}}` survives to deploy time, so an unrendered template fails loudly.
2. **`__PROP__`** — CDK synth-time. Used only in `flows/*.json`. Substituted by
   `contact-flow-stack.ts` from cross-stack values (ARNs, names) that aren't known until synth —
   e.g. `__QUEUE_ARN__`, `__ORCHESTRATION_AGENT_ARN__`, `__LEX_BOT_ALIAS_ARN__`.
   (`__GREETING__` is the bridge case: it maps to the render-time `{{greeting}}`.)

## Capabilities (composable — not the old "flavors")

The contact center is composed from independent capability flags in `lib/config.ts`, set from
the user's order:

- `transferEnabled` — routes the agent's Escalate outcome to a human-transfer queue.
- `toolEnabled` — provisions the sample tool Lambda and wires the AgentCore gateway's MCP tools
  into the orchestration agent.
- `frontendEnabled` — deploys the web-call frontend (CloudFront + Cognito + API Gateway).

The transfer/tool branches are merged into the base flow (`flows/nova-sonic-base.json`) at synth
time (see `lib/flow-compose.ts`). Any combination (none / transfer / tool / both) is valid.

> The old three-flavor system (qa / transfer / tool) is **gone** — don't reintroduce it. If you
> see "flavor" anywhere, it's stale.

## Stacks (rendered project, deployed to the selected region)

`bin/connect-blueprint.ts` wires these; stack IDs are `<projectName>-<Suffix>`:

ConnectInstance · Queues · Wisdom · LexBot · ContactFlow · AgentCoreGateway · FlowLambdas ·
ContactEvents · PostDeploy, plus **WebcallWidget** (only when `frontendEnabled`).

Naming flows through one `ResourceNamer` (`lib/config.ts`) keyed off `config.prefix` (=
`projectName`), so every physical name is prefixed deterministically. Use `this.namer.*` for
names; keep construct IDs prefix-free so logical IDs don't churn on rename.

## Where to look

- `SKILL.md` — the authoritative description of the six-phase flow and every script's contract,
  including the captured AWS naming conventions (e.g. the AgentCore MCP tool integration).
- `references/` — architecture deep-dives (`connect-ai-agent-block.md`) and
  `troubleshooting.md`. Captured-from-console knowledge lives here and in `SKILL.md`.
- `scripts/` — `build-values.sh`, `render-templates.sh`, `preflight.sh`, `smoke-test.sh`,
  `claim-uk-did.sh`, `setup-widget.sh`, `create-webcall-user.sh`, `redeploy.sh`.
- `tests/` — `test-all-capabilities.sh`, `test-render-and-synth.sh`, `test-build-values.sh`.

## Conventions

- **Region is user-selectable: `us-east-1` (Virginia, default) or `eu-central-1` (Frankfurt).**
  Both run the full Connect + Q in Connect + Lex + Nova Sonic voice stack. `region` is an
  `order.json` input; `build-values.sh` derives the Bedrock inference-profile prefix from it
  (`us.*` vs `eu.*`) and emits language/voice values. It **also emits `region` to `values.json`**,
  which `render-templates.sh` hardcodes into the rendered `bin/connect-blueprint.ts`
  (`region: '<region>'`) so the CDK app is pinned to the selected region regardless of shell env.
  This is deliberate: relying on `CDK_DEFAULT_REGION` alone is fragile — if the inline env var
  fails to reach the node process, CDK silently falls back to the profile's region and deploys
  everything to the wrong place (e.g. us-east-1 with `eu.*` model IDs, which then fail QConnect
  validation as "not available in this region"). The same `region` value still drives
  `CDK_DEFAULT_REGION`/`AWS_REGION` and the `[region]` argument of the helper scripts
  (`preflight`, `claim-uk-did`, `smoke-test`, `setup-widget`, `create-webcall-user`).
- Match surrounding code style; the inline Lambda handlers live as template strings inside the
  stack `.ts` files — edit them there, not in any rendered copy.
- Never echo or commit secrets (widget signing keys, generated user passwords).
- Idempotency: the scripts are written to be safely re-runnable; preserve that.
