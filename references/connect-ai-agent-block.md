# Amazon Connect AI Agent Block — Captured Reference

**Captured on:** 2026-06-18
**Instance:** `example` (`11111111-1111-1111-1111-111111111111`) in `us-west-2`, account `111122223333`
**Flow:** "Example Flow" (`22222222-2222-2222-2222-222222222222`)

## Architecture: The "AI Agent" block is actually a compound action

The Connect console's "AI Agent" block is NOT a single action type. It compiles down to **three sequential actions** in the flow JSON:

1. **`CreateWisdomSession`** — establishes a Q-in-Connect session.
2. **`UpdateContactData`** — sets `WisdomSessionArn` on the contact from `$.Wisdom.SessionArn`.
3. **`ConnectParticipantWithLexBot`** — the actual voice-interaction step. Q-in-Connect's AI agent is wired in via the `LexSessionAttributes` key `x-amz-lex:q-in-connect:ai-agent-arn`.

## Required resources

The AI Agent block depends on:

1. **A Lex V2 bot + alias** — serves as the voice-interaction framework. In the captured flow, bot `EXAMPLEBOT1` with alias `TSTALIASID` (named "TestBotAlias"). The bot uses locale `en_US` and the `AWSServiceRoleForLexV2Bots_AmazonConnect_*` service-linked role.
2. **A Q-in-Connect (Wisdom) assistant** (`type=AGENT`) — e.g., `55555555-5555-5555-5555-555555555555`.
3. **A Q-in-Connect AI Agent of type `ORCHESTRATION`** — the one wired into the flow. The `ORCHESTRATION` agent has tool configurations (Complete, Escalate, Retrieve) and is backed by Claude Haiku 4.5 via `orchestrationAIPromptId`. The `SELF_SERVICE` agent only has an answer-generation prompt.
4. **A Connect `WISDOM_ASSISTANT` integration association** linking the instance to the assistant.
5. **A queue set via `UpdateContactTargetQueue`** before the AI Agent block (required for "Escalate" tool to work).
6. **`UpdateContactEventHooks`** setting `CustomerQueue` event hook (for queue-hold flow).

## Block Type strings

| Console name | Flow JSON `Type` | Purpose |
|---|---|---|
| (part of AI Agent) | `CreateWisdomSession` | Opens a Wisdom session |
| (part of AI Agent) | `UpdateContactData` | Binds session ARN to contact |
| (the voice part) | `ConnectParticipantWithLexBot` | Speech interaction via Lex+Q-in-Connect |

## ConnectParticipantWithLexBot Parameters

```json
{
  "Text": "Hello welcome to Example customer service",
  "LexV2Bot": {
    "AliasArn": "arn:aws:lex:us-west-2:111122223333:bot-alias/EXAMPLEBOT1/TSTALIASID"
  },
  "LexSessionAttributes": {
    "x-amz-lex:audio:end-timeout-ms:*:*": "1000",
    "x-amz-lex:q-in-connect:ai-agent-arn": "arn:aws:wisdom:us-west-2:111122223333:ai-agent/55555555-5555-5555-5555-555555555555/66666666-6666-6666-6666-666666666666:$LATEST"
  }
}
```

Key parameters:
- **`Text`** — initial greeting spoken by TTS before the bot starts listening.
- **`LexV2Bot.AliasArn`** — ARN of the Lex bot alias.
- **`LexSessionAttributes`**:
  - `x-amz-lex:audio:end-timeout-ms:*:*` — speech endpoint detection timeout (ms).
  - `x-amz-lex:q-in-connect:ai-agent-arn` — the Q-in-Connect AI Agent version ARN. This is what links the Lex interaction to the Nova Sonic orchestrator.

## Exit branches

The `ConnectParticipantWithLexBot` action transitions:
- **`NextAction`** (default) — normal exit (e.g., conversation completed via "Complete" tool).
- **`ErrorType: NoMatchingCondition`** — no intent matched / escalation signal from the orchestrator.
- **`ErrorType: NoMatchingError`** — general error.

In the captured flow: `NoMatchingCondition` → `TransferContactToQueue` (escalation); default/error → `DisconnectParticipant`.

## AI Agent types and their roles

- **`ORCHESTRATION`** (`ExampleOrchestrator`): The brain. Has tools: `Complete` (end conversation), `Escalate` (transfer to human), `Retrieve` (search knowledge base). Uses Claude Haiku as the orchestration model. References the Connect instance ARN and locale. This is the one wired into the `x-amz-lex:q-in-connect:ai-agent-arn` parameter.
- **`SELF_SERVICE`** (`example`): Only has a `selfServiceAnswerGenerationAIPromptId` pointing to a Nova Pro-backed prompt for RAG-style answer generation. Not directly wired in the flow — used by the orchestrator's Retrieve tool.

## Flow structure (simplified)

```
EnableFlowLogs
  → CreateWisdomSession (assistant ARN)
  → UpdateContactData (WisdomSessionArn = $.Wisdom.SessionArn)
  → UpdateContactEventHooks (CustomerQueue = default queue flow)
  → SetVoice (Joanna, Generative engine)
  → SetQueue (BasicQueue)
  → CreateWisdomSession [AI Agent block start] (same assistant ARN)
  → UpdateContactData [AI Agent fragment] (WisdomSessionArn = $.Wisdom.SessionArn)
  → ConnectParticipantWithLexBot (Lex alias + Q-in-Connect AI Agent ARN in session attrs)
      ├─ default exit → Disconnect
      ├─ NoMatchingCondition → TransferToQueue → Disconnect
      └─ NoMatchingError → Disconnect
```

