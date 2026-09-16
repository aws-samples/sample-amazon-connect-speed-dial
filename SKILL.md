---
name: connect-bootstrap
description: Use when the user wants to set up an Amazon Connect contact center with a Nova Sonic 2 AI voice agent. Scaffolds a CDK project with built-in human transfer and tool calling (plus a ready-made recording-consent module), deploys, claims a UK DID, and runs smoke test. Triggers on "set up Amazon Connect", "create a Connect instance", "deploy a Nova Sonic agent", "Connect AI agent blueprint".
---

# Amazon Connect Nova Sonic Blueprint

This skill deploys a complete Amazon Connect contact center with a Nova Sonic 2 AI voice agent and runs smoke tests. The deployment includes a Connect instance, Q in Connect AI agent with two Bedrock agents (orchestrator + self-service), and a contact flow with built-in human transfer and tool calling. Call recording ships as a deployed-but-unwired consent module (see the Sides course below).

By default the skill claims a **UK DID** (a `+44` direct-inward-dial number) — UK DIDs have the lightest regulatory footprint of the supported regions (no business-address bundle at claim time), so the flow can complete unattended. For a number in another country, or to pick a specific number, skip the claim phase and claim manually in the Connect console (see "Manual phone number" in Phase 5).

## Overview

The skill has two layers:

