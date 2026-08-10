import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';
import { BlueprintStack } from './blueprint-stack';

export interface ContactFlowStackProps extends cdk.StackProps {
  instanceArn: string;
  instanceId: string;
  lexBotAliasArn: string;
  assistantArn: string;
  orchestrationAgentArn: string;
  queueArn: string;
  customerProfilesEnabled: boolean;
  /** ARN of the context-injection Lambda; required when customerProfilesEnabled. */
  contextInjectionLambdaArn?: string;
}

/**
 * Deploys the Amazon Connect contact flow.
 *
 * The base Nova Sonic flow ships with human transfer, tool calling, and call
 * recording built in — the flow file is deployed as-is, with only ARN/name
 * placeholder substitution for Lex, Wisdom, and the queue.
 */
export class ContactFlowStack extends BlueprintStack {
  public readonly contactFlowArn: string;
  public readonly contactFlowId: string;

  constructor(scope: Construct, id: string, props: ContactFlowStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'Contact flow deployment for the Nova Sonic AI agent';

    const flowPath = path.join(__dirname, '..', 'flows', 'basic-agent-flow.json');
    const flowJson = JSON.parse(fs.readFileSync(flowPath, 'utf-8'));
    let content = JSON.stringify(flowJson);

    const subs: Record<string, string> = {
      __QUEUE_ARN__: props.queueArn,
      __ASSISTANT_ARN__: props.assistantArn,
      __LEX_BOT_ALIAS_ARN__: props.lexBotAliasArn,
      __ORCHESTRATION_AGENT_ARN__: props.orchestrationAgentArn,
      // Substituted only when customer profiles is on; harmless no-op otherwise.
      __CONTEXT_INJECTION_LAMBDA_ARN__: props.contextInjectionLambdaArn ?? '',
      // Designer metadata for the "Enable AI Agent" dropdown needs the agent's
      // display name. It matches the name the Wisdom stack assigns the
      // orchestration agent (this.namer.wisdom('orchestrator')).
      __ORCHESTRATION_AGENT_NAME__: this.namer.wisdom('orchestrator'),
      // Lex dropdown metadata needs the bot's display name, matching the name
      // the Lex stack assigns (this.namer.lex('bot')).
      __LEX_BOT_NAME__: this.namer.lex('bot'),
      // Company name — resolved at render time from the values JSON.
      __COMPANY_NAME__: `{{companyName}}`,
      // TTS language for the set-voice action — resolved at render time. The
      // caller-facing VOICE is not a placeholder here: the flow reads it from
      // the prompt-texts data table ($.DataTables.GetPrompts.voice), seeded
      // per-gender from flows/prompt-texts-seed.json. Agentic voice catalog
      // (console picker subset), by locale:
      //   en-US: BLAKE BRENDA BROOKE CAROLINE DANIELLE JACQUELINE JAMESON
      //          JOANNA KATIE MARIAN MATTHEW RONALD TIFFANY
      //   de-DE: ALINA NICO SEBASTIAN VIKTORIA
      // These are a disjoint set from Polly (JOANNA/MATTHEW/TIFFANY collide by
      // NAME only — different audio under this engine) and must be UPPERCASE.
      // Gender has no metadata in the catalog; the seed's feminine/masculine
      // assignment (KATIE/RONALD, VIKTORIA/SEBASTIAN) was verified acoustically
      // by median F0 of the console samples (RONALD 95 / NICO 132 / SEBASTIAN
      // 144 Hz vs ALINA 197 / VIKTORIA 199 / KATIE 264 Hz — a clean 2-cluster
      // split) and by ear on live calls. Re-measure if the ids change; do not
      // infer gender from the name.
      __TTS_LANGUAGE_CODE__: `{{ttsLanguageCode}}`,
      // Voice provider for the Set-voice block. "connect:agentic" selects
      // Amazon Connect agentic voice (Connect-hosted); the Polly engines
      // (standard/neural/generative) and their voice catalog are a different,
      // disjoint set. Static rather than a values field: the whole blueprint is
      // built around this provider, and the accompanying voice ids in
      // prompt-texts-seed.json are only valid for it.
      //
      // Getting this string wrong fails at CALL time, not deploy time: any other
      // value passes CreateContactFlow validation and then takes the Set-voice
      // Error branch (or silently falls back to Joanna). In particular "Agentic"
      // is NOT valid. The runtime parses it case-insensitively, but emit exactly
      // this lowercase form — it is what the console emits.
      __TTS_ENGINE__: 'connect:agentic',
      // Data table ID/name — populated after the table is created (see below).
      __DATA_TABLE_ID__: '',
      __DATA_TABLE_NAME__: this.namer.connect('prompt-texts'),
      // Flow module references — resolved after modules are created (see below).
      __GET_CUSTOMER_PROFILE_MODULE_ID__: '',
      __GET_CUSTOMER_PROFILE_MODULE_NAME__: this.namer.connect('get-customer-profile'),
      // Flow name metadata.
      __FLOW_NAME__: this.namer.connect('basic-agent-flow'),
    };

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

    // --- Prompt Texts Data Table (Connect native) ---
    // A Connect data table holding localized prompt strings. Flows query it
    // via the "Data Table" block (Evaluate action) with language as the primary key.
    // Schema: language (primary, TEXT) + one TEXT attribute per prompt.
    // Access pattern: $.DataTables.<QueryName>.<attributeName>
    const promptDataTable = new connect.CfnDataTable(this, 'PromptTextsDataTable', {
      instanceArn: props.instanceArn,
      name: this.namer.connect('prompt-texts'),
      description: 'Localized prompt texts for contact flows, keyed by language.',
      status: 'PUBLISHED',
      timeZone: 'UTC',
      valueLockLevel: 'VALUE',
    });

    // Primary key: language
    const languageAttr = new connect.CfnDataTableAttribute(this, 'LanguageAttribute', {
      instanceArn: props.instanceArn,
      dataTableArn: promptDataTable.attrArn,
      name: 'language',
      valueType: 'TEXT',
      primary: true,
      description: 'Language code, e.g. de-DE, en-US',
    });
    languageAttr.addDependency(promptDataTable);

    // Prompt attributes (one column per prompt + voice)
    const promptAttrs: { id: string; name: string; description: string }[] = [
      { id: 'Voice', name: 'voice', description: 'Polly generative voice name for this language' },
      { id: 'ConsentVoice', name: 'recordingConsentVoice', description: 'DTMF recording consent prompt for voice channel' },
      { id: 'ConsentChat', name: 'recordingConsentChat', description: 'Recording consent text for chat channel' },
      { id: 'Goodbye', name: 'goodbye', description: 'Goodbye message played when the call ends' },
      { id: 'ErrorGeneric', name: 'errorGeneric', description: 'Generic error message for unrecoverable failures' },
      { id: 'AiAssistantIntro', name: 'aiAssistantIntro', description: 'Greeting the AI assistant opens with' },
    ];

    let lastAttr: cdk.CfnResource = languageAttr;
    for (const attr of promptAttrs) {
      const cfnAttr = new connect.CfnDataTableAttribute(this, `Attr${attr.id}`, {
        instanceArn: props.instanceArn,
        dataTableArn: promptDataTable.attrArn,
        name: attr.name,
        valueType: 'TEXT',
        description: attr.description,
      });
      cfnAttr.addDependency(promptDataTable);
      lastAttr = cfnAttr;
    }

    new cdk.CfnOutput(this, 'PromptTextsDataTableArn', { value: promptDataTable.attrArn });

    // --- Seed prompt records via Custom Resource ---
    // CfnDataTableRecord has issues resolving attribute IDs; use a Lambda-backed
    // custom resource that calls BatchCreateDataTableValue directly via SigV4.
    // The seed file is gender-keyed (feminine/masculine); select the set matching
    // this deployment's voiceGender (resolved at render time by render-templates.sh).
    const seedDataPath = path.join(__dirname, '..', 'flows', 'prompt-texts-seed.json');
    const seedAll = JSON.parse(fs.readFileSync(seedDataPath, 'utf-8'));
    const voiceGender = '{{voiceGender}}' as 'feminine' | 'masculine';
    const seedRecords = seedAll[voiceGender] ?? seedAll['feminine'];
    let seedDataResolved = JSON.stringify(seedRecords);
    // Apply render-time placeholder substitutions (e.g. {{companyName}}).
    for (const [k, v] of Object.entries(subs)) {
      seedDataResolved = seedDataResolved.split(k).join(v);
    }

    const seedFn = new lambda.Function(this, 'SeedPromptTexts', {
      functionName: this.namer.connect('seed-prompt-texts'),
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'flow', 'seed-prompt-texts')),
      timeout: cdk.Duration.seconds(30),
      environment: { LOG_LEVEL: 'INFO' },
      description: 'Custom resource: seeds prompt-texts data table via BatchCreateDataTableValue',
    });

    seedFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'connect:BatchCreateDataTableValue',
        'connect:BatchDeleteDataTableValue',
        'connect:BatchUpdateDataTableValue',
      ],
      resources: ['*'],
    }));

    const seedCr = new cdk.CustomResource(this, 'SeedPromptTextsResource', {
      serviceToken: seedFn.functionArn,
      properties: {
        InstanceId: props.instanceId,
        DataTableArn: promptDataTable.attrArn,
        Records: seedDataResolved,
        // The locale code (e.g. 'de-DE', 'en-US') whose record values should be
        // copied into the system Default row (no PrimaryValues). Resolved from
        // the rendered {{ttsLanguageCode}} which matches the seed data's primary keys.
        DefaultLanguage: `{{ttsLanguageCode}}`,
        // Hash forces CloudFormation to trigger Update when content changes.
        ContentHash: Buffer.from(seedDataResolved).toString('base64').slice(0, 32),
      },
    });
    seedCr.node.addDependency(lastAttr);

    // --- Consent & Analytics Setup Module ---
    // Deployed before the main flow so the flow can invoke it.
    const consentModulePath = path.join(__dirname, '..', 'flows', 'consent-analytics-setup.json');
    let consentModuleContent = fs.readFileSync(consentModulePath, 'utf-8');
    // Apply the same placeholder substitutions so voice/language/company values resolve.
    for (const [k, v] of Object.entries(subs)) {
      consentModuleContent = consentModuleContent.split(k).join(v);
    }
    const consentModule = new connect.CfnContactFlowModule(this, 'ConsentAnalyticsModule', {
      instanceArn: props.instanceArn,
      name: this.namer.connect('consent-analytics-setup'),
      content: consentModuleContent,
      description: 'Recording consent module — collects customer consent via DTMF (voice) or view (chat), enables/disables recording and analytics accordingly.',
    });
    // Ensure the data table and its records exist before flows that may query it.
    consentModule.addDependency(promptDataTable);

    new cdk.CfnOutput(this, 'ConsentAnalyticsModuleArn', { value: consentModule.attrContactFlowModuleArn });

    // --- Get Customer Profile Module ---
    // Looks up the caller's profile by email (from contact attributes) with
    // phone fallback (from ANI). Makes $.Customer.* fields available downstream.
    const profileModulePath = path.join(__dirname, '..', 'flows', 'get-customer-profile.json');
    let profileModuleContent = fs.readFileSync(profileModulePath, 'utf-8');
    for (const [k, v] of Object.entries(subs)) {
      profileModuleContent = profileModuleContent.split(k).join(v);
    }
    // Emit the fully substituted, import-ready module JSON next to the source
    // file. This is the file to import over the placeholder module in the
    // Connect console (see the KNOWN LIMITATION note below).
    fs.writeFileSync(
      path.join(__dirname, '..', 'flows', 'get-customer-profile.import.json'),
      profileModuleContent,
    );
    // KNOWN LIMITATION: the AWS::Connect::ContactFlowModule CFN handler rejects
    // module content that declares input/output parameters and custom branch
    // transitions (Metadata.settings) with InvalidContactFlowModuleException —
    // even though the identical JSON imports cleanly through the console. So
    // CloudFormation creates a minimal PLACEHOLDER module here, and the full
    // module (flows/get-customer-profile.json, rendered into the project dir)
    // must be imported over it manually in the Connect console after deploy.
    // The placeholder content is static, so subsequent cdk deploys produce no
    // diff on this resource and the manually imported content survives them.
    const profileModulePlaceholder = JSON.stringify({
      Version: '2019-10-30',
      StartAction: 'end',
      Metadata: {
        entryPointPosition: { x: 0, y: 0 },
        ActionMetadata: { end: { position: { x: 200, y: 0 } } },
      },
      Actions: [
        { Parameters: {}, Identifier: 'end', Type: 'EndFlowModuleExecution', Transitions: {} },
      ],
      Settings: {
        InputParameters: [],
        OutputParameters: [],
        Transitions: [
          { DisplayName: 'Success', ReferenceName: 'Success', Description: '' },
          { DisplayName: 'Error', ReferenceName: 'Error', Description: '' },
        ],
      },
    });
    const profileModule = new connect.CfnContactFlowModule(this, 'GetCustomerProfileModule', {
      instanceArn: props.instanceArn,
      name: this.namer.connect('get-customer-profile'),
      content: profileModulePlaceholder,
      description: 'Customer profile lookup module — PLACEHOLDER. Import flows/get-customer-profile.json from the project directory over this module in the Connect console.',
    });

    new cdk.CfnOutput(this, 'GetCustomerProfileModuleArn', { value: profileModule.attrContactFlowModuleArn });

    // Set the data table ID now that the table resource exists.
    subs.__DATA_TABLE_ID__ = promptDataTable.attrArn;
    // Set the profile module ID (UUID:$LATEST format) for the InvokeFlowModule action.
    // Fn.select/Fn.split resolve at deploy time — a plain .split('/') on the ARN
    // token would run at synth time against the token string and return the full
    // ARN instead of the module UUID.
    const profileModuleId = cdk.Fn.select(3, cdk.Fn.split('/', profileModule.attrContactFlowModuleArn));
    subs.__GET_CUSTOMER_PROFILE_MODULE_ID__ = `${profileModuleId}:$LATEST`;

    for (const [k, v] of Object.entries(subs)) {
      content = content.split(k).join(v);
    }

    const flow = new connect.CfnContactFlow(this, 'ContactFlow', {
      instanceArn: props.instanceArn,
      name: this.namer.connect('basic-agent-flow'),
      type: 'CONTACT_FLOW',
      content,
      description: 'Nova Sonic AI agent contact flow',
    });
    flow.addDependency(promptDataTable);

    this.contactFlowArn = flow.attrContactFlowArn;
    this.contactFlowId = flow.ref;

    new cdk.CfnOutput(this, 'ContactFlowArn', { value: this.contactFlowArn });
    new cdk.CfnOutput(this, 'ContactFlowId', { value: this.contactFlowId });
  }
}

