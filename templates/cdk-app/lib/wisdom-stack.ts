import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as wisdom from 'aws-cdk-lib/aws-wisdom';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lex from 'aws-cdk-lib/aws-lex';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Construct } from 'constructs';
import { BlueprintStack } from './blueprint-stack';
import { config } from './config';
import { SAP_GATEWAY_TARGET, SAP_GATEWAY_TOOLS } from './agentcore-gateway-stack';

/**
 * Read a prompt body from the project's `prompts/` directory.
 *
 * Prompt text lives in editable files (`prompts/orchestration.md`,
 * `prompts/self-service.md`) rather than inline here, so users can customize
 * the orchestration and self-service prompts without editing stack code. The
 * files are rendered (with `{{companyName}}` substituted) before synth;
 * Q Connect runtime variables like `{{$.contentExcerpt}}` are left intact.
 */
function readPrompt(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'prompts', `${name}.md`), 'utf8');
}

/**
 * Short content hash used to make a prompt-version construct's logical ID
 * change when the prompt text changes.
 *
 * A `CfnAIPromptVersion` is immutable: it snapshots `$LATEST` at create time and
 * the agent references that snapshot. If the prompt text later changes, the
 * existing version keeps serving the old content — so edits never reach the
 * agent. Embedding this hash in the version's construct id forces CloudFormation
 * to create a fresh version resource (snapshotting the new `$LATEST`) and delete
 * the old one whenever the prompt changes; the agent, which references the
 * version's id, repoints automatically.
 */
function promptHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

export interface WisdomStackProps extends cdk.StackProps {
  instanceArn: string;
  instanceId: string;
  /**
   * Namespace of the AgentCore gateway's MCP server application (the gateway
   * id) — used to grant the gateway's MCP tools on the AI-agent security
   * profile. The bare gateway id is the application namespace the Connect
   * console shows (minus its `gateway_` display prefix).
   */
  gatewayNamespace?: string;
}

export class WisdomStack extends BlueprintStack {
  public readonly assistantArn: string;
  public readonly assistantId: string;
  public readonly orchestrationAgentId: string;
  public readonly orchestrationAgentArn: string;
  public readonly selfServiceAgentId: string;
  public readonly knowledgeBaseArn: string;
  public readonly botAliasArn: string;

