import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as wisdom from 'aws-cdk-lib/aws-wisdom';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Construct } from 'constructs';
import { BlueprintStack } from './blueprint-stack';
import { config } from './config';
import { SAMPLE_GATEWAY_TARGET, SAMPLE_GATEWAY_TOOLS } from './agentcore-gateway-stack';

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
   * id). Required only when `config.toolEnabled` is true — used to grant the
   * gateway's MCP tools on the AI-agent security profile. The bare gateway id
   * is the application namespace the Connect console shows (minus its
   * `gateway_` display prefix).
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

    // SELF_SERVICE AI Agent — used by Retrieve tool for answer generation
    const selfServiceAgent = new wisdom.CfnAIAgent(this, 'SelfServiceAgent', {
      assistantId: assistant.attrAssistantId,
      name: this.namer.wisdom('self-service'),
      type: 'SELF_SERVICE',
      configuration: {
        selfServiceAiAgentConfiguration: {
          selfServiceAnswerGenerationAiPromptId: answerGenPromptVersion.attrAiPromptVersionId,
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
      config.toolEnabled && props.gatewayNamespace
        ? SAMPLE_GATEWAY_TOOLS.map((tool) => {
            const mcpToolName = `${SAMPLE_GATEWAY_TARGET}___${tool}`;
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
                      value: cdk.Fn.sub('["${AssociationId}"]', {
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
      config.toolEnabled && props.gatewayNamespace
        ? [
            {
              // `type: 'MCP'` is required — without it Connect defaults to a
              // third-party-app grant that only accepts the `ACCESS` permission
              // and rejects tool identifiers with "Invalid application
              // permission found".
              type: 'MCP',
              namespace: props.gatewayNamespace,
              applicationPermissions: SAMPLE_GATEWAY_TOOLS.map(
                (tool) => `${SAMPLE_GATEWAY_TARGET}___${tool}`,
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
          // onCreate associate failed (e.g. a transient perms/propagation error),
          // there is nothing to disassociate and the API returns "Can only
          // disassociate security profile ids associated to the entity"
          // (InvalidRequestException) — ignoring it, plus ResourceNotFound, keeps a
          // failed CREATE from wedging the stack in ROLLBACK_FAILED on every retry.
          ignoreErrorCodesMatching:
            'ResourceNotFoundException|InvalidRequestException|AccessDeniedException',
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          // Associate/DisassociateSecurityProfiles authorize against the AI-AGENT
          // EntityArn passed in the call — a `wisdom:`-service ai-agent ARN
          // (arn:aws:wisdom:...:ai-agent/<assistant>/<agent>:$LATEST) — NOT the
          // Connect instance ARN. Scoping these two actions to `props.instanceArn`
          // therefore fails at deploy with "not authorized to perform:
          // connect:AssociateSecurityProfiles on resource: arn:aws:wisdom:...ai-agent/...".
          // The action's authorized resource is cross-service and its ARN shape is
          // not reliably reconstructable here, so we use `'*'`. The custom-resource
          // role is single-purpose and only ever calls (Dis)associateSecurityProfiles,
          // so the blast radius is limited.
          new iam.PolicyStatement({
            actions: [
              'connect:AssociateSecurityProfiles',
              'connect:DisassociateSecurityProfiles',
            ],
            resources: ['*'],
          }),
          // GetAIAgent is called internally by AssociateSecurityProfiles to
          // validate the AI-AGENT entity. Scoping it to `${baseAgentArn}:*` is
          // rejected ("Missing wisdom:GetAiAgent permissions in credentials") —
          // the service validates against the bare agent ARN (no version suffix),
          // which that pattern does not match, and the ARN shape is not reliably
          // reconstructable here. Use `'*'` for the same reason as the associate
          // actions above; this role is single-purpose.
          new iam.PolicyStatement({
            actions: [
              'wisdom:GetAIAgent',
              'qconnect:GetAIAgent',
            ],
            resources: ['*'],
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

    new cdk.CfnOutput(this, 'AssistantId', { value: this.assistantId });
    new cdk.CfnOutput(this, 'OrchestrationAgentId', { value: this.orchestrationAgentId });
    new cdk.CfnOutput(this, 'OrchestrationAgentArn', { value: this.orchestrationAgentArn });
  }
}
