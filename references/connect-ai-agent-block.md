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
4. Update `templates/cdk-app/flows/nova-sonic-*.json` to match.