Note: The flow creates the Wisdom session TWICE — once at the start and once inside the AI Agent block (which is the compound action). The second one is what the AI Agent block in the console generates. The first is likely from an earlier version of the flow.

## CDK implications for the skill

The skill needs to provision:
1. **Lex V2 bot** (`AWS::Lex::Bot`) with locale `en_US`, an intent (even a FallbackIntent suffices), and a published bot version + alias.
2. **Connect-Lex association** (`CfnIntegrationAssociation` with `integrationType: LEX_BOT`).
3. **Wisdom assistant** + **Wisdom AI Agent (ORCHESTRATION type)** with tool configs.
4. **Wisdom AI Agent (SELF_SERVICE type)** with answer-generation prompt.
5. **AI Prompt (ORCHESTRATION type)** for the orchestrator model.
6. **AI Prompt (SELF_SERVICE_ANSWER_GENERATION type)** for RAG answers.
7. The contact flow content JSON uses `ConnectParticipantWithLexBot`, not a custom "AI Agent" type.

## How to re-capture

If AWS changes the block schema:
1. Build a flow with the AI Agent block in the Connect console.
2. `aws connect describe-contact-flow --instance-id <id> --contact-flow-id <id> --region <region> --query 'ContactFlow.Content' --output text | python3 -m json.tool`
3. Diff against `references/connect-ai-agent-block.raw.json`.
4. Update `templates/cdk-app/flows/basic-agent-flow.json` to match.

## AgentCore MCP tool wiring — captured naming conventions

The blueprint wires the AgentCore gateway's tools into the orchestration AI agent entirely in
CDK (no console steps). Three pieces must all be present, or the deploy fails — they were
captured from a console-configured agent and the exact strings matter:

1. **MCP server integration** (`AgentCoreGatewayStack`) — the gateway is registered with the
   instance via an AppIntegrations `CfnApplication` (`applicationType: 'MCP_SERVER'`,
   `accessUrl` = the gateway's
   `https://<gatewayId>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp` endpoint) plus a
   Connect `CfnIntegrationAssociation` (`integrationType: 'APPLICATION'`, `instanceId` = the
   instance **ARN**). The application's `namespace` is set to the bare gateway id. This is the
   CDK equivalent of the console's **Add integration → MCP server** flow;
   `CreateIntegrationAssociation` has no dedicated MCP type — `APPLICATION` is correct (the API
   docs prose omits it, but the enum includes it).

2. **Security-profile grant** (`WisdomStack`) — the AI-agent `CfnSecurityProfile` carries an
   `applications` entry with **`type: 'MCP'`** (required — without it Connect treats it as a
   third-party app that only accepts `ACCESS` and rejects the tool ids with "Invalid application
   permission found"), `namespace` = the gateway id, and `applicationPermissions` = the AgentCore
   tool names (`<target>___<tool>`, e.g. `SapOrderLookup___get_order_status`). Without this grant
   the Agent Designer shows "Insufficient Permissions" and the agent update is rejected.

3. **Agent tool allow-list** (`WisdomStack`) — each tool is a `MODEL_CONTEXT_PROTOCOL` entry in
   the orchestrator's `toolConfigurations`:
   - `toolName`: the AgentCore tool name, `<target>___<tool>` (e.g.
     `SapOrderLookup___get_order_status`)
   - `toolId`: the **namespace-qualified** id, `gateway_<gatewayId>__<target>___<tool>` (e.g.
     `gateway_finalreview-gateway-odaj4wxasg__SapOrderLookup___get_order_status`). This mirrors
     the built-in Retrieve tool's `aws_service__qconnect_Retrieve` (`<namespace>__<tool>`). Using
     the bare `<target>___<tool>` as the id fails with "MCP tool with ID … not found in MCP
     tools".
   - Do **not** set `description` on a gateway-sourced MCP tool — it's owned by the MCP server
     and QConnect rejects an override (400).

   AgentCore namespaces a Lambda target's tools as `<targetName>___<toolName>` (the SAP order
   tool Lambda parses the trailing `___` segment of `bedrockAgentCoreToolName`). The gateway
   exposes five tools via this target — the canonical list is `SAP_GATEWAY_TOOLS` in
   `lib/agentcore-gateway-stack.ts`: `get_order_history`, `get_order_status`,
   `get_delivery_tracking`, `get_invoice_status` and `get_active_promotions`, backed by a
   DynamoDB table seeded with sample SAP SD order-to-cash data.

**Ordering:** `WisdomStack` depends on `AgentCoreGatewayStack` (the gateway must be a registered
MCP server on the instance before the agent that references its tools is created).

**How to re-capture these strings** if AWS changes the schema: configure the tools on an agent in
the console, **publish** the agent version, then `aws qconnect get-ai-agent …` and
`aws connect list-security-profile-applications …` and read the live `toolId` /
`applicationPermissions`. (Note: the console's draft must be **published** before the API
reflects the new tools.)
