/**
 * Contact-flow composition helpers.
 *
 * The base flow (`flows/basic-agent-flow.json`) is the Q&A agent. Optional
 * capabilities are layered on by pure transforms so any combination produces a
 * valid flow. Transforms are idempotent and never mutate their input.
 */

/** Deep clone via JSON round-trip (flow objects are plain JSON). */
function clone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o));
}

/**
 * Enable human transfer: route the orchestration agent's `Escalate` outcome to a
 * `TransferContactToQueue` action (added if absent) instead of the goodbye message.
 * Mirrors the former `nova-sonic-qa-transfer.json` flavor.
 */
export function applyTransfer(flow: any): any {
  const out = clone(flow);
  const actions: any[] = out.Actions;

  // Append the transfer action once.
  if (!actions.find((a) => a.Identifier === 'transfer-to-queue')) {
    actions.push({
      Identifier: 'transfer-to-queue',
      Type: 'TransferContactToQueue',
      Parameters: {},
      Transitions: {
        NextAction: 'disconnect',
        Errors: [
          { NextAction: 'bye-msg', ErrorType: 'QueueAtCapacity' },
          { NextAction: 'disconnect', ErrorType: 'NoMatchingError' },
        ],
      },
    });
  }

  // Reroute the Escalate condition.
  const cmp = actions.find((a) => a.Identifier === 'compare-tool');
  if (cmp && cmp.Transitions && Array.isArray(cmp.Transitions.Conditions)) {
    for (const c of cmp.Transitions.Conditions) {
      if (c.Condition && Array.isArray(c.Condition.Operands) && c.Condition.Operands[0] === 'Escalate') {
        c.NextAction = 'transfer-to-queue';
      }
    }
  }

  // Add minimal metadata so the Connect console can render the node.
  if (out.Metadata && out.Metadata.ActionMetadata) {
    out.Metadata.ActionMetadata['transfer-to-queue'] = { position: { x: 1620, y: 320 } };
  }

  return out;
}

/**
 * Enable pre-call context injection: invoke a Lambda that pushes caller context
 * into the Q Connect session before the agent starts.
 *
 * Mirrors the reference flow's structure (see references / the sample
 * SampleContextInjection.json): a *standalone* session setup
 * (CreateWisdomSession + UpdateContactData) runs first to bind a Wisdom session
 * to the contact, then the Lambda runs (its DescribeContact lookup needs that
 * bound session), and only then does the original AI Agent compound block run —
 * fully intact. Both CreateWisdomSession calls target the same assistant, so
 * they resolve to the same session: the Lambda writes context into it and the
 * agent reads it.
 *
 * Keeping the `create-wisdom-session → update-contact-data → connect-lex-bot`
 * compound untouched is essential — splitting it (by inserting the Lambda
 * between its children) makes the Connect console stop recognizing it as the
 * "Enable AI Agent" block and the AI-agent toggle turns off.
 *
 * The Lambda ARN is left as a placeholder (`__CONTEXT_INJECTION_LAMBDA_ARN__`)
 * for ContactFlowStack to substitute alongside the other ARN placeholders.
 */
/**
 * Idempotently insert a standalone session setup (CreateWisdomSession +
 * UpdateContactData) ahead of the AI Agent compound block, so any Lambda that
 * needs a bound Wisdom session (its DescribeContact lookup) can run before the
 * compound. Returns the id of the last action in the precall chain — its
 * `NextAction` currently points at the compound and is where the next precall
 * Lambda should be chained.
 *
 * The compound block (`create-wisdom-session → update-contact-data →
 * connect-lex-bot`) is never split — keeping it contiguous is what lets the
 * Connect console recognize the "Enable AI Agent" block.
 */
