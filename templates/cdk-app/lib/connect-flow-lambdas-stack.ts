import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';
import { BlueprintStack } from './blueprint-stack';

export interface ConnectFlowLambdasStackProps extends cdk.StackProps {
  connectInstanceId: string;
  connectInstanceArn: string;
  assistantId: string;
  /**
   * ARN of the customer-managed storage key (always created). The Customer
   * Profiles domain is created with this key as its DefaultEncryptionKey, and
   * profile:SearchProfiles against a CMK-encrypted domain performs a KMS
   * decrypt with the CALLER's credentials — without kms:Decrypt on the key
   * every search fails with AccessDeniedException at runtime (IAM policy
   * simulation passes; the KMS check is service-side).
   */
  storageKeyArn: string;
  /**
   * When true, deploy and associate the UpdateSessionContext Lambda that
   * searches Customer Profiles for the caller and pushes the resulting identity
   * data into the Q Connect session. When false it is not created (the flow
   * does not invoke it), avoiding an unused function in the deployment.
   */
  customerProfilesEnabled: boolean;
  /** Customer Profiles domain to search (required when customerProfilesEnabled). */
  profilesDomainName?: string;
  /**
   * Name of the SAP orders DynamoDB table (from the AgentCore gateway stack).
   * When set, the UpdateSessionContext Lambda pre-populates the caller's most
   * recent order into the Q Connect session (so the agent answers "my latest
   * order" without a tool call). Omitted → pre-population is skipped.
   */
  sapOrderTableName?: string;
}

/**
 * Stack that deploys Lambda functions invoked from within Connect contact flows.
 *
 * - UpdateSessionContext: resolves the caller's Customer Profile and pushes
 *   identity data into the Q Connect session (deployed when customerProfilesEnabled).
 * - DescribeContact: calls DescribeContact and logs results to CloudWatch.
 *
 * Each Lambda is granted least-privilege IAM policies and associated with
 * the Connect instance so it can be referenced from flow blocks.
 */
export class ConnectFlowLambdasStack extends BlueprintStack {
  /** Set only when customerProfilesEnabled; undefined otherwise. */
  public readonly updateSessionContextFunction?: lambda.Function;
  public readonly describeContactFunction: lambda.Function;

