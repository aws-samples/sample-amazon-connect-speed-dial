import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';
import { BlueprintStack } from './blueprint-stack';
import { config } from './config';
import { applyTransfer, applyContextInjection, applyRecordingConsent, applyCustomerProfiles } from './flow-compose';

/**
 * Customer-facing flow strings that aren't user-editable, localized by language.
 * Keyed off the rendered config.promptLanguage ("German" | "English"). The
 * consent prompt keeps the __COMPANY_NAME__ placeholder embedded — it is
 * substituted alongside the other __PROP__ values below. These live here (not
 * in values.json) because render-templates.sh substitutes via a line-based sed
 * pipeline that cannot carry the consent prompt's embedded newlines.
 */
const FLOW_STRINGS: Record<string, { goodbye: string; error: string; consent: string }> = {
  English: {
    goodbye: 'Goodbye!',
    error: 'Sorry, something went wrong. Please try again later.',
    consent:
      'Welcome to __COMPANY_NAME__ customer service. Before we can help you we kindly want to ask you for permission to record this call in order to improve our service.\n\n' +
      "Please press 1 to allow a recording of this call or press 2 if you don't want to consent to the recording.",
  },
  German: {
    goodbye: 'Auf Wiederhören!',
    error: 'Entschuldigung, es ist ein Fehler aufgetreten. Bitte versuchen Sie es später erneut.',
    consent:
      'Willkommen beim Kundenservice von __COMPANY_NAME__. Bevor wir Ihnen helfen können, möchten wir Sie um Ihre Einwilligung bitten, dieses Gespräch zur Verbesserung unseres Service aufzuzeichnen.\n\n' +
      'Bitte drücken Sie die 1, um der Aufzeichnung zuzustimmen, oder die 2, wenn Sie nicht einverstanden sind.',
  },
};

export interface ContactFlowStackProps extends cdk.StackProps {
  instanceArn: string;
  instanceId: string;
  lexBotAliasArn: string;
  assistantArn: string;
  orchestrationAgentArn: string;
  queueArn: string;
  transferEnabled: boolean;
  toolEnabled: boolean;
  contextInjectionEnabled: boolean;
  /** ARN of the context-injection Lambda; required when contextInjectionEnabled. */
  contextInjectionLambdaArn?: string;
  customerProfilesEnabled: boolean;
  /** ARN of the profile-lookup Lambda; required when customerProfilesEnabled. */
  profileLookupLambdaArn?: string;
  recordingEnabled: boolean;
}

/**
 * Deploys the Amazon Connect contact flow.
 *
 * Loads the base Nova Sonic flow and layers optional capabilities: when
 * `transferEnabled`, the agent's Escalate outcome is routed to a human queue;
 * when `toolEnabled`, a sample Lambda is provisioned and associated with Connect
 * + Wisdom for in-flow tool invocation. ARN placeholders for Lex, Wisdom, and the
 * queue are substituted into the flow JSON before creation.
 */
export class ContactFlowStack extends BlueprintStack {
  public readonly contactFlowArn: string;
  public readonly contactFlowId: string;

