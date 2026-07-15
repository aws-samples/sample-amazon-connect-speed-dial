---
name: connect-bootstrap
description: Use when the user wants to set up an Amazon Connect contact center with a Nova Sonic 2 AI voice agent. Scaffolds a CDK project with composable capabilities (human transfer, tool calling), deploys, claims a UK DID, and runs smoke test. Triggers on "set up Amazon Connect", "create a Connect instance", "deploy a Nova Sonic agent", "Connect AI agent blueprint".
---

# Amazon Connect Nova Sonic Blueprint

This skill deploys a complete Amazon Connect contact center with a Nova Sonic 2 AI voice agent and runs smoke tests. The deployment includes a Connect instance, Q in Connect AI agent with two Bedrock agents (orchestrator + self-service), and a contact flow composed from your selected capabilities.

By default the skill claims a **UK DID** (a `+44` direct-inward-dial number). UK DIDs are chosen because they have the lightest regulatory footprint of the supported regions — no business-address bundle is required at claim time, so the flow can complete unattended. If you want a number in a different country, or you'd prefer to pick the specific number yourself, skip the claim phase and claim the number manually in the Connect admin console, then associate it with the deployed contact flow.

## Overview

You will orchestrate six phases:

1. **Gather inputs** - collect configuration from the user via a menu-driven interface
2. **Preflight** - validate AWS credentials, CDK bootstrap, Bedrock access
3. **Render templates** - generate CDK app from templates
4. **Deploy** - run `cdk deploy --all` to create all AWS resources
5. **Claim UK DID** (optional) - search and associate a UK phone number with the contact flow; skip if you want to attach a number yourself in the console
6. **Smoke test** - verify all resources are healthy and report final phone number

## Phase 1: Gather Inputs

This phase uses a **menu-driven UX** organized as restaurant-style courses. Each course leads with a sensible default and is skippable. Use the AskUserQuestion tool to collect values **one at a time** (do not ask multiple questions in one prompt).

### Aperitif — Pace Selector

Ask: "How would you like to set up your contact center?"

Options:
- **The usual** (express path) — Smart defaults; just name it and go (~2 questions)
- **Walk me through it** — Pick your options course by course

If "The usual" is chosen, skip to the Starter (project name only) and AWS account confirmation, accepting all other defaults. If "Walk me through it" is chosen, present each course below.

### Starter — Identity [Ready]

These items are **always asked** (even in express mode, project name is required):

1. **Project name**
   - Ask: "What would you like to name this project?"
   - Default: `connect-nova-sonic-blueprint`
   - Validate: lowercase alphanumeric + hyphens only, max 32 chars
   - Reject if: contains uppercase, special chars (except hyphen), or exceeds 32 chars
   - Store in order object as: `projectName`

In "Walk me through it" mode, also ask:

2. **Company name**
   - Ask: "Enter your company name (used in the AI agent prompt)."
   - Default: `My Company`
   - Store in order object as: `companyName`

3. **Greeting text**
   - Ask: "Enter the greeting message the AI will speak."
   - Default: **language-dependent** — offer the default in the language the user is choosing, not always English:
     - English: `Hello, welcome to <companyName>. How can I assist you today?`
     - German: `Hallo, willkommen bei <companyName>. Wie kann ich Ihnen helfen?`
     (substitute the actual company name)
   - **Ask the Language question (Locale & region course, below) BEFORE offering this default**, so a German instance is never seeded an English greeting. If for flow reasons you must ask greeting first, only store `greeting` in the order object when the user typed a *custom* value — if they accept the default, leave `greeting` unset so `build-values.sh` localizes it to the chosen language.
   - Store in order object as: `greeting` (custom values only; a kept default is left unset)
   - Safety net: `build-values.sh` treats a greeting equal to either language's default template as "default kept" and emits the default for the selected language, so an accepted default always matches the instance language.

### Locale & region — Where & how it speaks [Ready]

Only offer this course in "Walk me through it" mode (express keeps the defaults:
US/Virginia, English, feminine voice). Ask one question at a time via AskUserQuestion.

1. **Region**
   - Ask: "Where should this deploy?"
   - Options: **US (N. Virginia)** [default] / **Europe (Frankfurt)**
   - Store in order object as: `region` = `us-east-1` (US) or `eu-central-1` (Frankfurt)
   - Both regions run the full stack (Connect + Q in Connect + Lex + Nova Sonic voice).
     The Bedrock model profile is chosen automatically from the region (`us.*` vs `eu.*`).

2. **Language**
   - Ask: "What language should the agent speak?"
   - Options: **English** [default] / **German**
   - Store in order object as: `language` = `en` or `de`
   - Independent of region — any region × language combination is valid.

3. **Voice**
   - Ask: "Which voice?"
   - Options: **Feminine** [default] / **Masculine**
   - Store in order object as: `voiceGender` = `feminine` or `masculine`
   - Resolves to a generative Polly voice per language: English → Joanna/Matthew,
     German → Vicki/Daniel.

### Aperitif side — Custom prompts [Ready, optional]

Only offer this course in "Walk me through it" mode (express mode keeps the default prompts).

Ask: "Want to customize the AI agent's prompts, or use the defaults?"

