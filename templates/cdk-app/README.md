# {{projectName}} — Amazon Connect Nova Sonic Blueprint

Deployed by the `connect-bootstrap-skill`. This CDK project manages an Amazon Connect
contact center with a Nova Sonic 2 AI voice agent via Q-in-Connect.

## What's deployed

- Connect instance (`{{projectName}}`).
- Lex V2 bot (pass-through for voice interaction).
- Q-in-Connect assistant with ORCHESTRATION agent (Claude Haiku) + SELF_SERVICE agent (Nova Pro).
- Contact flow using ConnectParticipantWithLexBot.
- UK DID claimed and associated with the flow (unless you chose the web frontend or to add a number manually).

## Fine-tune the AI agent

Edit the orchestration prompt in `lib/wisdom-stack.ts` (the `orchestrationPrompt` text constant).
This controls the agent's persona, tone, and tool-use behavior. Then:

```bash
npx cdk deploy {{projectName}}-Wisdom
```

## Add knowledge base content

The `CfnKnowledgeBase` is empty. Populate it by adding documents to S3 and
creating an ingestion source, or use the Connect admin console.

## Re-deploy

```bash
npm install
npx cdk deploy --all
```

## Destroy

```bash
# Release the UK DID first:
aws connect release-phone-number --phone-number-id <id>
npx cdk destroy --all
```

## Stacks

- `ConnectInstance` — instance with security profile, hours of operation
- `Queues` — basic queue and routing profile
- `Wisdom` — Q-in-Connect assistant, knowledge base, ORCHESTRATION + SELF_SERVICE agents, AI prompts
- `LexBot` — Lex V2 bot + alias + Connect integration
- `ContactFlow` — flow JSON + (when tool calling is enabled) a sample Lambda
- `AgentCoreGateway` — API Gateway + Q-in-Connect synchronous runtime API proxy
- `FlowLambdas` — the Lex fulfillment Lambda (when tool calling is enabled)
- `ContactEvents` — EventBridge rules for call start/end events
- `PostDeploy` — custom-resource SDK calls (associate bot, flow, phone number)
- `WebcallWidget` — (conditional, only when frontendEnabled is true) web call frontend