  constructor(scope: Construct, id: string, props: ContactFlowStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'Contact flow deployment for the Nova Sonic AI agent';

    const flowPath = path.join(__dirname, '..', 'flows', 'nova-sonic-base.json');
    let flowJson = JSON.parse(fs.readFileSync(flowPath, 'utf-8'));
    if (props.transferEnabled) {
      flowJson = applyTransfer(flowJson);
    }
    // Order matters: each precall Lambda is chained to run last before the AI
    // Agent block, so apply-order == run-order. Context injection runs FIRST as
    // a static demo *baseline*, then Customer Profiles runs LAST so a real
    // per-user profile (which carries the user's own identity AND activity
    // attributes) OVERRIDES that baseline. Result: with no profile match the
    // agent gets the demo context; with a matching profile it gets that user's
    // real data.
    if (props.contextInjectionEnabled) {
      if (!props.contextInjectionLambdaArn) {
        throw new Error('contextInjectionEnabled requires contextInjectionLambdaArn');
      }
      flowJson = applyContextInjection(flowJson);
    }
    if (props.customerProfilesEnabled) {
      if (!props.profileLookupLambdaArn) {
        throw new Error('customerProfilesEnabled requires profileLookupLambdaArn');
      }
      flowJson = applyCustomerProfiles(flowJson);
    }
    // Applied last so the consent gate becomes the flow's entry point and both
    // branches rejoin whatever the prior start was (e.g. enable-logs).
    const strings = FLOW_STRINGS[config.promptLanguage] ?? FLOW_STRINGS.English;
    if (props.recordingEnabled) {
      flowJson = applyRecordingConsent(flowJson, strings.consent);
    }
    let content = JSON.stringify(flowJson);

    const subs: Record<string, string> = {
      __QUEUE_ARN__: props.queueArn,
      __ASSISTANT_ARN__: props.assistantArn,
      __LEX_BOT_ALIAS_ARN__: props.lexBotAliasArn,
      __ORCHESTRATION_AGENT_ARN__: props.orchestrationAgentArn,
      // Substituted only when context injection is on; harmless no-op otherwise.
      __CONTEXT_INJECTION_LAMBDA_ARN__: props.contextInjectionLambdaArn ?? '',
      // Substituted only when customer profiles is on; harmless no-op otherwise.
      __PROFILE_LOOKUP_LAMBDA_ARN__: props.profileLookupLambdaArn ?? '',
      // Designer metadata for the "Enable AI Agent" dropdown needs the agent's
      // display name. It matches the name the Wisdom stack assigns the
      // orchestration agent (this.namer.wisdom('orchestrator')).
      __ORCHESTRATION_AGENT_NAME__: this.namer.wisdom('orchestrator'),
      // Lex dropdown metadata needs the bot's display name, matching the name
      // the Lex stack assigns (this.namer.lex('bot')).
      __LEX_BOT_NAME__: this.namer.lex('bot'),
      __GREETING__: `{{greeting}}`,
      // Company name for the recording-consent prompt — resolved at render time
      // from the values JSON, same pattern as the greeting.
      __COMPANY_NAME__: `{{companyName}}`,
      // TTS voice + language for the set-voice action — resolved at render time
      // from the chosen language/voice (e.g. Joanna/en-US, Vicki/de-DE).
      __VOICE_ID__: `{{voiceId}}`,
      __TTS_LANGUAGE_CODE__: `{{ttsLanguageCode}}`,
      // Goodbye/error strings, localized by config.promptLanguage. The consent
      // prompt is localized the same way and injected by applyRecordingConsent.
      __BYE_MESSAGE__: strings.goodbye,
      __ERROR_MESSAGE__: strings.error,
    };

    if (props.toolEnabled) {
      const fn = new nodejs.NodejsFunction(this, 'SampleTool', {
        entry: path.join(__dirname, '..', 'lambda', 'tools', 'sample-tool', 'index.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(10),
        description: 'Sample tool Lambda invoked by the AI agent via Wisdom tool calling',
      });
      fn.addPermission('ConnectInvoke', {
        principal: new iam.ServicePrincipal('connect.amazonaws.com'),
        sourceArn: props.instanceArn,
      });
      // Scope the Q in Connect (wisdom) invoke permission to prevent the
      // cross-service confused-deputy problem. AWS does not publish the exact
      // SourceArn that wisdom.amazonaws.com presents when invoking a flow/tool
      // Lambda (the Connect confused-deputy guide has examples for profile/
      // voiceid/connect principals, but none for wisdom), so we avoid pinning a
      // guessed assistant/agent/session ARN that could deny legitimate calls at
      // runtime. Instead we use the wildcard form the guide explicitly sanctions
      // for unknown ARNs (arn:aws:{service}:{region}:{account}:*) plus a
      // SourceAccount condition — bounding access to this account's wisdom
      // resources without risking a wrong-ARN denial.
      // See: https://docs.aws.amazon.com/connect/latest/adminguide/cross-service-confused-deputy-prevention.html
      fn.addPermission('WisdomInvoke', {
        principal: new iam.ServicePrincipal('wisdom.amazonaws.com'),
        sourceArn: `arn:aws:wisdom:${this.region}:${this.account}:*`,
        sourceAccount: this.account,
      });
      new connect.CfnIntegrationAssociation(this, 'LambdaAssociation', {
        instanceId: props.instanceArn,
        integrationType: 'LAMBDA_FUNCTION',
        integrationArn: fn.functionArn,
      });
    }

    for (const [k, v] of Object.entries(subs)) {
      content = content.split(k).join(v);
    }

    const flow = new connect.CfnContactFlow(this, 'ContactFlow', {
      instanceArn: props.instanceArn,
      name: this.namer.connect('nova-sonic'),
      type: 'CONTACT_FLOW',
      content,
      description: 'Nova Sonic AI agent contact flow',
    });

    this.contactFlowArn = flow.attrContactFlowArn;
    this.contactFlowId = flow.ref;

    new cdk.CfnOutput(this, 'ContactFlowArn', { value: this.contactFlowArn });
    new cdk.CfnOutput(this, 'ContactFlowId', { value: this.contactFlowId });
  }
}