Options:
- **Use the defaults** (default) — the built-in orchestration and self-service prompts.
- **Customize** — tailor the orchestration prompt (the voice agent's persona/instructions) and/or the self-service prompt (how it answers from the knowledge base).

If "Customize" is chosen, first seed the editable prompt files into the working directory:

```bash
<skill-dir>/scripts/init-prompts.sh <skill-dir> <cwd>
```

This writes `<cwd>/prompts/orchestration.md` and `<cwd>/prompts/self-service.md` (the blueprint defaults; existing files are kept). Then, for each prompt the user wants to change, show the current file contents and let them either:
- **Paste** a full replacement prompt, or
- **Describe** the persona/behavior they want — you draft the prompt, show it, and iterate until they approve.

Write the approved text back to the corresponding `<cwd>/prompts/*.md` file. **Preserve the required scaffolding** (the render step validates it and will abort if it's missing):
- `orchestration.md`: keep the `system:` block, `{{$.conversationHistory}}`, and the `<message>` formatting tag. `{{companyName}}` is substituted at render time; `{{$.locale}}` is a Q Connect runtime variable — leave it intact.
- `self-service.md`: keep `{{$.contentExcerpt}}` (where retrieved KB documents are injected).

These files are the source of truth and survive re-renders. If the user keeps the defaults, do nothing — the template's seed prompts are used automatically. Nothing is stored in the order/values JSON for prompts.

### Main — The agent's brain [Coming soon]

**In this phase, these items are visible but NOT selectable.** Show them as preview content (e.g., "Model tier, knowledge base, and voice/persona options coming in a future release") but do NOT ask about them or collect values. Skip to Sides.

Future items (for transparency only):
- **Model tier**: Balanced (Haiku orchestration + Nova Pro answers) / Fast / Best
- **Knowledge base**: Empty for now / From a website / From an S3 path
- **Voice & persona**: Joanna (warm & concise) / other TTS options

### Sides — Add-on capabilities [Multi-select]

Ask: "Which add-on capabilities would you like? (You can choose multiple, or none.)"

Options (only these five are selectable in this phase):
- **Human transfer** [Ready] — escalate to a live agent queue
- **Tool calling** [Ready] — agent can call a Lambda (ships a sample function)
- **Pre-call context injection** [Ready] — a Lambda runs in the flow before the agent starts and pushes caller context into the Q Connect session, so the agent knows who it's talking to from the first turn. The blueprint injects tool-aligned demo context (a known customer `CUST001` / order `ORD-12345` matching the gateway's sample tools); when enabled, the orchestration prompt also gains an instruction to use that context and the lookup tools. Real deployments replace the demo data in `lambda/flow/update-session-context/index.py` with actual lookups.
- **Customer Profiles** [Ready, default ON] — seed a demo customer profile (Alice Johnson / `CUST001`, matching the context/tool persona) and look the caller up in the flow, surfacing the profile to the agent via `{{$.Custom.*}}`. Looks up by caller phone, then the web widget's `customerId` attribute, then a static demo phone fallback so it resolves on web-call / fresh-DID too. Defaults to **on** (the domain is already created by the instance). See "Customer Profiles" notes below for the native-block vs. Lambda decision.
- **Call recording** [Ready] — the flow opens with a DTMF consent gate (press 1 to allow, 2 to decline); on consent the call is recorded (Agent + Customer) to the instance's `CALL_RECORDINGS` S3 storage. Off by default, since whether to record is a per-deployment privacy/compliance decision.

Future options (visible, NOT selectable):
- **Guardrails** [Coming soon] — content-safety filters
- **External API tools (AgentCore)** [Coming soon] — register an OpenAPI schema with the gateway

Store selections in order object as:
- `transferEnabled` (boolean): `true` if Human transfer selected, `false` otherwise
- `toolEnabled` (boolean): `true` if Tool calling selected, `false` otherwise
- `contextInjectionEnabled` (boolean): `true` if Pre-call context injection selected, `false` otherwise
- `customerProfilesEnabled` (boolean): `true` if Customer Profiles selected. **Defaults to `true`** in `build-values.sh` when omitted (like `encryptionEnabled`).
- `recordingEnabled` (boolean): `true` if Call recording selected, `false` otherwise

### Drinks — Reach & operate

1. **Phone number** [Ready]
   - Ask: "How will you call it?"
   - Options:
     - **Claim a UK number** (default) — call in to test immediately
     - **Web-call frontend** — browser-based calling (CloudFront + Cognito + API Gateway)
     - **I'll add a number myself** in the console
   
   - If "Web-call frontend" is chosen:
     - Store in order object as: `frontendEnabled = true`
     - Set orchestration variable `claimUkDid = false` (web calling covers testing; skip UK DID phase)
     - Note to user: "The WebcallWidgetStack will deploy with CloudFront, Cognito, and API Gateway. After deployment, you'll add widgets in the Connect console and populate `config.connectWidgets` in the rendered project for full functionality."
   
   - If "Claim a UK number" is chosen:
     - Store in order object as: `frontendEnabled = false`
     - Set orchestration variable `claimUkDid = true`
   
   - If "I'll add a number myself" is chosen:
     - Store in order object as: `frontendEnabled = false`
     - Set orchestration variable `claimUkDid = false`

2. **Observability dashboard** [Coming soon]
   - Visible, NOT selectable. Basic contact-events logging is always deployed; the full dashboard will be added in a future release.

### Digestif — Operational [Ready]

Ask: "Keep the Connect instance if you tear the stack down?"

Default: `No` (accept default in express mode)

Note: This controls `retainConnectInstance` in `lib/config.ts`. It's an advanced toggle kept in the config file; this course simply informs the user of the default behavior. You do NOT need to store it in the order JSON (it's hardcoded in the template).