  /**
   * Allow Amazon Connect to invoke a flow Lambda and associate it with the
   * instance (so it's selectable from flow blocks). Shared by the flow Lambdas.
   */
  private associateFlowLambda(id: string, fn: lambda.Function, instanceId: string, instanceArn: string): void {
    fn.addPermission('ConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      sourceAccount: this.account,
      sourceArn: instanceArn,
    });
    const assoc = new cr.AwsCustomResource(this, id, {
      onCreate: {
        service: 'Connect',
        action: 'associateLambdaFunction',
        parameters: { InstanceId: instanceId, FunctionArn: fn.functionArn },
        physicalResourceId: cr.PhysicalResourceId.of(`${instanceId}-${fn.functionName}`),
      },
      onDelete: {
        service: 'Connect',
        action: 'disassociateLambdaFunction',
        parameters: { InstanceId: instanceId, FunctionArn: fn.functionArn },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['connect:AssociateLambdaFunction', 'connect:DisassociateLambdaFunction'],
          resources: [instanceArn],
        }),
        new iam.PolicyStatement({
          actions: ['lambda:AddPermission', 'lambda:RemovePermission', 'lambda:GetPolicy'],
          resources: [fn.functionArn],
        }),
      ]),
    });
    assoc.node.addDependency(fn);
  }

  constructor(scope: Construct, id: string, props: ConnectFlowLambdasStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'Lambda functions invoked from Connect contact flows';

    // --- Pinned boto3 Layer ---
    // Freezes the boto3/botocore version so all Python Lambdas use a
    // consistent SDK regardless of the Lambda runtime's bundled version.
    const boto3Layer = new lambda.LayerVersion(this, 'Boto3Layer', {
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../lambda/flow/layers/boto3'),
        {
          bundling: {
            image: lambda.Runtime.PYTHON_3_13.bundlingImage,
            command: [
              'bash', '-c',
              'pip install -r requirements.txt -t /asset-output/python && cp requirements.txt /asset-output/',
            ],
          },
        },
      ),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_13],
      description: 'Pinned boto3 layer for consistent SDK version across flow Lambdas',
    });

    // --- Update Session Context Lambda (Customer Profiles → Q Connect session) ---
    // Deployed only when customer profiles are enabled. Searches Customer
    // Profiles for the caller and pushes identity fields into the Q Connect
    // session (UpdateSessionData, namespace Custom) so the agent reads them via
    // {{$.Custom.*}}.
    if (props.customerProfilesEnabled) {
      const updateSessionContextFunction = new lambda.Function(this, 'UpdateSessionContextFunction', {
        runtime: lambda.Runtime.PYTHON_3_13,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(
          path.join(__dirname, '../lambda/flow/update-session-context'),
        ),
        layers: [boto3Layer],
        timeout: cdk.Duration.seconds(15),
        description: 'Resolves caller profile and pushes identity data into the Q Connect session',
        environment: {
          ASSISTANT_ID: props.assistantId,
          PROFILES_DOMAIN: props.profilesDomainName ?? '',
          SAP_ORDERS_TABLE: props.sapOrderTableName ?? '',
          LOG_LEVEL: 'ERROR',
        },
      });
      this.updateSessionContextFunction = updateSessionContextFunction;

      // Read the caller's most recent order to pre-populate session context.
      // Scoped to the SAP orders table + its GSI (customer-scoped query).
      if (props.sapOrderTableName) {
        updateSessionContextFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['dynamodb:Query'],
            resources: [
              `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.sapOrderTableName}`,
              `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.sapOrderTableName}/index/*`,
            ],
          }),
        );
      }

      // Search Customer Profiles (domain-scoped).
      updateSessionContextFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['profile:SearchProfiles'],
          resources: [
            `arn:aws:profile:${this.region}:${this.account}:domains/${props.profilesDomainName}`,
            `arn:aws:profile:${this.region}:${this.account}:domains/${props.profilesDomainName}/*`,
          ],
        }),
      );

      // CMK-encrypted domain: SearchProfiles requires the caller to be able
      // to decrypt with the domain's DefaultEncryptionKey.
      updateSessionContextFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: [props.storageKeyArn],
        }),
      );

      // Allow the Lambda to update Q Connect session data.
      // The session-id segment is a wildcard by necessity: the session ARN is
      // resolved at runtime from contact data and is not known at synth time.
      updateSessionContextFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['wisdom:UpdateSessionData'],
          resources: [
            `arn:aws:wisdom:${this.region}:${this.account}:assistant/${props.assistantId}`,
            `arn:aws:wisdom:${this.region}:${this.account}:session/${props.assistantId}/*`,
          ],
        }),
      );

      // Allow the Lambda to call DescribeContact (needed to resolve the session ARN).
      updateSessionContextFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['connect:DescribeContact'],
          resources: [`${props.connectInstanceArn}/contact/*`],
        }),
      );

      this.associateFlowLambda(
        'AssociateUpdateSessionLambda',
        updateSessionContextFunction,
        props.connectInstanceId,
        props.connectInstanceArn,
      );
    }

    // --- Describe Contact Lambda ---
    this.describeContactFunction = new lambda.Function(this, 'DescribeContactFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../lambda/flow/describe-contact'),
      ),
      layers: [boto3Layer],
      timeout: cdk.Duration.seconds(10),
      description: 'Calls DescribeContact and logs structured results to CloudWatch',
      environment: {
        LOG_LEVEL: 'INFO',
      },
    });

    // Allow the Lambda to call DescribeContact
    this.describeContactFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['connect:DescribeContact'],
        resources: [`${props.connectInstanceArn}/contact/*`],
      }),
    );

    // Allow Amazon Connect to invoke this Lambda
    this.describeContactFunction.addPermission('ConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      sourceAccount: this.account,
      sourceArn: props.connectInstanceArn,
    });

    // Associate the Lambda with the Connect instance
    const associateDescribeContact = new cr.AwsCustomResource(this, 'AssociateDescribeContactLambda', {
      onCreate: {
        service: 'Connect',
        action: 'associateLambdaFunction',
        parameters: {
          InstanceId: props.connectInstanceId,
          FunctionArn: this.describeContactFunction.functionArn,
        },
        physicalResourceId: cr.PhysicalResourceId.of(
          `${props.connectInstanceId}-${this.describeContactFunction.functionName}`,
        ),
      },
      onDelete: {
        service: 'Connect',
        action: 'disassociateLambdaFunction',
        parameters: {
          InstanceId: props.connectInstanceId,
          FunctionArn: this.describeContactFunction.functionArn,
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['connect:AssociateLambdaFunction', 'connect:DisassociateLambdaFunction'],
          resources: [props.connectInstanceArn],
        }),
        new iam.PolicyStatement({
          actions: ['lambda:AddPermission', 'lambda:RemovePermission', 'lambda:GetPolicy'],
          resources: [this.describeContactFunction.functionArn],
        }),
      ]),
    });
    associateDescribeContact.node.addDependency(this.describeContactFunction);

    // --- Stack outputs ---
    if (this.updateSessionContextFunction) {
      new cdk.CfnOutput(this, 'UpdateSessionContextFnArn', {
        value: this.updateSessionContextFunction.functionArn,
        description: 'ARN of the UpdateSessionContext Lambda',
      });
    }
    new cdk.CfnOutput(this, 'DescribeContactFnArn', {
      value: this.describeContactFunction.functionArn,
      description: 'ARN of the DescribeContact Lambda',
    });
  }
}
