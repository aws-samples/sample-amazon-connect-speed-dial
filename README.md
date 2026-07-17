# Amazon Connect Deployment Skill

A coding assistant skill that scaffolds and deploys a working Amazon Connect Customer Contact Center.
This skill was developed to accelerate Connect deployments and ships with helpful blueprints.

> [!NOTE]  
> This project is a reference implementation intended as a starting point. Although it is built to AWS best practices, you should perform your own security review and hardening before any production deployment.

## Features

What the deployed contact center supports today:

| Feature | Status | Notes |
|---------|:------:|-------|
| **Nova Sonic 2 voice agent** | ✅ | Q-in-Connect orchestration agent (Claude Haiku 4.5) + self-service answer generation (Nova Pro). |
| **Knowledge base (RAG)** | ✅ | Optional — Bedrock Managed Knowledge Base (S3 Vectors) wired to the Q-in-Connect `Retrieve` tool; populated at setup from the bundled sample data or your own folder via `scripts/sync-kb.sh` (re-runnable anytime). |
| **Human transfer** | ✅ | Optional — routes the agent's Escalate outcome to a live-agent queue. |
| **Tool calling (MCP)** | ✅ | Optional — ships a sample Lambda tool and wires the AgentCore MCP gateway's tools into the agent. |
| **Customer Profiles** | ✅ | Optional — uses Amazon Connect Customer Profiles ot personalize the caller experience. Identity get's mapped by phone number and cognito sub when using the web widget. |
| **Pre-call context injection** | ✅ | Optional — a Lambda pushes caller context into the Q Connect session before the agent starts, so it knows the caller from the first turn (demo context aligned with the gateway's sample tools). |
| **Web-call frontend** | ✅ | Optional — browser-based calling (CloudFront + Cognito + API Gateway), with guided widget + sign-in setup. |
| **UK phone number (DID)** | ✅ | Auto-claims a `+44` number and attaches it to the flow; other countries via the console. |
| **Contact-events logging** | ✅ | Optional — EventBridge rule + Lambda logging contact lifecycle (DISCONNECTED) events to CloudWatch. |
| **Language selection** | ✅ | English (`en_US`) or German (`de_DE`) — localizes the greeting, agent and self-service prompts, goodbye/error messages, the recording-consent prompt, the Lex bot locale, and the TTS voice/language. Any region × language combination is valid. |
| **Region selection** | ✅ | `us-east-1` (N. Virginia, default) or `eu-central-1` (Frankfurt). Both run the full Connect + Q-in-Connect + Lex + Nova Sonic voice stack; the Bedrock inference-profile prefix (`us.*` / `eu.*`) is derived from the region. |
| **Voice selection** | ✅ | Feminine (default) or masculine Nova 2 Sonic speech-to-speech voice, resolved per language (English → tiffany/matthew, German → tina/lennart); out-of-bot flow prompts use a matching generative Polly voice. |

Planned / not yet available:

| Feature | Status | Notes |
|---------|:------:|-------|
| Model tier / persona choice | 🚧 | Model tier is fixed (Haiku + Nova Pro); voice and language are selectable (see above). |
| Guardrails | 🚧 | Content-safety filters. |
| Connect Agent Panel | 🚧 | Agent workspace UI for live agents. |
| Observability dashboard | 🚧 | Beyond the basic contact-events logging that ships today. |

> **Region:** deploys to **`us-east-1`** (N. Virginia, default) or **`eu-central-1`** (Frankfurt),
> chosen at setup. Both support the full Nova Sonic voice stack.

## Usage

Trigger the skill in Claude Code or Kiro by saying:

- "Set up Amazon Connect"
- "Deploy a Nova Sonic agent"
- "Create a Connect instance"
- "Connect AI agent blueprint"

The skill walks you through six phases interactively:

1. **Gather inputs** — project name, company name, greeting, region (US / Frankfurt), language & voice (English/German, feminine/masculine), add-on capabilities (transfer / tool calling / context injection / recording), and how you'll reach it (UK DID / web-call / manual)
2. **Preflight** — validates AWS credentials, CDK bootstrap, Bedrock model access
3. **Render templates** — generates a CDK project from templates with your config
4. **Deploy** — runs `cdk deploy --all` to create AWS resources (~3-5 minutes)
5. **Claim UK DID** _(optional)_ — searches and associates a UK phone number; skip this if you want to claim a different country or pick a specific number yourself in the console
6. **Smoke test** — verifies all resources are healthy

### Why UK by default?

UK DIDs are the only number type the skill claims automatically because they have the lightest regulatory footprint of the supported regions — Connect's `ClaimPhoneNumber` API accepts them with no address bundle, so the flow can complete unattended. Numbers in most other countries (and UK toll-free / mobile) require a regulatory address attached at claim time, which is much easier to handle in the Connect admin console. If you want one of those, skip Phase 5 and claim manually:

1. Open the **Phone numbers** page for your instance
2. Click **Claim a number**, pick country/type, and complete any regulatory address the console requests
3. Set the **contact flow** on the claimed number to `<projectName>-nova-sonic`

## What it deploys

Eight CloudFormation stacks in the selected region (`us-east-1` or `eu-central-1`); plus
**WebcallWidget** when the web-call frontend is enabled, and **ContactEvents** when
contact-events logging is enabled:

| Stack | Resources |
|-------|-----------|
| ConnectInstance | Connect instance, Customer Profiles, storage bucket |
| Queues | Default queue and 24x7 hours of operation |
| Wisdom | Q-in-Connect assistant, knowledge base (+ optional Bedrock KB with S3 Vectors), AI prompts (orchestration + answer gen), AI agents (orchestration + self-service), Lex V2 bot + alias, Connect integrations |
| ContactFlow | Inbound contact flow with AI Agent compound block (CreateWisdomSession → UpdateContactData → ConnectParticipantWithLexBot), composed from the base flow + capability branches |
| AgentCoreGateway | Bedrock AgentCore MCP gateway + sample Lambda tool, registered as an MCP server integration on the instance |
| FlowLambdas | Lambda functions for contact-flow tool calls |
| ContactEvents _(conditional)_ | EventBridge logging for contact events (`contactEventsEnabled`) |
| PostDeploy | Custom resources to set default AI agents on the assistant |
| WebcallWidget _(conditional)_ | CloudFront + Cognito + API Gateway for browser-based web calling |

## Capabilities

The contact center is composed from independent capability flags (set from your order), not
fixed flavors:

- **Human transfer** (`transferEnabled`) — routes the agent's Escalate outcome to a live-agent queue.
- **Tool calling** (`toolEnabled`) — ships a sample Lambda tool and wires the AgentCore gateway's MCP tools into the AI agent.
- **Pre-call context injection** (`contextInjectionEnabled`) — invokes a Lambda in the flow to push caller context into the Q Connect session before the agent starts.
- **Web-call frontend** (`frontendEnabled`) — deploys the browser-based calling site.

Any combination is valid; the transfer/tool branches are merged into the base contact flow at
synth time.

## IAM Identity Center (SSO) Integration

Instead of Connect-managed users, the instance can authenticate agents/admins through **AWS IAM
Identity Center** (SAML). Enable it by setting `identityCenterEnabled: true` in the order JSON
(the skill asks "How should agents and admins sign in?"). The blueprint creates the instance with
`identityManagementType: SAML` and auto-provisions the IAM SAML Provider and Federation Role from
a `saml-metadata.xml` you supply.

> **Important:** the identity management type is fixed at instance creation and **cannot be
> changed afterward** — switching later means destroying and recreating the whole instance.
> Decide before your first deploy.

**Before deploying**, you must create the Identity Center application, download its SAML metadata
XML, and save it as `saml-metadata.xml` in your working directory — synth (and preflight) fail
without it. **After deploying**, you complete the Identity Center app config (attribute mappings,
relay state, user assignment) and create matching Connect users.

Because this only applies to SSO deployments and involves several console steps and known
gotchas (the mandatory attribute mappings, the email-as-Login rule, the `create-user` CLI quirk,
cross-account Identity Center), the full walkthrough and troubleshooting table live in a dedicated
reference:

➡️ **[references/identity-center-sso.md](references/identity-center-sso.md)**

## Prerequisites

- AWS credentials with admin access to the target account
- CDK v2 installed (`npm install -g aws-cdk@2.1128.0`, or via a pinned npx: `npx aws-cdk@2.1128.0`)
- Node.js 18+
- Bedrock model access in the target region (`amazon.nova-2-sonic-v1:0` in us-east-1; in
  eu-central-1, `amazon.nova-pro-v1:0` — Nova Sonic voice is delivered via Amazon Connect there)

## Runtime artifacts

The skill produces these files in your working directory:

| File | Purpose |
|------|---------|
| `.connect-skill-values.json` | Your deployment configuration (account-specific, gitignored) |
| `<projectName>/` | The rendered CDK project (generated output, gitignored) |
| `<projectName>/cdk-outputs.json` | Stack outputs with resource IDs after deployment |

These are gitignored by default. The rendered CDK project is self-contained — you can `cd` into it and run `cdk deploy`, `cdk diff`, or `cdk destroy` independently.

## Tear down

```bash
cd <projectName>
npx cdk destroy --all
```

## Development

> **Editing infra?** All CDK changes go in `templates/cdk-app/` — never in a rendered project
> dir (those are generated output). See [AGENTS.md](AGENTS.md) for the full template → render →
> deploy model and conventions.

```bash
tests/test-all-capabilities.sh  # render + cdk synth for every transfer × tool combination
```

## Project structure

```
├── AGENTS.md                   # Canonical guidance for coding assistants
├── CLAUDE.md                   # Pointer to AGENTS.md
├── SKILL.md                    # Skill entry point (orchestration instructions)
├── scripts/
│   ├── build-values.sh         # Order JSON → validated values JSON
│   ├── preflight.sh            # Environment validation
│   ├── render-templates.sh     # Template rendering ({{key}} substitution)
│   ├── init-prompts.sh         # Seed editable agent prompts into the working dir
│   ├── validate-prompts.sh     # Check prompts keep required scaffolding
│   ├── claim-uk-did.sh         # UK DID search/claim/associate
│   ├── setup-widget.sh         # Wire up the web-call widget
│   ├── create-webcall-user.sh  # Create the Cognito sign-in user
│   ├── create-customer-profile.sh # Create a Customer Profile (+ injected context) for a user
│   └── smoke-test.sh           # Post-deploy health checks
├── templates/cdk-app/          # CDK project template (source of truth)
│   ├── bin/connect-blueprint.ts
│   ├── lib/                    # Stack definitions ({{key}} placeholders)
│   ├── prompts/                # Default agent prompts (orchestration, self-service)
│   └── flows/                  # Contact flow JSON (__PROP__ synth-time delimiters)
├── tests/
│   ├── test-all-capabilities.sh
│   ├── test-render-and-synth.sh
│   ├── test-build-values.sh
│   ├── test-validate-prompts.sh
│   └── fixtures/sample-values.json
└── references/                 # Architecture docs and troubleshooting
```