function ensurePrecallSession(out: any): string {
  const actions: any[] = out.Actions;
  const compoundSession = actions.find((a) => a.Identifier === 'create-wisdom-session');
  if (!compoundSession) {
    throw new Error('ensurePrecallSession: base flow is missing the create-wisdom-session action');
  }
  if (!actions.find((a) => a.Identifier === 'precall-create-session')) {
    const predecessor = actions.find(
      (a) => a.Transitions && a.Transitions.NextAction === 'create-wisdom-session',
    );
    if (!predecessor) {
      throw new Error('ensurePrecallSession: no action transitions into create-wisdom-session');
    }
    const assistantArn = compoundSession.Parameters?.WisdomAssistantArn;
    if (!assistantArn) {
      throw new Error('ensurePrecallSession: create-wisdom-session has no WisdomAssistantArn');
    }
    actions.push(
      {
        Identifier: 'precall-create-session',
        Type: 'CreateWisdomSession',
        Parameters: { WisdomAssistantArn: assistantArn },
        Transitions: {
          NextAction: 'precall-update-contact-data',
          Errors: [{ NextAction: 'error-msg', ErrorType: 'NoMatchingError' }],
        },
      },
      {
        Identifier: 'precall-update-contact-data',
        Type: 'UpdateContactData',
        Parameters: { WisdomSessionArn: '$.Wisdom.SessionArn' },
        // Initially chains straight into the compound; precall Lambdas splice in here.
        Transitions: {
          NextAction: 'create-wisdom-session',
          Errors: [{ NextAction: 'error-msg', ErrorType: 'NoMatchingError' }],
        },
      },
    );
    predecessor.Transitions.NextAction = 'precall-create-session';
    if (out.Metadata && out.Metadata.ActionMetadata) {
      out.Metadata.ActionMetadata['precall-create-session'] = { position: { x: 880, y: 200 } };
      out.Metadata.ActionMetadata['precall-update-contact-data'] = { position: { x: 880, y: 320 } };
    }
  }
  return 'precall-update-contact-data';
}

/**
 * Chain a SYNCHRONOUS InvokeLambdaFunction into the precall sequence, just
 * before whatever currently runs after `precall-update-contact-data` (the AI
 * Agent compound, or an already-inserted precall Lambda). Idempotent per id.
 * A failure degrades to `error-msg` rather than blocking the call.
 */
function insertPrecallLambda(out: any, id: string, lambdaArnPlaceholder: string, yPos: number): void {
  const actions: any[] = out.Actions;
  ensurePrecallSession(out);
  if (actions.find((a) => a.Identifier === id)) return;

  // Find the action that currently transitions into the compound block, and
  // splice the new Lambda between it and the compound — preserving any
  // previously-inserted precall Lambdas in the chain.
  const chainTail = actions.find(
    (a) => a.Transitions && a.Transitions.NextAction === 'create-wisdom-session',
  );
  if (!chainTail) {
    throw new Error('insertPrecallLambda: no action transitions into create-wisdom-session');
  }
  actions.push({
    Identifier: id,
    Type: 'InvokeLambdaFunction',
    Parameters: {
      LambdaFunctionARN: lambdaArnPlaceholder,
      InvocationTimeLimitSeconds: '6',
      InvocationType: 'SYNCHRONOUS',
      ResponseValidation: { ResponseType: 'JSON' },
    },
    Transitions: {
      NextAction: 'create-wisdom-session',
      Errors: [{ NextAction: 'error-msg', ErrorType: 'NoMatchingError' }],
    },
  });
  chainTail.Transitions.NextAction = id;
  if (out.Metadata && out.Metadata.ActionMetadata) {
    out.Metadata.ActionMetadata[id] = { position: { x: 880, y: yPos } };
  }
}

/**
 * Enable caller context injection: a Lambda resolves the caller's Customer
 * Profile and pushes identity data into the Q Connect session before the agent
 * starts. See ensurePrecallSession / insertPrecallLambda. The Lambda ARN is
 * left as a placeholder for ContactFlowStack to substitute.
 */
export function applyContextInjection(
  flow: any,
  lambdaArnPlaceholder = '__CONTEXT_INJECTION_LAMBDA_ARN__',
): any {
  const out = clone(flow);
  insertPrecallLambda(out, 'provide-agent-context', lambdaArnPlaceholder, 440);
  return out;
}