Then ask: "Encrypt stored data (call recordings, chat transcripts, exported reports) with a customer-managed KMS key?"

Default: `Yes` (accept default in express mode).

- **Yes** (default) — the blueprint creates a customer-managed KMS key and applies it to the storage bucket and the three Connect storage configs, so the Connect "Data storage" view shows encryption enabled. Store in order object as `encryptionEnabled: true`.
- **No** — keep AWS-managed defaults (the S3 bucket stays on SSE-S3; the Connect storage configs have no encryption set). Store as `encryptionEnabled: false`.

Note: `encryptionEnabled` defaults to **true** in `build-values.sh` if omitted (secure by default), unlike the add-on capability flags which default false. The Connect storage `encryptionConfig` only supports SSE_KMS, which is why enabling it creates a key. The key's removal policy follows `retainConnectInstance`. The key is created with **automatic annual key rotation enabled** (`enableKeyRotation: true` in `connect-instance-stack.ts`), following AWS best practice for customer-managed keys.

### The Check — Order confirmation

After gathering all inputs, display a summary of the user's selections:

```
Your order:
  Project:      <projectName>
  Company:      <companyName>
  Greeting:     <greeting>
  Sides:        [Human transfer] [Tool calling] (or "None" if both false)
  Reach:        [UK phone number] / [Web-call frontend] / [Manual]
  Region:       <us-east-1 | eu-central-1>
  Language:     <English | German>  Voice: <Feminine | Masculine>
  Deploy to:    AWS account <accountId> (<region>)
```

Ask: "Place this order?"

If confirmed, proceed to build the validated values JSON.

### Region Selection

The blueprint deploys to **us-east-1 (N. Virginia)** [default] or **eu-central-1 (Frankfurt)**,
chosen in the Locale & region course. Both run the full Connect + Q in Connect + Lex + Nova Sonic
voice stack; the Bedrock inference-profile prefix (`us.*` / `eu.*`) is derived from the region.
Show the chosen region in the order summary. All deploy/preflight/claim/smoke steps run against
that region (`CDK_DEFAULT_REGION` and the `[region]` script argument).

### AWS Account Confirmation

Run:
```bash
aws sts get-caller-identity
```

Capture the account ID for the order summary. The confirmation is included in "Place this order?" above.

### Build Values JSON

After the user confirms the order, create two files:

1. **Write the order object** to `.connect-skill-order.json` in the current working directory:

```json
{
  "projectName": "<projectName>",
  "companyName": "<companyName>",
  "greeting": "<greeting>",
  "region": "<us-east-1 | eu-central-1>",
  "language": "<en | de>",
  "voiceGender": "<feminine | masculine>",
  "transferEnabled": <boolean>,
  "toolEnabled": <boolean>,
  "contextInjectionEnabled": <boolean>,
  "customerProfilesEnabled": <boolean>,
  "recordingEnabled": <boolean>,
  "encryptionEnabled": <boolean>,
  "frontendEnabled": <boolean>
}
```

Note: All values except `projectName` are optional in the order file. The writer script applies defaults for any missing keys.

2. **Run the validated writer** to produce `.connect-skill-values.json`:

```bash
<skill-dir>/scripts/build-values.sh \
  <cwd>/.connect-skill-order.json \
  <cwd>/.connect-skill-values.json
```

The writer script:
- Validates `projectName` (rejects invalid names before any file copy)
- Applies defaults for missing order keys (`companyName`, `greeting`, etc.)
- Type-checks boolean flags (`transferEnabled`, `toolEnabled`, `frontendEnabled`)
- Escapes free text (`greeting`, `companyName`) for JSON and TypeScript string contexts
- Derives the Bedrock model IDs from `region` (`us.*` in Virginia, `eu.*` in Frankfurt) and the
  Lex locale / TTS language / Polly voice from `language` + `voiceGender`. `region` **is** emitted
  to the values file so `render-templates.sh` can hardcode it into `bin/connect-blueprint.ts`
  (pinning the deploy region); it also drives `CDK_DEFAULT_REGION`/`AWS_REGION` and the helper
  scripts.
- Emits a schema-validated `.connect-skill-values.json`

The `claimUkDid` boolean is **not** stored in either JSON file — it controls skill orchestration only (whether to run Phase 5) and is not consumed by the templates.

## Phase 2: Preflight

Run preflight checks to validate the environment:

```bash
<skill-dir>/scripts/preflight.sh <region>
```

The preflight script checks:
- AWS credentials configured
- CDK installed (global or npx)
- CDK bootstrap in us-east-1 (runs bootstrap if missing)
- Bedrock model access in the target region (us-east-1: amazon.nova-2-sonic-v1:0; eu-central-1:
  amazon.nova-pro-v1:0 — Nova Sonic voice is delivered via Amazon Connect there, not listable in
  Bedrock directly)

If preflight fails, report the error and stop. Common failures:
- **Bedrock model not enabled**: User must visit https://console.aws.amazon.com/bedrock/home?region=us-east-1#/modelaccess and enable amazon.nova-2-sonic-v1:0
- **CDK bootstrap fails**: User needs IAM permissions (see references/troubleshooting.md)

## Phase 3: Render Templates

Render the CDK app from templates:

```bash
<skill-dir>/scripts/render-templates.sh \
  <cwd>/.connect-skill-values.json \
  <skill-dir>/templates/cdk-app \
  <cwd>/<projectName>
```

This script:
- Copies all files from `templates/cdk-app` to `<cwd>/<projectName>`
- Replaces all `{{key}}` placeholders with values from the JSON file
- Validates no unsubstituted placeholders remain

