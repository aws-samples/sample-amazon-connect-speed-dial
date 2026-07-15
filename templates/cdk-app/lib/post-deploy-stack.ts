import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { BlueprintStack } from './blueprint-stack';

export interface PostDeployStackProps extends cdk.StackProps {
  instanceArn: string;
  instanceId: string;
  assistantId: string;
  orchestrationAgentId: string;
  selfServiceAgentId: string;
  orchestratorUseCase: string;
}

/**
 * Post-deployment configuration that wires AI agents to the Q Connect assistant.
 *
 * Uses custom resources to call UpdateAssistantAIAgent for both the SELF_SERVICE
 * and ORCHESTRATION agent types, ensuring the assistant is ready to handle
 * conversations immediately after deployment.
 */
export class PostDeployStack extends BlueprintStack {
  constructor(scope: Construct, id: string, props: PostDeployStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'Post-deployment configuration for Q Connect AI agents';

    const assistantArn = `arn:aws:wisdom:${this.region}:${this.account}:assistant/${props.assistantId}`;

    const policy = AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: [
          'wisdom:UpdateAssistantAIAgent',
          'wisdom:GetAssistant',
          'wisdom:GetAIAgent',
          'qconnect:UpdateAssistantAIAgent',
          'qconnect:GetAssistant',
          'qconnect:GetAIAgent',
        ],
        resources: [
          assistantArn,
          `${assistantArn}/*`,
        ],
      }),
    ]);

    new AwsCustomResource(this, 'SetSelfServiceAgent', {
      onCreate: {
        service: 'QConnect',
        action: 'updateAssistantAIAgent',
        parameters: {
          assistantId: props.assistantId,
          aiAgentType: 'SELF_SERVICE',
          configuration: { aiAgentId: props.selfServiceAgentId },
        },
        physicalResourceId: PhysicalResourceId.of(`${props.instanceId}-self-service-agent`),
      },
      policy,
      installLatestAwsSdk: true,
    });

    new AwsCustomResource(this, 'SetOrchestrationAgent', {
      onCreate: {
        service: 'QConnect',
        action: 'updateAssistantAIAgent',
        parameters: {
          assistantId: props.assistantId,
          aiAgentType: 'ORCHESTRATION',
          configuration: { aiAgentId: props.orchestrationAgentId },
          orchestratorUseCase: props.orchestratorUseCase,
        },
        physicalResourceId: PhysicalResourceId.of(`${props.instanceId}-orchestration-agent`),
      },
      policy,
      installLatestAwsSdk: true,
    });
  }
}