/**
 * Enable call recording with a DTMF consent gate, inserted just after the
 * voice/language preamble so the prompt is spoken in the configured TTS voice.
 *
 * The base flow opens with `set-voice` (TTS voice) and `set-language` (Lex/TTS
 * locale). The consent gate is spliced in immediately after those run — it is
 * NOT made the `StartAction`, because a prompt spoken before `set-voice` uses
 * the instance default voice (e.g. an en-US voice reading German text). The
 * action that fed the gate's insertion point now routes into the gate:
 * `GetParticipantInput` press 1 to allow recording, 2 (or timeout / no-match)
 * to decline. Consent → `enable-recording` (records Agent + Customer with
 * `IVRRecordingBehavior: Enabled` — required for audio capture in this
 * automated AI-agent flow); decline → `disable-recording`. Both converge on the
 * original downstream action, so the rest of the flow is unchanged.
 *
 * The insertion point is after `set-language` if present, else `set-voice`,
 * else the flow's `StartAction` (so flows without a voice preamble still get a
 * working gate). Sits upstream of the AI Agent compound block and the
 * context-injection actions, so it composes independently. The consent prompt's
 * company name is left as the `__COMPANY_NAME__` placeholder for
 * ContactFlowStack to substitute.
 */
export function applyRecordingConsent(flow: any, consentText: string): any {
  const out = clone(flow);
  const actions: any[] = out.Actions;

  // Splice the gate in after the voice/language preamble so the consent prompt
  // inherits the configured TTS voice. `anchor` is the action whose NextAction
  // we redirect into the gate; `downstream` is where both branches rejoin (the
  // action that anchor originally pointed to). Fall back to the StartAction when
  // there is no voice preamble.
  const anchor = actions.find((a) => a.Identifier === 'set-language')
    ?? actions.find((a) => a.Identifier === 'set-voice');
  const downstream = anchor ? anchor.Transitions.NextAction : out.StartAction;

  const recordingBehavior = (record: boolean) => ({
    VoiceBehavior: {
      VoiceRecordingBehavior: {
        RecordedParticipants: record ? ['Agent', 'Customer'] : [],
        IVRRecordingBehavior: record ? 'Enabled' : 'Disabled',
      },
      VoiceAnalyticsBehavior: { Enabled: 'False' },
    },
  });

  if (!actions.find((a) => a.Identifier === 'recording-consent')) {
    actions.push(
      {
        Identifier: 'recording-consent',
        Type: 'GetParticipantInput',
        Parameters: {
          StoreInput: 'False',
          InputTimeLimitSeconds: '5',
          Text: consentText,
        },
        Transitions: {
          NextAction: 'disable-recording',
          Conditions: [
            { NextAction: 'enable-recording', Condition: { Operator: 'Equals', Operands: ['1'] } },
            { NextAction: 'disable-recording', Condition: { Operator: 'Equals', Operands: ['2'] } },
          ],
          Errors: [
            { NextAction: 'disable-recording', ErrorType: 'InputTimeLimitExceeded' },
            { NextAction: 'disable-recording', ErrorType: 'NoMatchingCondition' },
            { NextAction: 'disable-recording', ErrorType: 'NoMatchingError' },
          ],
        },
      },
      {
        Identifier: 'enable-recording',
        Type: 'UpdateContactRecordingAndAnalyticsBehavior',
        Parameters: recordingBehavior(true),
        Transitions: {
          NextAction: downstream,
          Errors: [
            { NextAction: downstream, ErrorType: 'NoMatchingError' },
            { NextAction: downstream, ErrorType: 'ChannelMismatch' },
          ],
        },
      },
      {
        Identifier: 'disable-recording',
        Type: 'UpdateContactRecordingAndAnalyticsBehavior',
        Parameters: recordingBehavior(false),
        Transitions: {
          NextAction: downstream,
          Errors: [
            { NextAction: downstream, ErrorType: 'NoMatchingError' },
            { NextAction: downstream, ErrorType: 'ChannelMismatch' },
          ],
        },
      },
    );
  }

  // Route into the consent gate after the voice/language preamble. With an
  // anchor, the preamble still runs first (so the prompt uses the right voice);
  // without one, the gate becomes the entry point.
  if (anchor) {
    anchor.Transitions.NextAction = 'recording-consent';
  } else {
    out.StartAction = 'recording-consent';
  }

  if (out.Metadata && out.Metadata.ActionMetadata) {
    out.Metadata.ActionMetadata['recording-consent'] = { position: { x: -260, y: 40 } };
    out.Metadata.ActionMetadata['enable-recording'] = { position: { x: 10, y: 40 } };
    out.Metadata.ActionMetadata['disable-recording'] = { position: { x: 10, y: 300 } };
  }

  return out;
}