The rendered project structure:
```
<projectName>/
├── bin/connect-blueprint.ts      # app entry: wires stacks, derives stack-ID namespace from prefix
├── lib/
│   ├── config.ts                 # single source of truth: prefix (= projectName), capability flags
│   ├── blueprint-stack.ts        # base Stack: resolves prefix once, exposes this.namer
│   ├── connect-instance-stack.ts
│   ├── queues-stack.ts
│   ├── wisdom-stack.ts           # Q in Connect assistant + 2 AI agents (orchestrator, self-service)
│   ├── lex-bot-stack.ts
│   ├── contact-flow-stack.ts     # composed flow (transfer/tool branches per capability flags)
│   ├── agentcore-gateway-stack.ts  # AgentCore MCP gateway + sample tool, registered as instance MCP server
│   ├── connect-flow-lambdas-stack.ts
│   ├── contact-events-stack.ts   # EventBridge logging
│   ├── webcall-widget-stack.ts   # CloudFront + Cognito + API Gateway (conditional)
│   └── post-deploy-stack.ts      # wires default AI agents to assistant
├── flows/
│   └── nova-sonic-base.json      # base contact flow (composed with transfer/tool branches at synth)
├── cdk.json
├── tsconfig.json
└── package.json
```

**Naming:** `config.prefix` is rendered from `projectName` and is the single source of truth for every resource name. Each stack extends `BlueprintStack` and names resources via `this.namer` (`.connect()` / `.lex()` / `.wisdom()` / `.instanceAlias()`), so the prefix is enforced deterministically. The Connect instance alias folds in the AWS account ID (`<prefix>-<accountId>`) because the alias is a globally-unique DNS hostname. `resolvePrefix()` throws if the template is deployed unrendered, so a placeholder can never become a real resource name.

**Capability composition:** The contact flow is built from the base flow (`flows/nova-sonic-base.json`) with optional branches added by pure transforms in `flow-compose.ts` per the flags in `config.ts`: `transferEnabled` routes the agent's Escalate outcome to a human queue; `contextInjectionEnabled` and `customerProfilesEnabled` each insert a Lambda invocation (`provide-agent-context` / `provide-profile-context`) into a shared "precall" sequence — a standalone `CreateWisdomSession`+`UpdateContactData` runs first (so the Lambdas' DescribeContact lookup has a bound session), the Lambdas run, then the intact AI Agent compound block runs. `recordingEnabled` prepends a DTMF consent gate as the flow's entry point. The precall scaffolding (`ensurePrecallSession`/`insertPrecallLambda` in `flow-compose.ts`) is shared so context-injection and customer-profiles compose order-independently and never split the AI Agent compound. This replaces the old three-flavor approach (qa / transfer / tool) with independent, composable capabilities.

**Customer Profiles:** The blueprint always creates a Customer Profiles domain on the instance. When `customerProfilesEnabled` (default on), it additionally (a) seeds one demo profile (Alice Johnson / `CUST001` / `+15550100123`, custom attrs `accountTier`, `recentOrderId`) via a `CreateProfile` custom resource in `connect-instance-stack.ts`, and (b) deploys a `profile-lookup` Lambda that `SearchProfiles` (by `_phone`, then the web `customerId` as `_account`, then the static demo phone) and bridges the result into the Q Connect session via `UpdateSessionData(namespace="Custom")` — the agent then reads it as `{{$.Custom.*}}`. **Design note / divergence:** rather than the native Customer Profiles flow block, the lookup is implemented as a `SearchProfiles` call in the `profile-lookup` Lambda. The native block's contact-flow-language `Type` string isn't documented (the docs page renders empty) and would have to be captured from a console-built flow via `DescribeContactFlow`; the Lambda approach preserves the same behavior (profile resolved into the agent identically) and the native block is deferred. The web frontend already passes `customerId` in the widget JWT (surfaces as `$.Attributes.customerId`), which the lookup uses, so the WebRTC channel is covered. **User-facing guide** (how it works, how to create a profile for a Cognito user, and how it overlaps with context injection): `references/customer-profiles.md`.

**Call recording (opt-in, `recordingEnabled`):** When enabled, `applyRecordingConsent` (in `flow-compose.ts`) prepends a DTMF consent gate — a `GetParticipantInput` block (`recording-consent`) becomes the flow's `StartAction`, asking the caller to press 1 to allow recording or 2 to decline. Press 1 → `enable-recording`; press 2 / timeout / no-match → `disable-recording`; both converge on the flow's original start (`enable-logs`) so the rest of the flow is unchanged. Recording uses `UpdateContactRecordingAndAnalyticsBehavior`; the enable path records `Agent` + `Customer` with **`IVRRecordingBehavior: Enabled`** — that IVR/automated-interaction setting is required for audio to be captured in this AI-agent (automated) flow, and recordings land in the instance's `CALL_RECORDINGS` S3 storage (configured in `connect-instance-stack.ts`). The consent prompt's company name is rendered from `{{companyName}}` via the `__COMPANY_NAME__` placeholder, mirroring the greeting. The gate sits entirely upstream of the AI Agent compound block and the context-injection actions, so it composes independently.

### AgentCore MCP tool integration

When `toolEnabled` is true, the blueprint wires the AgentCore gateway's tools into the orchestration AI agent entirely in CDK (no console steps). Three pieces must all be present, or the deploy fails — they were captured from a console-configured agent and the exact strings matter:

