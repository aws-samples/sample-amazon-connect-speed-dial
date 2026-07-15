import * as assert from 'assert';
import { applyTransfer, applyRecordingConsent } from './flow-compose';

// Minimal flow shaped like the base flow's relevant parts.
function baseFlow() {
  return {
    Actions: [
      {
        Identifier: 'compare-tool',
        Type: 'Compare',
        Parameters: { ComparisonValue: '$.Lex.SessionAttributes.Tool' },
        Transitions: {
          NextAction: 'bye-msg',
          Conditions: [
            { NextAction: 'bye-msg', Condition: { Operator: 'Equals', Operands: ['Escalate'] } },
            { NextAction: 'bye-msg', Condition: { Operator: 'Equals', Operands: ['Complete'] } },
          ],
          Errors: [{ NextAction: 'bye-msg', ErrorType: 'NoMatchingCondition' }],
        },
      },
      { Identifier: 'bye-msg', Type: 'MessageParticipant', Parameters: { Text: 'Goodbye!' },
        Transitions: { NextAction: 'disconnect', Errors: [] } },
      { Identifier: 'disconnect', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
    Metadata: { ActionMetadata: {} },
  };
}

// 1. Escalate condition reroutes to transfer-to-queue.
{
  const out = applyTransfer(baseFlow());
  const cmp = out.Actions.find((a: any) => a.Identifier === 'compare-tool');
  const esc = cmp.Transitions.Conditions.find((c: any) => c.Condition.Operands[0] === 'Escalate');
  assert.strictEqual(esc.NextAction, 'transfer-to-queue', 'Escalate must route to transfer-to-queue');
  const cmpl = cmp.Transitions.Conditions.find((c: any) => c.Condition.Operands[0] === 'Complete');
  assert.strictEqual(cmpl.NextAction, 'bye-msg', 'Complete still routes to bye-msg');
}

// 2. transfer-to-queue action is appended with correct type.
{
  const out = applyTransfer(baseFlow());
  const xfer = out.Actions.find((a: any) => a.Identifier === 'transfer-to-queue');
  assert.ok(xfer, 'transfer-to-queue action exists');
  assert.strictEqual(xfer.Type, 'TransferContactToQueue');
}

// 3. Idempotent: applying twice does not duplicate the action.
{
  const out = applyTransfer(applyTransfer(baseFlow()));
  const count = out.Actions.filter((a: any) => a.Identifier === 'transfer-to-queue').length;
  assert.strictEqual(count, 1, 'transfer-to-queue not duplicated');
}

// 4. Input is not mutated.
{
  const input = baseFlow();
  applyTransfer(input);
  assert.ok(!input.Actions.find((a: any) => a.Identifier === 'transfer-to-queue'), 'input untouched');
}

// 5. Flow without compare-tool action: transfer-to-queue is still appended, no error.
{
  const minimal = {
    Actions: [
      { Identifier: 'start', Type: 'MessageParticipant', Parameters: { Text: 'Hello' },
        Transitions: { NextAction: 'disconnect', Errors: [] } },
      { Identifier: 'disconnect', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
    Metadata: { ActionMetadata: {} },
  };
  const out = applyTransfer(minimal);
  const xfer = out.Actions.find((a: any) => a.Identifier === 'transfer-to-queue');
  assert.ok(xfer, 'transfer-to-queue exists even without compare-tool');
  assert.strictEqual(xfer.Type, 'TransferContactToQueue');
}

// --- applyRecordingConsent -------------------------------------------------

// Minimal flow with the voice/language preamble the real base flow has, so we
// can assert the consent gate is spoken AFTER the voice/language are set.
function voiceFlow() {
  return {
    StartAction: 'enable-logs',
    Actions: [
      { Identifier: 'enable-logs', Type: 'UpdateFlowLoggingBehavior', Parameters: {},
        Transitions: { NextAction: 'set-voice', Errors: [] } },
      { Identifier: 'set-voice', Type: 'UpdateContactTextToSpeechVoice', Parameters: { TextToSpeechVoice: 'Vicki' },
        Transitions: { NextAction: 'set-language', Errors: [] } },
      { Identifier: 'set-language', Type: 'UpdateContactData', Parameters: { LanguageCode: 'de-DE' },
        Transitions: { NextAction: 'set-queue', Errors: [] } },
      { Identifier: 'set-queue', Type: 'UpdateContactTargetQueue', Parameters: {},
        Transitions: { NextAction: 'disconnect', Errors: [] } },
      { Identifier: 'disconnect', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
    Metadata: { ActionMetadata: {} },
  };
}

// Walk the transition chain from StartAction, return the ordered Identifiers.
function chain(flow: any): string[] {
  const acts: Record<string, any> = {};
  for (const a of flow.Actions) acts[a.Identifier] = a;
  const order: string[] = [];
  let cur = flow.StartAction;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    order.push(cur);
    cur = acts[cur]?.Transitions?.NextAction;
  }
  return order;
}

// 6. The consent prompt is spoken AFTER set-voice and set-language, so it
//    inherits the configured (e.g. German) voice — not before, where it would
//    use the instance default voice.
{
  const out = applyRecordingConsent(voiceFlow(), 'Bitte druecken Sie die 1.');
  const order = chain(out);
  const voiceIdx = order.indexOf('set-voice');
  const langIdx = order.indexOf('set-language');
  const consentIdx = order.indexOf('recording-consent');
  assert.ok(voiceIdx >= 0 && langIdx >= 0, 'set-voice and set-language remain in the chain');
  assert.ok(consentIdx > voiceIdx, 'consent prompt comes after set-voice');
  assert.ok(consentIdx > langIdx, 'consent prompt comes after set-language');
}

// 7. The flow still starts at the original StartAction (voice/language run first).
{
  const out = applyRecordingConsent(voiceFlow(), 'x');
  assert.strictEqual(out.StartAction, 'enable-logs', 'StartAction unchanged; voice/language run before consent');
}

// 8. The consent text is carried into the GetParticipantInput action.
{
  const out = applyRecordingConsent(voiceFlow(), 'CONSENT-TEXT-MARKER');
  const consent = out.Actions.find((a: any) => a.Identifier === 'recording-consent');
  assert.ok(consent, 'recording-consent action exists');
  assert.strictEqual(consent.Type, 'GetParticipantInput');
  assert.strictEqual(consent.Parameters.Text, 'CONSENT-TEXT-MARKER');
}

// 9. Both consent branches enable/disable recording and rejoin the downstream
//    action that originally followed set-language (set-queue), so the rest of
//    the flow is unchanged.
{
  const out = applyRecordingConsent(voiceFlow(), 'x');
  const enable = out.Actions.find((a: any) => a.Identifier === 'enable-recording');
  const disable = out.Actions.find((a: any) => a.Identifier === 'disable-recording');
  assert.strictEqual(enable.Parameters.VoiceBehavior.VoiceRecordingBehavior.IVRRecordingBehavior, 'Enabled');
  assert.strictEqual(enable.Transitions.NextAction, 'set-queue', 'enable rejoins set-queue');
  assert.strictEqual(disable.Transitions.NextAction, 'set-queue', 'disable rejoins set-queue');
  // set-language now routes into the consent gate.
  const lang = out.Actions.find((a: any) => a.Identifier === 'set-language');
  assert.strictEqual(lang.Transitions.NextAction, 'recording-consent', 'set-language flows into consent gate');
}

// 10. Idempotent: applying twice does not duplicate the consent action.
{
  const out = applyRecordingConsent(applyRecordingConsent(voiceFlow(), 'x'), 'x');
  const count = out.Actions.filter((a: any) => a.Identifier === 'recording-consent').length;
  assert.strictEqual(count, 1, 'recording-consent not duplicated');
}

console.log('PASS: flow-compose');