  constructor(scope: Construct, id: string, props: WisdomStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'Q-in-Connect assistant, knowledge base, AI agents, and prompts';

    const assistant = new wisdom.CfnAssistant(this, 'Assistant', {
      name: this.namer.wisdom('assistant'),
      type: 'AGENT',
      description: 'Q-in-Connect assistant for {{projectName}}',
    });

    const kb = new wisdom.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: this.namer.wisdom('kb'),
      knowledgeBaseType: 'CUSTOM',
      description: 'Empty KB — populate via S3 sync or web crawler later',
    });

    const kbAssociation = new wisdom.CfnAssistantAssociation(this, 'KbAssociation', {
      assistantId: assistant.attrAssistantId,
      association: { knowledgeBaseId: kb.attrKnowledgeBaseId },
      associationType: 'KNOWLEDGE_BASE',
    });

    // --- Bedrock Managed Knowledge Base (optional, gated by knowledgeBaseEnabled) ---
    // Creates a Bedrock KB with S3 data source and associates it with the
    // assistant as an EXTERNAL_BEDROCK_KNOWLEDGE_BASE. This gives the Retrieve
    // tool access to indexed documents from S3.
    let bedrockKbAssociation: wisdom.CfnAssistantAssociation | undefined;

    if (config.knowledgeBaseEnabled) {
      // Dedicated S3 bucket for knowledge-base source documents. Kept separate
      // from the Connect storage bucket so the KB's documents aren't subject to
      // the storage bucket's Glacier lifecycle (which would make them unreadable
      // for re-ingestion) and so encryption stays S3-managed (no customer KMS
      // key — Bedrock reads objects without needing kms:Decrypt grants).
      const kbBucket = new s3.Bucket(this, 'KnowledgeBaseBucket', {
        bucketNamePrefix: this.namer.connect('kb-docs'),
        bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        versioned: true,
        removalPolicy: config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: !config.retainData,
        lifecycleRules: [
          {
            id: 'RetainLast3Versions',
            noncurrentVersionExpiration: cdk.Duration.days(1),
            noncurrentVersionsToRetain: 3,
          },
        ],
      });

      // Deny uploads using customer-provided encryption keys (SSE-C)
      kbBucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'RestrictSSECObjectUploads',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [kbBucket.arnForObjects('*')],
        conditions: {
          Null: { 's3:x-amz-server-side-encryption-customer-algorithm': 'false' },
        },
      }));

      // S3 Vectors store — CloudFormation does not auto-provision the vector
      // bucket/index (that is a console "Quick create" convenience), so create
      // them explicitly. The index dimension (1024), dataType (float32), and the
      // AMAZON_BEDROCK_* non-filterable metadata keys are the values Bedrock KB
      // requires for the Titan v2 embedding model.
      const vectorBucket = new s3vectors.CfnVectorBucket(this, 'KbVectorBucket', {
        vectorBucketName: this.namer.connect('kb-vectors'),
      });

      const vectorIndex = new s3vectors.CfnIndex(this, 'KbVectorIndex', {
        indexName: 'bedrock-kb-index',
        vectorBucketArn: vectorBucket.attrVectorBucketArn,
        dataType: 'float32',
        dimension: 1024,
        distanceMetric: 'cosine',
        metadataConfiguration: {
          nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
        },
      });
      vectorIndex.node.addDependency(vectorBucket);

      // IAM role for Bedrock to access S3, invoke the embedding model, and use
      // the S3 Vectors store.
      const bedrockKbRole = new iam.Role(this, 'BedrockKbRole', {
        assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
          conditions: {
            StringEquals: { 'aws:SourceAccount': this.account },
            ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*` },
          },
        }),
        description: 'Service role for Bedrock Knowledge Base - embedding model, S3, and S3 Vectors access',
        inlinePolicies: {
          BedrockKbPolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                sid: 'InvokeEmbeddingModel',
                actions: ['bedrock:InvokeModel'],
                resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
              }),
              new iam.PolicyStatement({
                sid: 'InvokeParsingModel',
                actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:GetInferenceProfile'],
                resources: [
                  `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/{{kbParsingModelId}}`,
                ],
              }),
              // Cross-region inference profiles route to any region in the
              // geographic prefix. The target region checks bedrock:InvokeModel
              // against the foundation-model ARN in THAT region. Rather than
              // enumerating every possible EU region (new regions get added),
              // we wildcard the region and scope via condition key so the
              // permission only applies when invoked through our inference profile.
              new iam.PolicyStatement({
                sid: 'InvokeParsingModelCrossRegion',
                actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                resources: [
                  `arn:aws:bedrock:*::foundation-model/${'{{kbParsingModelId}}'.replace(/^[a-z]{2}\./, '')}`,
                ],
                conditions: {
                  StringEquals: {
                    'bedrock:InferenceProfileArn': `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/{{kbParsingModelId}}`,
                  },
                },
              }),
              new iam.PolicyStatement({
                sid: 'ReadS3DataSource',
                actions: ['s3:GetObject', 's3:ListBucket'],
                resources: [
                  kbBucket.bucketArn,
                  kbBucket.arnForObjects('*'),
                ],
              }),
              new iam.PolicyStatement({
                sid: 'S3VectorsAccess',
                actions: [
                  's3vectors:GetVectorBucket',
                  's3vectors:GetIndex',
                  's3vectors:PutVectors',
                  's3vectors:GetVectors',
                  's3vectors:QueryVectors',
                  's3vectors:ListVectors',
                  's3vectors:DeleteVectors',
                ],
                resources: [
                  vectorBucket.attrVectorBucketArn,
                  `${vectorBucket.attrVectorBucketArn}/*`,
                ],
              }),
            ],
          }),
        },
      });

      // Bedrock Knowledge Base — uses the S3 Vectors store created above.
      const bedrockKb = new bedrock.CfnKnowledgeBase(this, 'BedrockKnowledgeBase', {
        name: this.namer.wisdom('bedrock-kb'),
        description: 'Bedrock KB with S3 data source for Q in Connect RAG',
        roleArn: bedrockKbRole.roleArn,
        knowledgeBaseConfiguration: {
          type: 'VECTOR',
          vectorKnowledgeBaseConfiguration: {
            embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
          },
        },
        storageConfiguration: {
          type: 'S3_VECTORS',
          s3VectorsConfiguration: {
            indexArn: vectorIndex.attrIndexArn,
          },
        },
      });
      bedrockKb.node.addDependency(vectorIndex);

      // Foundation-model (LLM) used to parse documents during ingestion. Using
      // an FM parser extracts structure/tables/images from PDFs and complex docs
      // far better than the default text parser. The model id is a cross-region
      // inference profile (eu.* / us.*), so it must be referenced by its
      // inference-profile ARN.
      const parsingModelArn = `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/{{kbParsingModelId}}`;

      // S3 data source pointing at the knowledge-base/ prefix in the storage bucket
      const bedrockDataSource = new bedrock.CfnDataSource(this, 'BedrockDataSource', {
        knowledgeBaseId: bedrockKb.attrKnowledgeBaseId,
        name: this.namer.wisdom('kb-s3-source'),
        dataSourceConfiguration: {
          type: 'S3',
          s3Configuration: {
            bucketArn: kbBucket.bucketArn,
          },
        },
        vectorIngestionConfiguration: {
          parsingConfiguration: {
            parsingStrategy: 'BEDROCK_FOUNDATION_MODEL',
            bedrockFoundationModelConfiguration: {
              modelArn: parsingModelArn,
            },
          },
        },
      });
      bedrockDataSource.node.addDependency(bedrockKb);

      // IAM role that Q in Connect (Wisdom) assumes to call bedrock:Retrieve
      // and invoke the answer-generation model. Q in Connect's self-service
      // agent uses this role both to retrieve KB chunks and to invoke the FM
      // that generates the final answer from the retrieved context.
      const wisdomBedrockAccessRole = new iam.Role(this, 'WisdomBedrockAccessRole', {
        assumedBy: new iam.ServicePrincipal('wisdom.amazonaws.com', {
          conditions: {
            StringEquals: { 'aws:SourceAccount': this.account },
          },
        }),
        description: 'Role for Q in Connect to retrieve from Bedrock Knowledge Base and invoke answer generation model',
        inlinePolicies: {
          BedrockAccess: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                sid: 'RetrieveFromKnowledgeBase',
                actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
                resources: [bedrockKb.attrKnowledgeBaseArn],
              }),
              // Answer generation model — Q in Connect invokes this via the
              // inference profile to generate answers from retrieved KB content.
              new iam.PolicyStatement({
                sid: 'InvokeAnswerGenModel',
                actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:GetInferenceProfile'],
                resources: [
                  `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/{{answerGenModelId}}`,
                ],
              }),
              new iam.PolicyStatement({
                sid: 'InvokeAnswerGenModelCrossRegion',
                actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                resources: [
                  `arn:aws:bedrock:*::foundation-model/${'{{answerGenModelId}}'.replace(/^[a-z]{2}\./, '')}`,
                ],
                conditions: {
                  StringEquals: {
                    'bedrock:InferenceProfileArn': `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/{{answerGenModelId}}`,
                  },
                },
              }),
            ],
          }),
        },
      });

      // Associate the Bedrock KB with the Q in Connect assistant
      bedrockKbAssociation = new wisdom.CfnAssistantAssociation(this, 'BedrockKbAssociation', {
        assistantId: assistant.attrAssistantId,
        associationType: 'EXTERNAL_BEDROCK_KNOWLEDGE_BASE',
        association: {
          externalBedrockKnowledgeBaseConfig: {
            bedrockKnowledgeBaseArn: bedrockKb.attrKnowledgeBaseArn,
            accessRoleArn: wisdomBedrockAccessRole.roleArn,
          },
        },
      });
      bedrockKbAssociation.node.addDependency(bedrockKb);

      new cdk.CfnOutput(this, 'KnowledgeBaseBucketName', { value: kbBucket.bucketName });
      new cdk.CfnOutput(this, 'BedrockKnowledgeBaseId', { value: bedrockKb.attrKnowledgeBaseId });
      new cdk.CfnOutput(this, 'BedrockKnowledgeBaseArn', { value: bedrockKb.attrKnowledgeBaseArn });
      new cdk.CfnOutput(this, 'BedrockDataSourceId', { value: bedrockDataSource.attrDataSourceId });
    }

    // SELF_SERVICE AI Prompt — answer generation from KB documents (YAML format required by Q Connect)
    const answerGenText = readPrompt('self-service');
    const answerGenPrompt = new wisdom.CfnAIPrompt(this, 'AnswerGenPrompt', {
      assistantId: assistant.attrAssistantId,
      name: this.namer.wisdom('answer-gen'),
      type: 'SELF_SERVICE_ANSWER_GENERATION',
      apiFormat: 'TEXT_COMPLETIONS',
      modelId: '{{answerGenModelId}}',
      templateType: 'TEXT',
      templateConfiguration: {
        textFullAiPromptEditTemplateConfiguration: {
          text: answerGenText,
        },
      },
    });

    // Q Connect AI agents must reference a *versioned* prompt
    // (`<promptId>:<version>`). Referencing the bare prompt id leaves the agent
    // pointing at an unversioned prompt, which the Agent Designer cannot resolve
    // ("Error calling getAIPrompt: Unauthorized"). Publish a version of each
    // prompt and wire the agents to that version's id.
    //
    // The version's construct id embeds a hash of the prompt text, so any edit
    // creates a fresh version (snapshotting the new content) that the agent then
    // references — without it, edits to the prompt never reach the agent.
    // `modifiedTimeSeconds` must equal the prompt's own modified time (the API
    // rejects a mismatch), so it is passed through from the prompt resource.
    const answerGenPromptVersion = new wisdom.CfnAIPromptVersion(
      this,
      `AnswerGenPromptVersion${promptHash(answerGenText)}`,
      {
        assistantId: assistant.attrAssistantId,
        aiPromptId: answerGenPrompt.attrAiPromptId,
        modifiedTimeSeconds: cdk.Token.asNumber(answerGenPrompt.attrModifiedTimeSeconds),
      },
    );

    // ORCHESTRATION AI Prompt — controls the voice agent persona (YAML format required by Q Connect)
    const orchestrationText = readPrompt('orchestration');
    const orchestrationPrompt = new wisdom.CfnAIPrompt(this, 'OrchestrationPrompt', {
      assistantId: assistant.attrAssistantId,
      name: this.namer.wisdom('orchestration'),
      type: 'ORCHESTRATION',
      apiFormat: 'MESSAGES',
      modelId: '{{orchestrationModelId}}',
      templateType: 'TEXT',
      templateConfiguration: {
        textFullAiPromptEditTemplateConfiguration: {
          text: orchestrationText,
        },
      },
    });

    const orchestrationPromptVersion = new wisdom.CfnAIPromptVersion(
      this,
      `OrchestrationPromptVersion${promptHash(orchestrationText)}`,
      {
        assistantId: assistant.attrAssistantId,
        aiPromptId: orchestrationPrompt.attrAiPromptId,
        modifiedTimeSeconds: cdk.Token.asNumber(orchestrationPrompt.attrModifiedTimeSeconds),
      },
    );

    // --- AI Guardrail for service agent ---
    // Blocks harmful content, off-topic requests, PII leakage, and prompt
    // injection attempts. Content filter strengths are set to MEDIUM for input
    // (callers may use informal language) and HIGH for output (the agent's
    // responses must always be appropriate). Contextual grounding catches
    // hallucinations by requiring responses to be grounded in retrieved content.
    // The AWS::Wisdom::AIGuardrail CloudFormation handler is unreliable (it
    // fails with an opaque GeneralServiceException even for configs the
    // qconnect API accepts, and doesn't expose the required visibilityStatus).
    // So the guardrail is created via a custom resource that calls the qconnect
    // CreateAIGuardrail API directly — the exact camelCase config the CLI
    // accepts. This mirrors the AgentCore gateway's inline-Lambda pattern.
    const guardrailName = this.namer.wisdom('guardrail');
    const guardrailFnRole = new iam.Role(this, 'GuardrailFnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the AI guardrail custom resource Lambda',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        GuardrailManage: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'wisdom:CreateAIGuardrail',
                'wisdom:UpdateAIGuardrail',
                'wisdom:DeleteAIGuardrail',
                'wisdom:CreateAIGuardrailVersion',
              ],
              // The guardrail's ARN isn't known until creation; scope to the
              // assistant's guardrail sub-resources in this account/region.
              resources: [
                `arn:aws:wisdom:${this.region}:${this.account}:assistant/*`,
                `arn:aws:wisdom:${this.region}:${this.account}:ai-guardrail/*/*`,
              ],
            }),
          ],
        }),
      },
    });

    const guardrailFn = new lambda.Function(this, 'GuardrailFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      role: guardrailFnRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      description: 'Creates/updates/deletes the Q in Connect AI guardrail via the qconnect API',
      code: lambda.Code.fromInline(GUARDRAIL_HANDLER),
    });

    const guardrail = new cdk.CustomResource(this, 'AIGuardrail', {
      serviceToken: guardrailFn.functionArn,
      properties: {
        AssistantId: assistant.attrAssistantId,
        Name: guardrailName,
        // Hash of the inline policy config — any edit to the GUARDRAIL_HANDLER's
        // policy constants changes this hash, which triggers a CloudFormation
        // Update on the custom resource (publishing a new guardrail version).
        ConfigHash: crypto.createHash('sha256').update(GUARDRAIL_HANDLER).digest('hex').slice(0, 12),
      },
    });
    guardrail.node.addDependency(assistant);

    // The version-qualified guardrail id (id:version) — AI agents require the
    // qualifier, not the bare id.
    const guardrailId = guardrail.getAttString('QualifiedId');

    // Bind the self-service agent's answer generation to a single KB
    // association. Q in Connect AI agents support exactly ONE KNOWLEDGE_BASE
    // association configuration, so prefer the Bedrock KB when it's enabled
    // (that's where the real content lives), otherwise fall back to the native
    // CUSTOM KB. The associationConfigurations.associationType schema only allows
    // KNOWLEDGE_BASE; the associationId is the assistant-association id, which is
    // the same shape for both native and Bedrock-backed associations.
    const selfServiceAssociations: wisdom.CfnAIAgent.AssociationConfigurationProperty[] = [
      {
        associationType: 'KNOWLEDGE_BASE',
        associationId: (bedrockKbAssociation ?? kbAssociation).attrAssistantAssociationId,
      },
    ];

    // SELF_SERVICE AI Agent — used by Retrieve tool for answer generation
    const selfServiceAgent = new wisdom.CfnAIAgent(this, 'SelfServiceAgent', {
      assistantId: assistant.attrAssistantId,
      name: this.namer.wisdom('self-service'),
      type: 'SELF_SERVICE',
      configuration: {
        selfServiceAiAgentConfiguration: {
          selfServiceAnswerGenerationAiPromptId: answerGenPromptVersion.attrAiPromptVersionId,
          associationConfigurations: selfServiceAssociations,
          selfServiceAiGuardrailId: guardrailId,
        },
      },
    });

    // MCP tools from the AgentCore gateway — allow-listed on the orchestrator
    // only when the tool-calling capability is enabled.
    //
    // Naming (captured from a console-configured agent — see SKILL.md):
    //   AgentCore exposes a Lambda target's tools as `${target}___${tool}`.
    //   Q in Connect surfaces each gateway under the namespace `gateway_${id}`
    //   and qualifies a tool's id as `${namespace}__${target}___${tool}`. So:
    //     toolName: `${target}___${tool}`               (the MCP tool name)
    //     toolId:   `gateway_${id}__${target}___${tool}` (namespace-qualified)
    //   This mirrors the built-in Retrieve tool's `aws_service__qconnect_Retrieve`
    //   (`${namespace}__${tool}`).
    //
    // Prerequisites enforced elsewhere: the gateway must be registered as an MCP
    // server integration on the instance (AgentCoreGatewayStack), and the agent's
    // security profile must grant these tool identifiers (the `applications`
    // grant below) — otherwise QConnect rejects the agent update (400).
    //
    // Only `toolName`/`toolType`/`toolId` are set: a gateway-sourced MCP tool
    // takes its description and schema from the MCP server, and QConnect rejects
    // any attempt to override the description here.
    const gatewayToolConfigs =
      props.gatewayNamespace
        ? SAP_GATEWAY_TOOLS.map((tool) => {
            const mcpToolName = `${SAP_GATEWAY_TARGET}___${tool}`;
            return {
              toolName: mcpToolName,
              toolType: 'MODEL_CONTEXT_PROTOCOL',
              toolId: `gateway_${props.gatewayNamespace}__${mcpToolName}`,
            };
          })
        : [];

    // ORCHESTRATION AI Agent — the brain, wired into the contact flow
    const orchestrationAgent = new wisdom.CfnAIAgent(this, 'OrchestrationAgent', {
      assistantId: assistant.attrAssistantId,
      name: this.namer.wisdom('orchestrator'),
      type: 'ORCHESTRATION',
      configuration: {
        orchestrationAiAgentConfiguration: {
          orchestrationAiPromptId: orchestrationPromptVersion.attrAiPromptVersionId,
          connectInstanceArn: props.instanceArn,
          locale: '{{lexLocaleId}}',
          orchestrationAiGuardrailId: guardrailId,
          toolConfigurations: [
            {
              toolName: 'Complete',
              toolType: 'RETURN_TO_CONTROL',
              description: 'Close conversation when customer has no more questions',
              instruction: {
                instruction: 'Use this tool when the customer confirms they have no more questions.',
              },
              inputSchema: {
                type: 'object',
                properties: { reason: { type: 'string', description: 'Reason for completion' } },
                required: ['reason'],
              },
              userInteractionConfiguration: { isUserConfirmationRequired: false },
            },
            {
              toolName: 'Escalate',
              toolType: 'RETURN_TO_CONTROL',
              description: 'Escalate to human agent when the issue cannot be resolved',
              instruction: {
                instruction: 'Use this tool when you cannot help the caller or they explicitly ask for a human.',
              },
              inputSchema: {
                type: 'object',
                properties: { reason: { type: 'string', description: 'Reason for escalation' } },
                required: ['reason'],
              },
              userInteractionConfiguration: { isUserConfirmationRequired: false },
            },
            {
              toolName: 'Retrieve',
              toolType: 'MODEL_CONTEXT_PROTOCOL',
              toolId: 'aws_service__qconnect_Retrieve',
              // Bind the Retrieve tool to this assistant's knowledge-base
              // association. Without it the tool has no authorized knowledge
              // source and the Agent Designer reports "Insufficient Permissions".
              overrideInputValues: [
                {
                  jsonPath: '$.retrievalConfiguration.knowledgeSource.assistantAssociationIds',
                  value: {
                    constant: {
                      type: 'JSON_STRING',
                      // Q Connect Retrieve supports only a SINGLE association ID.
                      // Prefer the Bedrock KB when enabled (that's where real content lives).
                      value: bedrockKbAssociation
                        ? cdk.Fn.sub('["${BedrockId}"]', {
                            BedrockId: bedrockKbAssociation.attrAssistantAssociationId,
                          })
                        : cdk.Fn.sub('["${AssociationId}"]', {
                            AssociationId: kbAssociation.attrAssistantAssociationId,
                          }),
                    },
                  },
                },
                {
                  jsonPath: '$.assistantId',
                  value: {
                    constant: {
                      type: 'STRING',
                      value: '{{$.assistantId}}',
                    },
                  },
                },
              ],
            },
            ...gatewayToolConfigs,
          ],
        },
      },
    });

    // Security profile for the AI agents. The Agent Designer resolves an
    // agent's knowledge-base/Retrieve permissions through a security profile
    // associated with the *agent entity*; without one it reports "Insufficient
    // Permissions — Update Security Profiles for this AI Agent". Wisdom.View is
    // the permission that authorizes the Retrieve tool.
    //
    // MCP tools from the AgentCore gateway are authorized separately, through
    // the `applications` grant: each MCP_SERVER application is referenced by its
    // namespace (the gateway id), and `applicationPermissions` lists the exact
    // tool identifiers the agent may invoke. Without this grant the Agent
    // Designer shows "Insufficient Permissions" and the tool calls are rejected,
    // even though the tool is listed on the agent.
    const gatewayApplications =
      props.gatewayNamespace
        ? [
            {
              // `type: 'MCP'` is required — without it Connect defaults to a
              // third-party-app grant that only accepts the `ACCESS` permission
              // and rejects tool identifiers with "Invalid application
              // permission found".
              type: 'MCP',
              namespace: props.gatewayNamespace,
              applicationPermissions: SAP_GATEWAY_TOOLS.map(
                (tool) => `${SAP_GATEWAY_TARGET}___${tool}`,
              ),
            },
          ]
        : undefined;

    const agentSecurityProfile = new connect.CfnSecurityProfile(this, 'AgentSecurityProfile', {
      instanceArn: props.instanceArn,
      securityProfileName: this.namer.connect('ai-agent'),
      description: 'Grants AI agents knowledge-base access for the Retrieve tool',
      permissions: ['Wisdom.View'],
      applications: gatewayApplications,
    });
    const securityProfileId = cdk.Fn.select(
      3,
      cdk.Fn.split('/', agentSecurityProfile.attrSecurityProfileArn),
    );

    // Associate the security profile with the orchestration agent. This is not a
    // native CloudFormation property, so a custom resource calls
    // AssociateSecurityProfiles. The Designer reads the `$SAVED` / `$LATEST`
    // agent ARN variants, so both are associated (mirrors the reference setup).
    // attrAiAgentArn already ends in ':$LATEST'; derive the base ARN explicitly.
    const baseAgentArn = cdk.Fn.select(
      0,
      cdk.Fn.split(':$LATEST', orchestrationAgent.attrAiAgentArn),
    );
    ['$SAVED', '$LATEST'].forEach((suffix, i) => {
      const associate = new cr.AwsCustomResource(this, `AgentSecurityProfileAssoc${i}`, {
        onCreate: {
          service: 'Connect',
          action: 'associateSecurityProfiles',
          parameters: {
            InstanceId: props.instanceId,
            EntityType: 'AI_AGENT',
            EntityArn: `${baseAgentArn}:${suffix}`,
            SecurityProfiles: [{ Id: securityProfileId }],
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `${orchestrationAgent.attrAiAgentId}-secprofile-${suffix}`,
          ),
        },
        // Mirror of onCreate: without this, `cdk destroy` leaves the server-side
        // association dangling. The security profile then reports "in use" (409)
        // and blocks the whole stack from deleting. The addDependency calls below
        // ensure this custom resource is deleted (i.e. disassociate runs) before
        // the profile and agent it references are torn down. ResourceNotFound is
        // ignored so a redeploy over a manually-cleared association still destroys.
        onDelete: {
          service: 'Connect',
          action: 'disassociateSecurityProfiles',
          parameters: {
            InstanceId: props.instanceId,
            EntityType: 'AI_AGENT',
            EntityArn: `${baseAgentArn}:${suffix}`,
            SecurityProfiles: [{ Id: securityProfileId }],
          },
          // Tolerate the association not existing at teardown. If the paired
          // onCreate associate failed, or the association was already removed
          // out-of-band, there is nothing to disassociate and the API returns
          // "Can only disassociate security profile ids associated to the
          // entity" — thrown as InvalidParameterException (verified live
          // 2026-07-22; InvalidRequestException kept for safety). Ignoring
          // these plus ResourceNotFound keeps a failed CREATE or an external
          // cleanup from wedging the stack in DELETE_FAILED.
          ignoreErrorCodesMatching:
            'ResourceNotFoundException|InvalidRequestException|InvalidParameterException|AccessDeniedException',
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          // AssociateSecurityProfiles / DisassociateSecurityProfiles authorize
          // against BOTH the Connect instance's security-profile sub-resource
          // (arn:aws:connect:...instance/ID/security-profile/*) AND the wisdom
          // AI-agent entity ARN (arn:aws:wisdom:...ai-agent/ASSISTANT/AGENT:$VER).
          // Both must be in the resource list or the call is rejected.
          new iam.PolicyStatement({
            actions: [
              'connect:AssociateSecurityProfiles',
              'connect:DisassociateSecurityProfiles',
            ],
            resources: [
              `${props.instanceArn}/security-profile/*`,
              `${baseAgentArn}:$SAVED`,
              `${baseAgentArn}:$LATEST`,
            ],
          }),
          // GetAIAgent is called internally by AssociateSecurityProfiles to
          // validate the AI-AGENT entity. Scoped to agents under this assistant.
          new iam.PolicyStatement({
            actions: [
              'wisdom:GetAIAgent',
              'qconnect:GetAIAgent',
            ],
            resources: [
              baseAgentArn,
              `${baseAgentArn}:*`,
            ],
          }),
          // ListEntitySecurityProfiles is a read/list discovery action that
          // requires account-scope resources.
          new iam.PolicyStatement({
            actions: ['connect:ListEntitySecurityProfiles'],
            resources: ['*'],
          }),
        ]),
      });
      associate.node.addDependency(agentSecurityProfile);
      associate.node.addDependency(orchestrationAgent);
    });

    // Connect integration: link instance to Wisdom assistant
    new connect.CfnIntegrationAssociation(this, 'WisdomAssociation', {
      instanceId: props.instanceArn,
      integrationType: 'WISDOM_ASSISTANT',
      integrationArn: assistant.attrAssistantArn,
    });

    this.assistantArn = assistant.attrAssistantArn;
    this.assistantId = assistant.attrAssistantId;
    this.orchestrationAgentId = orchestrationAgent.attrAiAgentId;
    this.orchestrationAgentArn = orchestrationAgent.attrAiAgentArn;
    this.selfServiceAgentId = selfServiceAgent.attrAiAgentId;
    this.knowledgeBaseArn = kb.attrKnowledgeBaseArn;

    // --- Enable BOT_MANAGEMENT attribute ---
    // Placed here (after assistant/agent creation, before LexBotStack) to avoid
    // a race condition: enabling BOT_MANAGEMENT triggers Lex SLR creation, which
    // can conflict if it runs concurrently with other stacks that also trigger it.
    const enableBotMgmt = new cr.AwsCustomResource(this, 'Attr-BOT_MANAGEMENT', {
      onCreate: {
        service: 'Connect',
        action: 'updateInstanceAttribute',
        parameters: {
          InstanceId: props.instanceId,
          AttributeType: 'BOT_MANAGEMENT',
          Value: 'true',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${props.instanceId}-attr-BOT_MANAGEMENT`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['connect:UpdateInstanceAttribute', 'connect:DescribeInstanceAttribute'],
          resources: [props.instanceArn],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PutRolePolicy', 'iam:GetRole', 'iam:GetRolePolicy'],
          resources: [`arn:aws:iam::${this.account}:role/aws-service-role/connect.amazonaws.com/*`],
        }),
      ]),
    });
    enableBotMgmt.node.addDependency(orchestrationAgent);

    // --- Lex V2 Bot for AI Agent self-service ---
    // The bot is an implementation detail of the Q in Connect AI agent setup: it
    // routes all utterances through QInConnectIntent to the orchestration agent
    // (Nova Sonic). It has no independent intents or custom logic.
    const botRole = new iam.Role(this, 'BotRole', {
      assumedBy: new iam.ServicePrincipal('lexv2.amazonaws.com'),
      description: 'Allows the Lex bot to invoke Q-in-Connect for AI Agent self-service',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonLexRunBotsOnly'),
      ],
      inlinePolicies: {
        QInConnectAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'QInConnectAssistantPolicy',
              actions: ['wisdom:CreateSession', 'wisdom:GetAssistant'],
              resources: [assistant.attrAssistantArn, `${assistant.attrAssistantArn}/*`],
            }),
            new iam.PolicyStatement({
              sid: 'QInConnectSessionsPolicy',
              actions: ['wisdom:SendMessage', 'wisdom:GetNextMessage'],
              resources: [
                cdk.Arn.format({
                  service: 'wisdom',
                  resource: 'session',
                  resourceName: `${assistant.attrAssistantId}/*`,
                }, this),
              ],
            }),
          ],
        }),
      },
    });

    const bot = new lex.CfnBot(this, 'Bot', {
      name: this.namer.lex('bot'),
      description: 'Conversational AI bot for Connect AI Agent self-service',
      roleArn: botRole.roleArn,
      dataPrivacy: { ChildDirected: false },
      idleSessionTtlInSeconds: 300,
      botLocales: [{
        localeId: '{{lexLocaleId}}',
        nluConfidenceThreshold: 0.4,
        // Amazon Connect agentic voice — the ASR half of the feature.
        //
        // "Advanced" selects the enhanced streaming recognizer that agentic
        // voice uses: it predicts end-of-turn from the caller's speech instead
        // of relying only on a fixed silence window, which is what makes turn
        // taking sound natural. This is the bot-level counterpart to the flow's
        // Set-voice block (TextToSpeechEngine "connect:agentic", the TTS half) —
        // the feature needs BOTH halves, and the caller-facing voice comes from
        // the flow, not from here.
        //
        // This REPLACES the previous Nova 2 Sonic speech-to-speech config
        // (unifiedSpeechSettings.speechFoundationModel). The two are alternative
        // architectures for the same slot, not layers: Sonic's own voiceId was
        // authoritative during the bot session and took priority over the flow's
        // Set-voice block, so leaving it in place would silently override the
        // agentic voice and the change would appear to do nothing. Nova Sonic
        // also only supports a 4-voice launch set (Matthew/Amy/Olivia/Lupe)
        // selected with provider "Amazon", which is not the agentic catalog.
        //
        // speechModelPreference is a free-form string in CloudFormation, so an
        // invalid value is not caught at synth time. "Advanced" is accepted by
        // the live UpdateBotLocale API (verified directly) even though older
        // bundled service models only enumerate Standard/Neural/Deepgram.
        speechRecognitionSettings: {
          speechModelPreference: 'Advanced',
        },
        intents: [
          {
            name: 'QInConnectIntent',
            parentIntentSignature: 'AMAZON.QInConnectIntent',
            qInConnectIntentConfiguration: {
              qInConnectAssistantConfiguration: {
                assistantArn: assistant.attrAssistantArn,
              },
            },
          },
          {
            name: 'FallbackIntent',
            parentIntentSignature: 'AMAZON.FallbackIntent',
          },
        ],
      }],
      autoBuildBotLocales: true,
      botTags: [{ key: 'AmazonConnectEnabled', value: 'True' }],
    });

    const botVersion = new lex.CfnBotVersion(this, 'BotVersion', {
      botId: bot.attrId,
      botVersionLocaleSpecification: [{
        localeId: '{{lexLocaleId}}',
        botVersionLocaleDetails: { sourceBotVersion: 'DRAFT' },
      }],
    });
    botVersion.addDependency(bot);

    const botAlias = new lex.CfnBotAlias(this, 'BotAlias', {
      botId: bot.attrId,
      botAliasName: 'live',
      botVersion: botVersion.attrBotVersion,
      botAliasLocaleSettings: [{
        localeId: '{{lexLocaleId}}',
        botAliasLocaleSetting: { enabled: true },
      }],
      botAliasTags: [{ key: 'AmazonConnectEnabled', value: 'True' }],
    });

    new connect.CfnIntegrationAssociation(this, 'LexAssociation', {
      instanceId: props.instanceArn,
      integrationType: 'LEX_BOT',
      integrationArn: botAlias.attrArn,
    });

    this.botAliasArn = botAlias.attrArn;

    new cdk.CfnOutput(this, 'AssistantId', { value: this.assistantId });
    new cdk.CfnOutput(this, 'OrchestrationAgentId', { value: this.orchestrationAgentId });
    new cdk.CfnOutput(this, 'OrchestrationAgentArn', { value: this.orchestrationAgentArn });
    new cdk.CfnOutput(this, 'BotAliasArn', { value: this.botAliasArn });
  }
}

// ---------------------------------------------------------------------------
// Inline Python handler for the AI guardrail custom resource.
//
// The AWS::Wisdom::AIGuardrail CloudFormation resource is unreliable (opaque
// GeneralServiceException, no visibilityStatus support), so this handler calls
// the qconnect API directly with the exact camelCase policy config that the
// CLI accepts. Create returns the guardrail id; Update updates in place; Delete
// removes it. The guardrail is created with visibilityStatus PUBLISHED so the
// AI agents can reference it immediately.
// ---------------------------------------------------------------------------
const GUARDRAIL_HANDLER = `
import json, logging, urllib.request
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

BLOCKED_INPUT = 'I cannot process that request. Please rephrase your question about our services.'
BLOCKED_OUTPUT = 'I cannot provide that information. Let me help you with something else.'

CONTENT_POLICY = {
    'filtersConfig': [
        {'type': 'HATE', 'inputStrength': 'MEDIUM', 'outputStrength': 'HIGH'},
        {'type': 'INSULTS', 'inputStrength': 'MEDIUM', 'outputStrength': 'HIGH'},
        {'type': 'SEXUAL', 'inputStrength': 'HIGH', 'outputStrength': 'HIGH'},
        {'type': 'VIOLENCE', 'inputStrength': 'HIGH', 'outputStrength': 'HIGH'},
        {'type': 'MISCONDUCT', 'inputStrength': 'HIGH', 'outputStrength': 'HIGH'},
        # PROMPT_ATTACK only supports input filtering — outputStrength MUST be NONE.
        {'type': 'PROMPT_ATTACK', 'inputStrength': 'HIGH', 'outputStrength': 'NONE'},
    ]
}

TOPIC_POLICY = {
    'topicsConfig': [
        {
            'name': 'off-topic',
            'type': 'DENY',
            'definition': 'Requests unrelated to company services, products, orders, accounts, or support. Includes general knowledge, personal advice, coding help, or topics outside customer service.',
            'examples': [
                'What is the meaning of life?',
                'Write me a poem',
                'Help me with my homework',
                'What is the weather today?',
            ],
        }
    ]
}

SENSITIVE_POLICY = {
    'piiEntitiesConfig': [
        {'type': 'CREDIT_DEBIT_CARD_NUMBER', 'action': 'ANONYMIZE'},
        {'type': 'US_SOCIAL_SECURITY_NUMBER', 'action': 'ANONYMIZE'},
        {'type': 'US_BANK_ACCOUNT_NUMBER', 'action': 'ANONYMIZE'},
        {'type': 'CREDIT_DEBIT_CARD_CVV', 'action': 'BLOCK'},
        {'type': 'PIN', 'action': 'BLOCK'},
        {'type': 'PASSWORD', 'action': 'BLOCK'},
    ]
}

WORD_POLICY = {'managedWordListsConfig': [{'type': 'PROFANITY'}]}


def create_guardrail(client, assistant_id, name):
    resp = client.create_ai_guardrail(
        assistantId=assistant_id,
        name=name,
        visibilityStatus='PUBLISHED',
        blockedInputMessaging=BLOCKED_INPUT,
        blockedOutputsMessaging=BLOCKED_OUTPUT,
        description='Service agent guardrail - blocks harmful content, PII, off-topic, and prompt attacks',
        contentPolicyConfig=CONTENT_POLICY,
        topicPolicyConfig=TOPIC_POLICY,
        sensitiveInformationPolicyConfig=SENSITIVE_POLICY,
        wordPolicyConfig=WORD_POLICY,
    )
    return resp['aiGuardrail']['aiGuardrailId']


def update_guardrail(client, assistant_id, guardrail_id):
    client.update_ai_guardrail(
        assistantId=assistant_id,
        aiGuardrailId=guardrail_id,
        visibilityStatus='PUBLISHED',
        blockedInputMessaging=BLOCKED_INPUT,
        blockedOutputsMessaging=BLOCKED_OUTPUT,
        description='Service agent guardrail - blocks harmful content, PII, off-topic, and prompt attacks',
        contentPolicyConfig=CONTENT_POLICY,
        topicPolicyConfig=TOPIC_POLICY,
        sensitiveInformationPolicyConfig=SENSITIVE_POLICY,
        wordPolicyConfig=WORD_POLICY,
    )


def publish_version(client, assistant_id, guardrail_id):
    # AI agents must reference a guardrail by a version qualifier (id:version),
    # not the bare id. Publish a version and return the qualified id.
    resp = client.create_ai_guardrail_version(
        assistantId=assistant_id,
        aiGuardrailId=guardrail_id,
    )
    version = resp['versionNumber']
    return f"{guardrail_id}:{int(version)}"


def handler(event, context):
    logger.info(f"RequestType: {event.get('RequestType')}")
    rt = event.get('RequestType')
    props = event.get('ResourceProperties', {})
    assistant_id = props['AssistantId']
    name = props['Name']
    client = boto3.client('qconnect')

    try:
        if rt == 'Create':
            gid = create_guardrail(client, assistant_id, name)
            qualified = publish_version(client, assistant_id, gid)
            send(event, context, 'SUCCESS',
                 {'AIGuardrailId': gid, 'QualifiedId': qualified}, physical_id=gid)
        elif rt == 'Update':
            gid = event.get('PhysicalResourceId', '')
            try:
                update_guardrail(client, assistant_id, gid)
            except ClientError as e:
                # If the existing guardrail can't be updated, create a fresh one.
                logger.warning(f"Update failed ({e}); creating a new guardrail")
                gid = create_guardrail(client, assistant_id, name)
            # Publish a new version so the update is reflected in a qualifier.
            qualified = publish_version(client, assistant_id, gid)
            send(event, context, 'SUCCESS',
                 {'AIGuardrailId': gid, 'QualifiedId': qualified}, physical_id=gid)
        elif rt == 'Delete':
            gid = event.get('PhysicalResourceId', '')
            if gid and gid.count('-') >= 4:  # looks like a real id, not a failed-create token
                try:
                    client.delete_ai_guardrail(assistantId=assistant_id, aiGuardrailId=gid)
                except ClientError as e:
                    logger.warning(f"Delete tolerated error: {e}")
            send(event, context, 'SUCCESS', {}, physical_id=gid or 'none')
        else:
            send(event, context, 'FAILED', {}, reason=f"Unknown RequestType {rt}")
    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        send(event, context, 'FAILED', {}, reason=str(e), physical_id=event.get('PhysicalResourceId', 'none'))


def send(event, context, status, data, reason=None, physical_id=None):
    body = {
        'Status': status,
        'Reason': reason or f"See CloudWatch: {context.log_stream_name}",
        'PhysicalResourceId': physical_id or context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data,
    }
    req = urllib.request.Request(
        event['ResponseURL'],
        data=json.dumps(body).encode(),
        headers={'Content-Type': ''},
        method='PUT',
    )
    urllib.request.urlopen(req)
`;