1. **The template** — `templates/cdk-app/` is the CDK app that gets rendered and deployed. Never edit rendered `csp-*/` project dirs; edit the template. Full guidance: `AGENTS.md` (the golden rule, placeholder conventions, capabilities, stacks).
2. **The `csp` CLI** — the `cli/` package is the single implementation of the deployment pipeline (pre- and post-deploy, all native AWS SDK). See `cli/README.md`. There is no launcher script — `csp` is an npm script — so in every command below, `csp` means `npm --silent --prefix <skill-dir>/cli run csp --`; always resolve paths from `<skill-dir>`, never hard-code them. Keep `--silent` (it keeps npm's banner off stdout) and the trailing `--` (it hands the remaining flags to the CLI rather than to npm). **Run `npm --prefix <skill-dir>/cli run setup` once before the first `csp` command** — it installs the CLI's dependencies, and nothing else does it for you.

**Your job as the assistant:** run the Phase 1 interview conversationally (the menu below), write the order file yourself, then drive the remaining phases by running `csp` commands — **1 Gather inputs** (interview → `.connect-skill-order.<projectName>.json`) · **2 Preflight** (`csp preflight`) · **3 Render** (`csp values` + `csp render`) · **4 Deploy** (`csp synth` + `csp cdk-deploy`) · **5 Claim UK DID**, optional (`csp claim-did`) · **6 Smoke test** (`csp smoke-test`).

The pipeline step commands (`values`, `render`, `preflight`, `synth`, `cdk-deploy`, `validate-prompts`) accept `--json` to emit a machine-readable result object as the last stdout line — prefer it when you need to parse outcomes. The post-deploy commands (`claim-did`, `sync-kb`, etc.) do not take the flag. **Hands-off alternative:** once the order file exists, `csp deploy --order-file <file> --yes` runs phases 2–6 (plus DID claim and KB sync per the order's prefs) in one shot and prints next-steps guidance. Use it when the user wants no per-phase interaction; the step-by-step path gives better conversational checkpoints.

## Phase 1: Gather Inputs

This phase uses a **menu-driven UX** organized as restaurant-style courses. Each course leads with a sensible default and is skippable. Use the AskUserQuestion tool to collect values **one at a time** (do not ask multiple questions in one prompt).

### Aperitif — Pace Selector

Ask: "How would you like to set up your contact center?"

Options:
- **The usual** (express path) — Smart defaults; just name it and go (~2 questions)
- **Walk me through it** — Pick your options course by course

If "The usual" is chosen, skip to the Starter (project name only) and AWS account confirmation, accepting all other defaults. If "Walk me through it" is chosen, present each course below.

### Starter — Identity [Ready]

1. **Project name** (always asked, even in express mode)
   - Ask: "What would you like to name this project?"
   - Default: `connect-nova-sonic-blueprint`
   - Validate: lowercase alphanumeric + hyphens only, max 32 chars
   - Reject if: contains uppercase, special chars (except hyphen), or exceeds 32 chars
   - Store in order object as: `projectName`

In "Walk me through it" mode, also ask:

2. **Company name**
   - Ask: "Enter your company name (used in the AI agent prompt and the localized call prompts)."
   - Default: `My Company`
   - Must not contain backticks, `${`, or backslashes (`csp values` rejects them)
   - Store in order object as: `companyName`
   - What the agent *says* (greeting, persona) is governed by the agent prompts (next course) and the localized prompt-text seeds — there is no separate greeting question.

### Locale & region — Where & how it speaks [Ready]

Only offer this course in "Walk me through it" mode (express keeps the defaults: US/Virginia, English, feminine voice). Ask one question at a time via AskUserQuestion.

1. **Region**
   - Ask: "Where should this deploy?"
   - Options: **US (N. Virginia)** [default] / **Europe (Frankfurt)**
   - Store in order object as: `region` = `us-east-1` (US) or `eu-central-1` (Frankfurt)
   - Both regions run the full stack (Connect + Q in Connect + Lex + Nova Sonic voice). The Bedrock model profile is chosen automatically from the region (`us.*` vs `eu.*`).

2. **Language**
   - Ask: "What language should the agent speak?"
   - Options: **English** [default] / **German**
   - Store in order object as: `language` = `en` or `de`
   - Independent of region — any region × language combination is valid.

3. **Voice**
   - Ask: "Which voice?"
   - Options: **Feminine** [default] / **Masculine**
   - Store in order object as: `voiceGender` = `feminine` or `masculine`
   - Resolves to an Amazon Connect agentic voice used by the flow's Set-voice block (English → KATIE/RONALD, German → VIKTORIA/SEBASTIAN). The agentic catalog is disjoint from Polly's — Polly voice names are not valid under the `connect:agentic` engine.

### Aperitif side — Custom prompts [Ready, optional]

Only offer this course in "Walk me through it" mode (express keeps the default prompts).

Ask: "Want to customize the AI agent's prompts, or use the defaults?"

Options:
- **Use the defaults** (default) — the built-in orchestration and self-service prompts.
- **Customize** — tailor the orchestration prompt (the voice agent's persona/instructions) and/or the self-service prompt (how it answers from the knowledge base).

If "Customize" is chosen, first seed the editable prompt files: `csp init-prompts <cwd>` writes `<cwd>/prompts/orchestration.md` and `<cwd>/prompts/self-service.md` (the blueprint defaults; existing files are never clobbered). Then, for each prompt the user wants to change, show the current file contents and let them either:
- **Paste** a full replacement prompt, or
- **Describe** the persona/behavior they want — you draft the prompt, show it, and iterate until they approve.

Write the approved text back to the corresponding `<cwd>/prompts/*.md` file. **Preserve the required scaffolding** (the render step validates it via the prompt contract and aborts if it's missing; `csp validate-prompts <cwd>/prompts` checks standalone):
- `orchestration.md`: keep the `system:` block, `{{$.conversationHistory}}`, and the `<message>` formatting tag. `{{companyName}}` is substituted at render time; `{{$.locale}}` is a Q Connect runtime variable — leave it intact.
- `self-service.md`: keep `{{$.contentExcerpt}}` (where retrieved KB documents are injected).

These files are the source of truth and survive re-renders. If the user keeps the defaults, do nothing — the template's seed prompts are used automatically. Nothing is stored in the order JSON for prompts.

### Main — The agent's brain [Coming soon]

**These items are visible but NOT selectable.** Show them as preview content (e.g., "Model tier and voice/persona options coming in a future release") but do NOT ask about them or collect values. Skip to Sides.

Future items (for transparency only): **Model tier** (Balanced / Fast / Best), **Voice & persona** beyond the current agentic voices.

### Sides — Add-on capabilities [Multi-select]

First tell the user: "Human transfer and tool calling (a SAP SD order lookup API backed by DynamoDB) are always included — they ship built into the default contact flow. Call recording ships as a ready-made consent module (`consent-analytics-setup`: DTMF consent gate — press 1 to allow, 2 to decline; on consent the call is recorded Agent + Customer and Contact Lens analytics turn on). The module is deployed but **not wired into the default flow**, so recording is off out of the box; to enable it, add an `InvokeFlowModule` step referencing it to the base flow in the Connect flow designer (see README → Capabilities)."

Then ask: "Which add-on capabilities would you like? (You can choose multiple, or none.)"

Options (only these are selectable in this phase):
- **Customer Profiles** [Ready, default ON] — look the caller up in Customer Profiles and surface the profile to the agent via `{{$.Custom.*}}`. Looks up by caller phone number, then the web widget's identity (email, then account) — no fallback; unknown callers simply proceed anonymously. Defaults to **on** (the domain is already created by the instance). Deep-dive: `references/customer-profiles.md`.
- **Analytics data lake** [Ready] — enables the Connect analytics data lake, sharing contact records, flow events, and agent/contact statistics to a Glue database via Lake Formation; queryable with Athena. Off by default.
- **Contact-events logging** [Ready] — deploys an EventBridge rule + Lambda that logs contact lifecycle events (all DISCONNECTED events, any channel) as structured CloudWatch data. Off by default.
- **Knowledge base (RAG)** [Ready] — deploys a Bedrock Managed Knowledge Base (S3 Vectors store + data-source bucket) wired to the Q-in-Connect assistant; the self-service agent retrieves from it to ground answers. Off by default. **When selected, ask one follow-up:** "Where should the knowledge-base content come from? (a) the bundled sample document (a demo return policy), (b) a local folder you provide, (c) leave it empty for now — populate later." Store the choice as `kbContent` in the order file (see "The order file" below).

Future options (visible, NOT selectable): **Guardrails** [Coming soon], **External API tools (AgentCore)** [Coming soon].

Store selections in order object as:
- `customerProfilesEnabled` (boolean): **defaults to `true`** when omitted (unlike the other add-on flags, which default false). When enabled, the UpdateSessionContext Lambda resolves the caller's profile and injects identity data into the Q Connect session.
- `dataLakeEnabled` (boolean), `contactEventsEnabled` (boolean), `knowledgeBaseEnabled` (boolean): `true` if selected, `false` otherwise.
- `retainData` (boolean): **defaults to `true`** when omitted — data-bearing resources (Connect instance, storage/KB/schema/SAP buckets, KMS key, sap-orders table) survive `cdk destroy`. Set `false` only for disposable deployments (tests/demos). Not an interview question — omit unless the user explicitly asks for a fully deletable deployment.

### Drinks — Reach & operate

1. **Phone number** [Ready]
   - Ask: "How will you call it?"
   - Options:
     - **Claim a UK number** (default) — call in to test immediately → `frontendEnabled = false`, `claimUkDid = true`
     - **Web-call frontend** — browser-based calling (CloudFront + Cognito + API Gateway) → `frontendEnabled = true`, `claimUkDid = false` (web calling covers testing). Note to user: "The WebcallWidgetStack will deploy; after deployment you'll create a widget in the Connect console and I'll wire it up."
     - **I'll add a number myself** in the console → `frontendEnabled = false`, `claimUkDid = false`

2. **Observability dashboard** [Coming soon]
   - Visible, NOT selectable. Basic contact-events logging is always deployable; the full dashboard will be added in a future release.

### Digestif — Operational [Ready]

Inform (do NOT ask): "If you tear the stacks down later, the Connect instance and other data-bearing resources are **kept by default**." This is `retainData` in the order file — it defaults to `true` (instance, storage/KB/schema/SAP buckets, KMS key, and the sap-orders table survive `cdk destroy`; see the Sides course). It is not an interview question — set `retainData: false` in the order only if the user explicitly asks for a fully deletable test/demo deployment.

Then inform (do NOT ask): "Stored data (call recordings, chat transcripts, exported reports, Customer Profiles data) is always encrypted with a customer-managed KMS key." Encryption is NOT configurable — the blueprint always creates a CMK (with automatic annual rotation) and applies it to the storage bucket, the Connect storage configs, and the Customer Profiles domain; Connect storage only supports SSE_KMS. The key's removal policy follows `retainData`.

Then ask: "How should agents and admins sign in to Connect? (a) Connect-managed users (default) — usernames/passwords managed inside Connect, (b) IAM Identity Center SSO — sign in through your organization's Identity Center."

Default: `(a) Connect-managed` (accept default in express mode).

> ⚠️ **This choice is IRREVERSIBLE.** The identity management type is fixed at instance creation and can never be changed — switching later means destroying and recreating the entire Connect instance (losing users, claimed numbers, and configuration). Make sure the user understands this before proceeding.

- **(a) Connect-managed** — store `identityCenterEnabled: false` (default when omitted).
- **(b) Identity Center SSO** — store `identityCenterEnabled: true`, and immediately tell the user about the **mandatory manual step** that must be completed BEFORE deployment:

  1. Open the **IAM Identity Center** console → **Applications** → **Add application** → add the **Amazon Connect** catalog application (or a custom SAML 2.0 app)
  2. Download the **IAM Identity Center SAML metadata file** for that application
  3. Save it as **`saml-metadata.xml`** in the current working directory (next to the order file)

  The CDK synth creates the IAM SAML Provider from this file and **fails without it** — preflight (Phase 2) verifies it exists and blocks until then. Identity Center in a different account (e.g. org management) is fine — the SAML flow is browser-based, no cross-account IAM trust needed. Full guide: `references/identity-center-sso.md`.

### The Check — Order confirmation

After gathering all inputs, display a summary of the user's selections:

```
Your order:
  Project:      <projectName>
  Company:      <companyName>
  Sides:        Human transfer, tool calling (always included); recording-consent module (deployed, unwired)
  Profiles:     [Enabled] / [Disabled]     Data lake: [Enabled] / [Disabled]
  Events log:   [Enabled] / [Disabled]
  Knowledge:    [Sample data] / [Own content: <path>] / [Empty] / [Disabled]
  Sign-in:      [Connect-managed] / [Identity Center SSO — irreversible]
  Reach:        [UK phone number] / [Web-call frontend] / [Manual]
  Region:       <us-east-1 | eu-central-1>
  Language:     <English | German>  Voice: <Feminine | Masculine>
  Deploy to:    AWS account <accountId> (<region>)
```

For the account line, run `aws sts get-caller-identity` and show the account ID.

Ask: "Place this order?" If confirmed, write the order file.

### The order file

Write the order object to `.connect-skill-order.<projectName>.json` in the current working directory (the project-suffixed name lets multiple deployments coexist):

```json
{
  "projectName": "<projectName>",
  "companyName": "<companyName>",
  "region": "<us-east-1 | eu-central-1>",
  "language": "<en | de>",
  "voiceGender": "<feminine | masculine>",
  "customerProfilesEnabled": <boolean>,
  "frontendEnabled": <boolean>,
  "dataLakeEnabled": <boolean>,
  "contactEventsEnabled": <boolean>,
  "knowledgeBaseEnabled": <boolean>,
  "identityCenterEnabled": <boolean>,
  "retainData": <boolean>,
  "claimUkDid": <boolean>,
  "kbContent": "sample" | "<content-path>"
}
```

- Only `projectName` is required; `csp values` applies the defaults documented above for every missing key, type-checks the booleans, and rejects invalid names/text before anything is rendered.
- `claimUkDid` (run Phase 5?) and `kbContent` (`"sample"` | a content path; absent = leave the KB empty) are **orchestration prefs**: they never reach the template values, but persisting them makes the deployment fully reproducible from the order file alone (`csp deploy --order-file <file>` needs no extra flags).
- Legacy keys (`greeting`, `transferEnabled`, `toolEnabled`, `recordingEnabled`, `encryptionEnabled`) are ignored — those aspects are always on, ship as a module, or are prompt-driven now.

The values file (`.connect-skill-values.json`) is a **derived artifact** produced by `csp values` in Phase 3 — model IDs, Lex locale, TTS language, and voice are derived from `region` + `language` + `voiceGender`. Never hand-edit it; edit the order and re-run `csp values`.

## Phase 2: Preflight

```bash
csp preflight <region> <cwd>/.connect-skill-order.<projectName>.json --bootstrap
```

The order-file argument is optional but always pass it — it enables the Identity Center prerequisite gate when `identityCenterEnabled` is true. `--bootstrap` runs `cdk bootstrap` if the CDKToolkit stack is missing (without the flag, a missing bootstrap is reported as a failure).

Checks: AWS credentials; CDK availability (`cdk` on PATH or `npx --no-install cdk`); CDK bootstrap in the target region; Bedrock model access (probes Nova Pro only — full model list in `references/troubleshooting.md`); when `identityCenterEnabled`, that `saml-metadata.xml` exists next to the order file and looks like SAML metadata (**hard stop** if missing), plus a soft probe for a visible Identity Center instance (warning only — org instances often live in the management account).

If preflight fails, report the error and stop. Common failures:
- **Bedrock model not enabled**: visit https://console.aws.amazon.com/bedrock/home?region=<region>#/modelaccess and enable the reported model
- **CDK bootstrap fails**: the user needs IAM permissions (see `references/troubleshooting.md`)
- **saml-metadata.xml missing**: repeat the three-step Identity Center instruction from Phase 1 (Digestif) and re-run preflight once the file is in place

## Phase 3: Render Templates

```bash
csp values <cwd>/.connect-skill-order.<projectName>.json <cwd>/csp-<projectName>/.connect-skill-values.json
csp render <cwd>/csp-<projectName>/.connect-skill-values.json <skill-dir>/templates/cdk-app <cwd>/csp-<projectName>
```

`csp render`:
- Copies `templates/cdk-app` to `<cwd>/csp-<projectName>` (the `csp-` prefix marks generated output — one gitignore entry covers every rendered project; AWS resource names use the bare `projectName`)
- Carries custom `prompts/*.md` and `saml-metadata.xml` from the working dir into the rendered project (the working-dir copies are the source of truth and survive re-renders)
- Replaces all `{{key}}` placeholders with values from the JSON file and writes `lib/deployment-values.json` (the CDK-app-facing subset that `lib/config.ts` imports)
- Validates the prompt contract and that no unsubstituted placeholders remain — a validation error means fix the prompt files or order, then re-run

Success looks like a rendered `csp-<projectName>/` CDK app (`bin/`, `lib/` stacks, `flows/`). Architecture, naming (`config.prefix` → `this.namer`, instance alias = `<prefix>-<accountId>`), and capability composition are documented in `AGENTS.md`; the base flow ships with transfer and tool calling built in and is deployed as-is with only placeholder substitution (the recording-consent module deploys alongside it, unwired — see the Sides course).

**AgentCore MCP tools:** the gateway's five SAP order-lookup tools (`get_order_history`, `get_order_status`, `get_delivery_tracking`, `get_invoice_status`, `get_active_promotions` — canonical list: `SAP_GATEWAY_TOOLS` in `lib/agentcore-gateway-stack.ts`) are wired into the orchestration agent entirely in CDK — MCP-server integration, security-profile grant, and agent tool allow-list. The captured naming conventions (`<target>___<tool>`, `gateway_<gatewayId>__…`, `type: 'MCP'`) are exacting; if a deploy fails around them, or you need to re-capture after an AWS schema change, see "AgentCore MCP tool wiring" in `references/connect-ai-agent-block.md`.

## Phase 4: Deploy

```bash
csp synth <cwd>/csp-<projectName> <region>
csp cdk-deploy <cwd>/csp-<projectName> <region>
```

`csp synth` runs `npm ci` + type-check + `cdk synth` (cheap validation, no AWS resources); `csp cdk-deploy` runs `cdk deploy --all` with an outputs file, both region-pinned (the rendered app also hardcodes the region, so a stray default-region profile can't misroute the deploy). Deployment takes ~20 minutes end to end and creates seven stacks — ConnectInstance, Queues, Wisdom, ContactFlow, AgentCoreGateway, FlowLambdas, PostDeploy — plus **ContactEvents** when `contactEventsEnabled` and **WebcallWidget** when `frontendEnabled` (stack IDs are `<projectName>-<Suffix>`; see `AGENTS.md`).

From `<project-dir>/cdk-outputs.json`, extract for the next phases: `InstanceId` / `InstanceArn` / `InstanceAlias` (`<projectName>-ConnectInstance`), `AssistantId` / `OrchestrationAgentId` (`<projectName>-Wisdom`), `ContactFlowId` (`<projectName>-ContactFlow`), and `CloudFrontUrl` (`<projectName>-WebcallWidget`, frontend only).

If deploy fails: common causes are InvalidContactFlowException on the ContactFlow stack, CDK bootstrap issues, IAM permission denials, and Bedrock model access — **Claude Haiku 4.5 AND Nova Pro must both be enabled** (preflight probes only Nova Pro, so a missing Haiku enablement surfaces here; the voice is Connect-hosted agentic voice, not a Bedrock enablement). See `references/troubleshooting.md` for all of them. Do not proceed to the next phase on failure.

### Populate the knowledge base (only when `knowledgeBaseEnabled`)

The knowledge base deploys **empty** — retrieval returns nothing until content is ingested. Based on the Phase 1 choice:

- **(a) Sample data**: `csp sync-kb <cwd>/csp-<projectName> <skill-dir>/sample-data <region>`
- **(b) Own content**: `csp sync-kb <cwd>/csp-<projectName> <content-path> <region>`
- **(c) Empty for now**: skip; the user can run the same command any time later.

It resolves the KB bucket / knowledge-base ID / data-source ID from `cdk-outputs.json`, uploads to S3, starts a Bedrock ingestion job, and polls until it completes. Idempotent — re-run whenever content changes.

### Complete Identity Center SSO setup (only when `identityCenterEnabled`)

Sign-in will not work until the Identity Center application is finished by hand. Walk the user through it with **concrete values from the ConnectInstance stack outputs** (`SamlRelayStateUrl`, `SamlProviderArn`, `SamlFederationRoleArn`) — full walkthrough with screenshots-level detail in `references/identity-center-sso.md`:

1. **Application properties** (Identity Center → your Connect app): Relay state = the `SamlRelayStateUrl` output; ACS URL `https://signin.aws.amazon.com/saml`; SAML audience `urn:amazon:webservices`.
2. **Attribute mappings** — ⚠️ **mandatory; the single most common failure is skipping these.** A fresh catalog app has NO mappings; without the `Role` attribute sign-in fails with **"Your request included an invalid SAML response"** (it looks like a cert problem but isn't). Add all three rows under the app → **Actions → Edit attribute mappings**:

   | Attribute | Value | Format |
   |-----------|-------|--------|
   | `Subject` | `${user:email}` | `emailAddress` |
   | `https://aws.amazon.com/SAML/Attributes/RoleSessionName` | `${user:email}` | `unspecified` |
   | `https://aws.amazon.com/SAML/Attributes/Role` | `<SamlFederationRoleArn>,<SamlProviderArn>` | `unspecified` |

   The Role value is the two ARNs comma-separated, **role ARN first, no space after the comma**.
3. **Assign users/groups** to the application in Identity Center (grants the app tile only).
4. **Create matching Connect users** — the **Login must be exactly the user's Identity Center email**. Offer to do it via `aws connect create-user` (discover profile IDs with `list-security-profiles` / `list-routing-profiles`; the blueprint ships an `Admin` profile and a `<prefix>-default-routing-profile`). ⚠️ On a SAML instance do **not** pass `Email=` inside `--identity-info` (rejected with "Email is not required for this directory type") — the email goes in `--username` only; there is no password. Exact command in `references/identity-center-sso.md`.
5. **Where to sign in**: the IAM Identity Center access portal (`https://….awsapps.com/start`), **not** the Connect console — click the Connect app tile. These SSO logins are **staff** logins, separate from any web-call (Cognito) login.

Identity Center often lives in a different account (org management) — the app config must be edited there; cross-account `sso-admin` AccessDenied is expected and harmless. Troubleshooting table: `references/identity-center-sso.md`.

## Phase 5: Claim UK DID (optional)

If `claimUkDid` is `false`, **skip this phase entirely** and tell the user how to attach a number manually (below).

```bash
csp claim-did <instance-id> <contact-flow-id> <region>
```

Idempotent: checks for an existing UK DID on the flow, otherwise searches, claims, and associates one. Capture the printed `PHONE_NUMBER=+44…` for the final report.

If it fails: **No UK DIDs available** — AWS inventory rotates; retry, or fall back to a manual claim (see `references/troubleshooting.md`). **Already claimed** — reruns detect the association and skip.

### Manual phone number (alternative to Phase 5)

1. Open `https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>/phone-numbers`
2. Click **Claim a number**, choose country and type, complete any country-specific regulatory bundle (that address requirement is why the automated path claims UK DIDs only)
3. In **Contact flow / IVR**, select the flow named `<projectName>-basic-agent-flow` and save

## Phase 6: Smoke Test

```bash
csp smoke-test <cwd>/csp-<projectName> <region>
```

The instance/flow/assistant/agent ids are read from `<project-dir>/cdk-outputs.json` (the deploy wrote it — a missing output means deploy first). Add `--no-did-expected` when no UK DID was requested (manual/web-call reach) so the missing number reports as ✓ instead of ⚠.

Checks: instance ACTIVE; contact flow PUBLISHED; AI agent healthy; UK DID association; plus, per the order flags: IdentityManagementType is SAML, the contact-events rule is ENABLED, the Bedrock KB is ACTIVE. It prints a summary with the phone number and admin console URL — carry those into the final report.

## Final Report

After a successful smoke test, display a final report whose **call-to-action depends on the reach mode**. Pull values from `cdk-outputs.json` / the smoke-test summary. The admin console URL is always `https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>`.

### Activate tool calling — publish the orchestration agent (all branches, always)

**Required for tool calling to work, regardless of reach mode.** The CDK deploy creates only the orchestration agent's `$LATEST` draft; the wiring that lets the agent actually *call* the AgentCore MCP gateway tools happens only when the agent version is **published from the console** (there is no API for this). Without it the agent lists the tools but never invokes them. Tell the user (no settings change — just save and publish):

> One last step to activate tool calling — the CDK deploy can't do this part:
> 1. Sign in to the Connect admin console → **AI Agents**.
> 2. Select the **`<projectName>-orchestrator`** agent via the radio selector at the left of its row (do **not** click the name — that opens a read-only view with no publish button).
> 3. Press **Edit** in the list toolbar (top-right, between **Delete** and **Create AI Agent**).
> 4. Press **Save and Publish** (nothing needs changing).

### Branch A — UK number claimed (`claimUkDid` was true)

Report: "Your Nova Sonic 2 AI voice agent is live! ▶ CALL IT NOW: `<phone-number>`" plus the admin console URL and project dir. Next steps: call the number; customize prompts (see "Updating agent prompts" below); adjust the flow in the console. Then walk through the agent-publish step above.

### Branch B — Web-call frontend (`frontendEnabled` was true)

The CloudFront site is deployed but **cannot place calls until a widget is wired up**. This is guided and interactive — the user never edits a file by hand. First report: "Your agent is deployed! ▶ YOUR WEB-CALL SITE: `<cloudfront-url>` (one quick setup step needed before it can call — I'll do it for you below)" plus console URL and project dir. Then:

1. Have the user create the widget:
   > Open the admin console → **Channels → Communication widgets → Add widget**. Choose a **voice/calling** widget type, point it at the contact flow **`<projectName>-basic-agent-flow`**, add your CloudFront domain (the full `<cloudfront-url>`, **including the `https://`**) to the **allowed domains**, and **enable security** (the signed-JWT option). Save — the console shows an **embed code** (`<script>…</script>`) and a **security key**.

2. Ask the user to **paste the full embed `<script>` block and the security key** into the chat.

3. Write the embed snippet to a temp file and run:

   ```bash
   csp setup-widget <cwd>/csp-<projectName> <cwd>/.widget-embed.txt '<security-key>' <region>
   ```

   Idempotent: extracts the widget IDs from the snippet, patches `connectWidgets` in `lib/deployment-values.json`, redeploys **only** the WebcallWidget stack, and stores the security key in the widget's Secrets Manager secret (`<projectName>-widget-secret-<widgetId>`) so the token Lambda can sign JWTs. Delete the temp file afterward. **Never echo the security key** back to the user or write it to a tracked file.

4. Create the sign-in login and customer profile (self-signup is disabled, so do it for the user). Ask for username, first/last name, email, phone (E.164), and SAP customer number, then run `csp setup-test-users` (see "Creating customer profiles" below — same command; the locale is REQUIRED). Then tell the user: the site is live at `<cloudfront-url>`; if the login was newly created Cognito emails a temporary password (for an already-confirmed user the existing password is kept — the command says which) — sign in and click to call.

5. Walk through the agent-publish step above.

### Branch C — Manual number (`claimUkDid` false, `frontendEnabled` false)

Report: "Your agent is deployed! ▶ ONE STEP LEFT — attach a phone number:" with the two manual-claim steps from Phase 5, plus console URL and project dir. Then walk through the agent-publish step above.

In every branch, close with the teardown pointer: `csp teardown <projectName> <region>` (see below).

## Updating agent prompts (post-deploy)

The prompt files are the source of truth: edit → re-render → redeploy the Wisdom stack.

1. If the working dir has no `prompts/` yet: `csp init-prompts <cwd>`
2. Show the current `<cwd>/prompts/<which>.md`; let the user **paste** a replacement or **describe** the change for you to draft and iterate. Preserve the required scaffolding (see the "Custom prompts" course) — the next step validates it.
3. Re-render and redeploy only the Wisdom stack (run from the working dir, so the order file next to the project dir is found):

   ```bash
   csp redeploy --stack Wisdom <cwd>/csp-<projectName>
   ```

   This re-derives values, re-renders (order/values/prompts survive), synths, and deploys only `<projectName>-Wisdom` — the prompt version is published and the AI agent repointed. Changes take effect on the next call/chat. Use `csp redeploy <project-dir>` (redeploys all stacks) after template-level changes.

## Creating customer profiles (post-deploy)

**Only when the deployment has `customerProfilesEnabled`** (check the values file). **Offer** (don't force) to create a test user so the agent greets a real, known caller:

> Your flow looks the caller up in Customer Profiles and tells the AI agent who they are. The agent uses that customer number to fetch orders, deliveries, and invoices live from the sample SAP order API. No profiles exist until you create one (`csp setup-test-users` below); customer number `0000100042` ties a profile to the seeded sample orders. Want me to create a test user for one of your people? For the **web-call** app this also creates the Cognito sign-in (temporary password by email).

If they accept, collect: username, first/last name, email, phone (E.164), customer number (`0000100042` ties them to the seeded sample orders; any other value means the SAP tools find nothing), and a **locale** (e.g. `de-DE`, `en-US` — always ask, never assume; the command requires it). Then:

```bash
csp setup-test-users <cwd>/csp-<projectName> --user <username> --first <First> --last <Last> \
  --email <email> --phone <+E164> --customer-number <customer-number> --locale <locale>
```

Idempotent; reads the domain + user pool from `cdk-outputs.json`. With a WebcallWidget stack it creates the Cognito user (temporary password emailed) or resends the invitation, plus the matching Customer Profile; without one (phone-only deploys) it skips Cognito and creates only the profile (resolved by ANI). No redeploy needed — profiles are data. Full model, the Cognito tie-in, and how the profile reaches the agent's session context: `references/customer-profiles.md`.

## Teardown

`csp teardown <projectName> <region>` — **DESTRUCTIVE**: runs `cdk destroy` and then sweeps retained resources (the `retainData` survivors). It requires a typed project-name confirmation; `FORCE_TEARDOWN=1` skips the prompt in automation — never set it without the user's explicit go-ahead. For a plain stack destroy that honors retention, `cd <project-dir> && npx cdk destroy --all` still works.

## Error Handling

If any phase fails: **do not proceed to the next phase**; report the error clearly; check `references/troubleshooting.md`; guide the user to a fix before retrying. Failed `csp` commands exit non-zero and print the failing step. Partial deployments are safe: the CDK stacks remain, every `csp` command is idempotent, and rerunning (or `csp deploy --order-file …` to resume the whole flow) picks up where things left off.

## Important Notes

- **Cost**: deployed resources incur AWS charges — remind users to tear down when done testing.
- **Web-call security key**: lives only in Secrets Manager, never in `deployment-values.json` — never echo or commit it.
- **Files**: order file = user intent (edit this); values file = derived (never hand-edit); `prompts/*.md` and `saml-metadata.xml` in the working dir survive re-renders.
- **Deterministic alternative**: `csp deploy` is this exact flow without a coding assistant (its own terminal interview, or `--order-file`); users can switch between the skill and the CLI freely — see README.
- **Skill directory**: always resolve `cli/`, `templates/cdk-app`, and `sample-data` from `<skill-dir>`. Never hard-code paths.