1. **MCP server integration** (`AgentCoreGatewayStack`) — the gateway is registered with the instance via an AppIntegrations `CfnApplication` (`applicationType: 'MCP_SERVER'`, `accessUrl` = the gateway's `https://<gatewayId>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp` endpoint) plus a Connect `CfnIntegrationAssociation` (`integrationType: 'APPLICATION'`, `instanceId` = the instance **ARN**). The application's `namespace` is set to the bare gateway id. This is the CDK equivalent of the console's **Add integration → MCP server** flow; `CreateIntegrationAssociation` has no dedicated MCP type — `APPLICATION` is correct (the API docs prose omits it, but the enum includes it).

2. **Security-profile grant** (`WisdomStack`) — the AI-agent `CfnSecurityProfile` carries an `applications` entry with **`type: 'MCP'`** (required — without it Connect treats it as a third-party app that only accepts `ACCESS` and rejects the tool ids with "Invalid application permission found"), `namespace` = the gateway id, and `applicationPermissions` = the AgentCore tool names (`<target>___<tool>`, e.g. `SampleCustomerLookup___get_customer_info`). Without this grant the Agent Designer shows "Insufficient Permissions" and the agent update is rejected.

3. **Agent tool allow-list** (`WisdomStack`) — each tool is a `MODEL_CONTEXT_PROTOCOL` entry in the orchestrator's `toolConfigurations`:
   - `toolName`: the AgentCore tool name, `<target>___<tool>` (e.g. `SampleCustomerLookup___get_customer_info`)
   - `toolId`: the **namespace-qualified** id, `gateway_<gatewayId>__<target>___<tool>` (e.g. `gateway_finalreview-gateway-odaj4wxasg__SampleCustomerLookup___get_customer_info`). This mirrors the built-in Retrieve tool's `aws_service__qconnect_Retrieve` (`<namespace>__<tool>`). Using the bare `<target>___<tool>` as the id fails with "MCP tool with ID … not found in MCP tools".
   - Do **not** set `description` on a gateway-sourced MCP tool — it's owned by the MCP server and QConnect rejects an override (400).

   AgentCore namespaces a Lambda target's tools as `<targetName>___<toolName>` (the sample tool Lambda parses the trailing `___` segment of `bedrockAgentCoreToolName`).

**Ordering:** `WisdomStack` depends on `AgentCoreGatewayStack` when `toolEnabled` (the gateway must be a registered MCP server on the instance before the agent that references its tools is created). To re-capture these strings if AWS changes the schema: configure the tools on an agent in the console, **publish** the agent version, then `aws qconnect get-ai-agent …` and `aws connect list-security-profile-applications …` and read the live `toolId` / `applicationPermissions`. (Note: the console's draft must be **published** before the API reflects the new tools.)

## Phase 4: Deploy

Deploy the CDK stacks:

```bash
cd <cwd>/<projectName>
npm install
AWS_REGION=<region> CDK_DEFAULT_REGION=<region> npx cdk deploy --all --require-approval never --outputs-file cdk-outputs.json
```

> **Region pinning:** the rendered `bin/connect-blueprint.ts` hardcodes the selected region
> (`region: '<region>'`, from `values.json`), so the deploy targets the right region even if the
> env vars above don't reach the node process. Export `AWS_REGION` too (belt-and-suspenders) so
> the AWS SDK calls inside custom resources use the same region. Never rely on `CDK_DEFAULT_REGION`
> alone — an inline var that fails to propagate silently deploys to the profile's default region
> (e.g. us-east-1 with `eu.*` model IDs, which fail QConnect validation).

This deploys **nine stacks** (always deployed):
1. **ConnectInstance** - Connect instance with Customer Profiles and storage bucket
2. **Queues** - default queue and hours of operation
3. **Wisdom** - Q in Connect assistant with knowledge base and two AI agents (orchestrator, self-service)
4. **LexBot** - Lex bot for voice input (wired to the Wisdom assistant)
5. **ContactFlow** - contact flow with AI Agent block (composed from base + capability branches)
6. **AgentCoreGateway** - Bedrock AgentCore MCP gateway + sample Lambda tool target, registered with the instance as an MCP server integration (AppIntegrations `MCP_SERVER` application + Connect `APPLICATION` association). When `toolEnabled` is true, the Wisdom stack additionally (a) allow-lists the gateway's tools on the orchestration AI agent and (b) grants them on the AI-agent security profile. See "AgentCore MCP tool integration" below for the exact wiring.
7. **FlowLambdas** - Lambda functions for contact-flow use. The `DescribeContact` helper is always deployed; the `UpdateSessionContext` Lambda (pre-call context injection) is deployed **only when `contextInjectionEnabled`** (invoked by `provide-agent-context`); the `ProfileLookup` Lambda is deployed **only when `customerProfilesEnabled`** (invoked by `provide-profile-context`). Each is associated with the instance when present.
8. **ContactEvents** - EventBridge logging for contact events
9. **PostDeploy** - Custom Resource to set default AI agents on the assistant

**Plus one conditional stack:**
10. **WebcallWidget** (only when `frontendEnabled` is `true`) - CloudFront distribution, Cognito user pool, and API Gateway for browser-based web calling. Widgets are added in the Connect console after deployment and `config.connectWidgets` populated for full functionality.

Deployment takes 3-5 minutes. The `cdk-outputs.json` file will contain outputs for each stack. Key outputs (stack IDs use the pattern `<projectName>-<StackSuffix>`):

```json
{
  "<projectName>-ConnectInstance": {
    "InstanceId": "...",
    "InstanceArn": "...",
    "InstanceAlias": "...",
    "CustomerProfilesDomainName": "...",
    "StorageBucketName": "..."
  },
  "<projectName>-Wisdom": {
    "AssistantId": "...",
    "OrchestrationAgentId": "...",
    "OrchestrationAgentArn": "..."
  },
  "<projectName>-ContactFlow": {
    "ContactFlowId": "...",
    "ContactFlowArn": "..."
  },
  "<projectName>-Queues": {
    "QueueArn": "...",
    "HoursOfOperationArn": "..."
  }
}
```

(Other stacks also emit outputs; the above are the most commonly referenced. All stack IDs follow the `<projectName>-<StackSuffix>` pattern.)

Extract the `InstanceId`, `ContactFlowId`, `AssistantId`, and `OrchestrationAgentId` for the next phases.

### If Deploy Fails

Common errors:
- **InvalidContactFlowException on ContactFlow stack**: The AI Agent block JSON in the flow may be invalid. See references/troubleshooting.md.
- **CDK bootstrap error**: Run `cdk bootstrap aws://<account>/us-east-1` manually.
- **IAM permission denied**: User needs IAM permissions to create Connect resources.
- **Bedrock model access denied**: Ensure Nova Sonic 2, Claude Haiku 4.5, and Nova Pro are enabled in the Bedrock console (us-east-1).

## Phase 5: Claim UK DID (optional)

If `claimUkDid` is `false`, **skip this phase entirely** and tell the user how to attach a number manually (see "Manual phone number" below).

If `claimUkDid` is `true`, claim and associate a UK phone number:

```bash
<skill-dir>/scripts/claim-uk-did.sh \
  <instance-id> \
  <contact-flow-id> \
  <region>
```

The script:
- Checks if a UK DID is already associated with the flow (idempotent)
- Searches for available UK DIDs
- Claims a phone number
- Associates it with the contact flow

Output:
```
PHONE_NUMBER=+44...
PHONE_NUMBER_ID=...
```

Capture the `PHONE_NUMBER` for the smoke test summary.

### If Claim Fails

- **No UK DIDs available**: AWS inventory rotates — retry, widen search, or fall back to a manual claim in the console (see references/troubleshooting.md)
- **Already claimed**: If rerunning, the script detects existing associations and skips claiming

### Manual phone number (alternative to Phase 5)

To use a number in a different country, or to pick a specific number, instruct the user to:

1. Open: `https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>/phone-numbers`
2. Click **Claim a number**, choose country and type, and complete any country-specific regulatory bundle the console asks for
3. In **Contact flow / IVR**, select the flow named `<projectName>-nova-sonic` and save

The smoke test will print a warning instead of failing when no number is associated.

## Phase 6: Smoke Test

Run smoke tests to verify the deployment:

```bash
<skill-dir>/scripts/smoke-test.sh \
  <instance-id> \
  <contact-flow-id> \
  <assistant-id> \
  <ai-agent-id> \
  <region>
```

The script checks:
- Instance is ACTIVE
- Contact flow is PUBLISHED
- AI Agent is ACTIVE or CREATE_COMPLETE
- UK DID is associated with the flow

Output:
```
==========================================
Smoke Test Summary
==========================================
Phone Number:   +44...
Instance ID:    ...
Flow ID:        ...
AI Agent ID:    ...

Admin Console:  https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>

✓ All checks passed! Call +44... to test the voice agent.
```

## Final Report

After a successful smoke test, display a final report whose **call-to-action depends on the reach mode the user chose**. The goal is that the user knows exactly what to click or dial to try their agent. Pull the values from `cdk-outputs.json` (or the smoke-test output): `InstanceId` and `InstanceAlias` from the ConnectInstance stack, `CloudFrontUrl` from the WebcallWidget stack (frontend only), and the claimed `PHONE_NUMBER` (UK-DID path only).

The admin console URL is always `https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>`.

### Activate tool calling — publish the orchestration agent (all branches, only when `toolEnabled`)

**This step is required for tool calling to work, regardless of reach mode.** Each branch below
references it. The CDK deploy creates only the orchestration agent's `$LATEST` draft; some
background wiring that lets the agent actually *call* the AgentCore MCP gateway tools happens only
when the agent version is **published from the console**. Without this one-time step the agent
lists the tools but never invokes them.

**Skip this step entirely if `toolEnabled` is false** — there are no gateway tools to publish.
When `toolEnabled` is true, tell the user (there are no settings to change — just save and publish):

> One last step to activate tool calling — the CDK deploy can't do this part:
> 1. Sign in to the Connect admin console.
> 2. Go to **AI Agents**.
> 3. Select the **`<projectName>-orchestrator`** agent.
> 4. Press **Select in Agent Builder**.
> 5. Press **Save and Publish** (no settings need changing).
>
> After that the agent can call the MCP gateway tools.

### Branch A — UK number claimed (`claimUkDid` was true)

```
========================================
Amazon Connect Deployment Complete
========================================

Your Nova Sonic 2 AI voice agent is live!

▶ CALL IT NOW:  <phone-number>

Admin Console:  https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>
Project Dir:    <cwd>/<projectName>

Next Steps:
1. Call <phone-number> to talk to the AI agent
2. Customize the AI prompt in the Q in Connect console
3. Adjust the contact flow in the Connect console

To tear down:
  cd <cwd>/<projectName>
  npx cdk destroy --all
```

**When `toolEnabled`:** after showing this report, walk the user through publishing the
orchestration agent — see "Activate tool calling — publish the orchestration agent" above.
Skip if `toolEnabled` is false.

### Branch B — Web-call frontend (`frontendEnabled` was true)

The CloudFront site is deployed but **cannot place calls until a widget is wired up**. This is a guided, interactive step: the user creates the widget in the console and pastes its embed snippet + security key back into the chat; the skill extracts the values, patches the project, redeploys the widget stack, and stores the key. The user never edits a file by hand.

First, show this report:

```
========================================
Amazon Connect Deployment Complete
========================================

Your Nova Sonic 2 AI voice agent is deployed!

▶ YOUR WEB-CALL SITE:  <cloudfront-url>
  (one quick setup step needed before it can call — I'll do it for you below)

Admin Console:  https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>
Project Dir:    <cwd>/<projectName>
```

Then walk the user through widget creation and offer to wire it up automatically:

1. Tell the user to create the widget in the console:
   > Open the admin console → **Channels → Communication widgets → Add widget**.
   > Choose a **voice/calling** widget type, point it at the contact flow named
   > **`<projectName>-nova-sonic`**, add your CloudFront domain (the full
   > `<cloudfront-url>`, **including the `https://`**) to the **allowed domains**,
   > and **enable security** (the signed-JWT option). Save. The console then shows
   > an **embed code** (`<script>…</script>`) and a **security key**.

2. Ask the user to **paste the full embed `<script>` block and the security key** into the chat.

3. Write the pasted embed snippet to a temp file (e.g. `<cwd>/.widget-embed.txt`) and run the setup script:

   ```bash
   <skill-dir>/scripts/setup-widget.sh \
     <cwd>/<projectName> \
     <cwd>/.widget-embed.txt \
     '<security-key>' \
     <region>
   ```

   The script (idempotent):
   - Extracts `id`, `snippetId`, and `scriptUrl` from the embed snippet (via `scripts/extract-widget.js`) and patches `config.connectWidgets` in `lib/config.ts`
   - Redeploys **only** the `<projectName>-WebcallWidget` stack (creates the signing-key secret and regenerates the site's `config.js`)
   - Writes the security key into the widget's Secrets Manager secret (`<projectName>-widget-secret-<widgetId>`) so the token Lambda can sign JWTs
   - Prints the live CloudFront URL on success

   Delete the temp embed file afterward (it contains the snippet, not a secret, but keep the working dir clean). **Never echo the security key** back to the user or write it to a tracked file.

4. After the script succeeds, create the sign-in login. The site's Cognito pool has self-signup disabled, so the login must be admin-created — do this for the user instead of sending them to the console. Ask for a username and email (offer to auto-generate the password), then run:

   ```bash
   <skill-dir>/scripts/create-webcall-user.sh \
     <cwd>/<projectName> \
     <username> \
     <email> \
     <password> \
     <region>
   ```

   (Pass `""` for the password to auto-generate one; the region is the final argument.)

   The script (idempotent):
   - Reads the `UserPoolId` from `cdk-outputs.json`
   - Creates the user (email pre-verified, no invite email sent) or updates the password if it already exists
   - Sets a **permanent** password (no forced change) so the user can sign in immediately
   - If no password is given, generates a policy-compliant one and prints it — relay it to the user once and note it isn't stored anywhere

   Then tell the user:
   > Your web-call site is live at `<cloudfront-url>`. Sign in with the username
   > and password above, then click to call your AI agent in the browser.

5. **Activate tool calling (only when `toolEnabled`).** Walk the user through publishing the
   orchestration agent — see "Activate tool calling — publish the orchestration agent" above.
   Skip if `toolEnabled` is false.

If the user prefers to do it manually, they can edit `config.connectWidgets` in `lib/config.ts`, redeploy the widget stack, and put the key in Secrets Manager themselves — but the script path above is the recommended flow.

```
To tear down:
  cd <cwd>/<projectName>
  npx cdk destroy --all
```

### Branch C — Manual number (`claimUkDid` false, `frontendEnabled` false)

```
========================================
Amazon Connect Deployment Complete
========================================

Your Nova Sonic 2 AI voice agent is deployed!

▶ ONE STEP LEFT — attach a phone number to start testing:
  1. Open: https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>/phone-numbers
  2. Claim a number, then set its contact flow to "<projectName>-nova-sonic"

Admin Console:  https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>
Project Dir:    <cwd>/<projectName>

Next Steps:
1. Attach a number (above), then call it to talk to the AI agent
2. Customize the AI prompt in the Q in Connect console
3. Adjust the contact flow in the Connect console

To tear down:
  cd <cwd>/<projectName>
  npx cdk destroy --all
```

**When `toolEnabled`:** after showing this report, walk the user through publishing the
orchestration agent — see "Activate tool calling — publish the orchestration agent" above.
Skip if `toolEnabled` is false.

## Updating agent prompts (post-deploy)

After deployment, the user can change the orchestration or self-service prompt at any time. The prompt files are the source of truth, so the flow is: edit the file → re-render → redeploy the Wisdom stack.

1. If the working dir has no `prompts/` yet (e.g. the user kept the defaults at setup), seed it first:

   ```bash
   <skill-dir>/scripts/init-prompts.sh <skill-dir> <cwd>
   ```

2. For the prompt the user wants to change, show the current `<cwd>/prompts/<which>.md`, then let them **paste** a replacement or **describe** the change for you to draft and iterate. Write the approved text back to the file. Preserve the required scaffolding (see the "Custom prompts" course above) — the next step validates it.

3. Re-render and redeploy only the Wisdom stack:

   ```bash
   <skill-dir>/scripts/render-templates.sh \
     <cwd>/.connect-skill-values.json \
     <skill-dir>/templates/cdk-app \
     <cwd>/<projectName>

   cd <cwd>/<projectName>
   npx cdk deploy <projectName>-Wisdom --require-approval never --outputs-file cdk-outputs.json
   ```

   The render step runs `validate-prompts.sh` and aborts if required scaffolding is missing. The deploy updates the `CfnAIPrompt`, publishes a new prompt version, and repoints the AI agent — no other stack is touched. Changes take effect on the next call/chat.

## Creating customer profiles (post-deploy)

**Only run this walkthrough if the instance was deployed with `customerProfilesEnabled`** (check `.connect-skill-values.json`). If it's off, skip — there is no profile lookup in the flow.

After a deploy with Customer Profiles on, **offer** (don't force) to create a profile so the agent greets a real, known caller instead of the seeded demo customer. Explain it briefly first:

> Your flow looks the caller up in Customer Profiles and tells the AI agent who they are (name, account, tier) and their recent activity (last order, status, open cases). Right now there's one **demo** profile (Alice Johnson / CUST001). Want me to create a profile for one of your users so the agent greets *them*? For the **web-call** app, I can tie it to a signed-in user automatically.

If the user declines, stop. If they accept, collect: first/last name, and either a **web-call username** (recommended — I'll resolve its Cognito `sub` as the lookup key) or a **phone number** for a voice caller; optionally tier, recent order id + status, open-case count. Then run the helper (it reads the domain + user pool from `cdk-outputs.json`, is idempotent, and never needs the AWS console):

```bash
<skill-dir>/scripts/create-customer-profile.sh <cwd>/<projectName> \
  --first <First> --last <Last> \
  --cognito-username <webcallUser>   # OR: --account <id> --phone <+E164> \
  --tier <Premium|Gold|...> --order-id <ORD-...> --order-status <Shipped|...> --open-cases <n>
```

How it works end to end:
- The profile stores both **identity** (name → `customerName`, account number → `customerId`, `accountTier`) and **recent-activity** custom attributes (`recentOrderId`, `orderStatus`, `openCaseCount`).
- On a call, the `profile-lookup` Lambda finds the caller (by phone, or by the web widget's Cognito `sub` searched as `_account`) and injects **all** of it into the Q Connect session, where the agent reads it as `{{$.Custom.*}}`. This runs **after** context injection, so a matched profile **overrides** the demo baseline; with no match, the agent falls back to the demo context.
- No redeploy is needed — profiles are data. Tell the user to call (voice from the given number, or the web-call app signed in as that user) and the agent will greet them by name.

Full reference (model, fields, the Cognito tie-in, and how this composes with context injection): `references/customer-profiles.md`.

## Error Handling

If any phase fails:
1. **Do not proceed to the next phase**
2. Report the error message clearly
3. Check references/troubleshooting.md for common solutions
4. Guide the user to fix the issue before retrying

For partial deployments (e.g., CDK deploy succeeds but claim-uk-did fails):
- The CDK stacks remain deployed
- Rerunning claim-uk-did is safe (it's idempotent)
- User can manually destroy stacks with `cdk destroy --all`

## Important Notes

- **Region**: Deploys to us-east-1 (N. Virginia, default) or eu-central-1 (Frankfurt), chosen at
  setup. Both support the full voice stack; the Bedrock model profile (`us.*` / `eu.*`) follows the
  region. UK DIDs can be claimed from either region (no address bundle required), so instant
  call-in works for both.
- **Phone Numbers**: The skill claims UK DIDs by default because they have the lightest regulatory footprint of the supported regions — `claim-phone-number` accepts them with no address bundle. Other countries (and UK toll-free / mobile) typically require a regulatory address attached at claim time, which is easier to do in the Connect console; for those, skip Phase 5 and have the user claim manually.
- **Web-call frontend**: When `frontendEnabled` is `true`, the WebcallWidgetStack deploys CloudFront, Cognito, and API Gateway infrastructure regardless of widget configuration. The site can't place calls until a widget is wired up — the user creates the widget in the Connect console and pastes its embed snippet + security key into the chat, then `scripts/setup-widget.sh` extracts the values, patches `config.connectWidgets`, redeploys the widget stack, and stores the signing key in Secrets Manager (see Branch B of the Final Report). The signing key lives in a Secrets Manager secret (`<projectName>-widget-secret-<widgetId>`), **not** in `config.ts` — the token Lambda reads it at runtime. Never echo the key back to the user or commit it.
- **Capability composition**: The old three-flavor system (qa / transfer / tool) has been replaced with independent capability flags (`transferEnabled`, `toolEnabled`). Transfer and tool-calling branches are composed into the contact flow at CDK synth time, so any combination (none, transfer-only, tool-only, both) produces a valid deployment.
- **Cost**: Deployed resources incur AWS charges. Remind users to run `cdk destroy --all` when done testing.
- **Idempotency**: All scripts are idempotent. Rerunning is safe.
- **Values JSON**: The `.connect-skill-values.json` file (generated by `build-values.sh` from `.connect-skill-order.json`) is stored in the user's working directory and can be reused for multiple deployments.
- **Skill Directory**: Always use `<skill-dir>` to reference scripts/templates. Never hard-code paths.
