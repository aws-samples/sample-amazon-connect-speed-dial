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
   * When true, deploy and associate the UpdateSessionContext Lambda used for
   * pre-call context injection. When false it is not created (the flow does not
   * invoke it), avoiding an unused function in the deployment.
   */
  contextInjectionEnabled: boolean;
  /**
   * When true, deploy and associate the ProfileLookup Lambda that searches
   * Customer Profiles and bridges the result into the Q Connect session.
   */
  customerProfilesEnabled: boolean;
  /** Customer Profiles domain to search (required when customerProfilesEnabled). */
  profilesDomainName?: string;
  /** Static demo phone used as the fallback profile lookup key. */
  demoProfilePhone?: string;
}

/**
 * Stack that deploys Lambda functions invoked from within Connect contact flows.
 *
 * - UpdateSessionContext: pushes contextual data into the Q Connect session
 * - DescribeContact: calls DescribeContact and logs results to CloudWatch
 *
 * Each Lambda is granted least-privilege IAM policies and associated with
 * the Connect instance so it can be referenced from flow blocks.
 */
export class ConnectFlowLambdasStack extends BlueprintStack {
  /** Set only when contextInjectionEnabled; undefined otherwise. */
  public readonly updateSessionContextFunction?: lambda.Function;
  /** Set only when customerProfilesEnabled; undefined otherwise. */
  public readonly profileLookupFunction?: lambda.Function;
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

    // --- Update Session Context Lambda (pre-call context injection) ---
    // Only deployed when context injection is enabled; otherwise the flow never
    // invokes it, so leaving it out keeps the deployment free of an unused function.
    if (props.contextInjectionEnabled) {
      const updateSessionContextFunction = new lambda.Function(this, 'UpdateSessionContextFunction', {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(
          path.join(__dirname, '../lambda/flow/update-session-context'),
        ),
        layers: [boto3Layer],
        timeout: cdk.Duration.seconds(15),
        description: 'Pushes contextual data into the Q Connect session before the AI agent starts',
        environment: {
          ASSISTANT_ID: props.assistantId,
          LOG_LEVEL: 'INFO',
        },
      });
      this.updateSessionContextFunction = updateSessionContextFunction;

      // Allow the Lambda to update Q Connect session data.
      // UpdateSessionData authorizes against the *session* resource
      // (arn:...:session/<assistantId>/<sessionId>), not the assistant ARN — so
      // the session resource must be granted explicitly or the call is denied.
      // The session-id segment is a wildcard by necessity: the session ARN is
      // resolved at runtime from contact data (via DescribeContact) and is not
      // known at synth time. Scope stays bounded to this specific assistant.
      updateSessionContextFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['wisdom:UpdateSessionData'],
          resources: [
            `arn:aws:wisdom:${this.region}:${this.account}:assistant/${props.assistantId}`,
            `arn:aws:wisdom:${this.region}:${this.account}:session/${props.assistantId}/*`,
          ],
        }),
      );

      // Allow the Lambda to call DescribeContact (needed to resolve the session ARN)
      updateSessionContextFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['connect:DescribeContact'],
          resources: [`${props.connectInstanceArn}/contact/*`],
        }),
      );

      // Allow Amazon Connect to invoke this Lambda
      updateSessionContextFunction.addPermission('ConnectInvoke', {
        principal: new iam.ServicePrincipal('connect.amazonaws.com'),
        sourceAccount: this.account,
        sourceArn: props.connectInstanceArn,
      });

      // Associate the Lambda with the Connect instance
      const associateUpdateSession = new cr.AwsCustomResource(this, 'AssociateUpdateSessionLambda', {
        onCreate: {
          service: 'Connect',
          action: 'associateLambdaFunction',
          parameters: {
            InstanceId: props.connectInstanceId,
            FunctionArn: updateSessionContextFunction.functionArn,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `${props.connectInstanceId}-${updateSessionContextFunction.functionName}`,
          ),
        },
        onDelete: {
          service: 'Connect',
          action: 'disassociateLambdaFunction',
          parameters: {
            InstanceId: props.connectInstanceId,
            FunctionArn: updateSessionContextFunction.functionArn,
          },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['connect:AssociateLambdaFunction', 'connect:DisassociateLambdaFunction'],
            resources: [props.connectInstanceArn],
          }),
          new iam.PolicyStatement({
            actions: ['lambda:AddPermission', 'lambda:RemovePermission', 'lambda:GetPolicy'],
            resources: [updateSessionContextFunction.functionArn],
          }),
        ]),
      });
      associateUpdateSession.node.addDependency(updateSessionContextFunction);

      new cdk.CfnOutput(this, 'UpdateSessionContextFnArn', {
        value: updateSessionContextFunction.functionArn,
        description: 'ARN of the UpdateSessionContext Lambda',
      });
    }

    // --- Profile Lookup Lambda (Customer Profiles) ---
    // Deployed only when customer profiles are enabled. Searches Customer
    // Profiles for the caller and bridges the result into the Q Connect session
    // (UpdateSessionData, namespace Custom) so the agent reads it as {{$.Custom.*}}.
    if (props.customerProfilesEnabled) {
      const profileLookupFunction = new lambda.Function(this, 'ProfileLookupFunction', {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/flow/profile-lookup')),
        layers: [boto3Layer],
        timeout: cdk.Duration.seconds(15),
        description: 'Searches Customer Profiles and bridges the result into the Q Connect session',
        environment: {
          ASSISTANT_ID: props.assistantId,
          PROFILES_DOMAIN: props.profilesDomainName ?? '',
          DEMO_PROFILE_PHONE: props.demoProfilePhone ?? '',
          LOG_LEVEL: 'INFO',
        },
      });
      this.profileLookupFunction = profileLookupFunction;

      // Search Customer Profiles (domain-scoped).
      profileLookupFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['profile:SearchProfiles'],
          resources: [
            `arn:aws:profile:${this.region}:${this.account}:domains/${props.profilesDomainName}`,
            `arn:aws:profile:${this.region}:${this.account}:domains/${props.profilesDomainName}/*`,
          ],
        }),
      );
      // Bridge into the Q Connect session (session resource, as for context injection).
      // The session-id segment is a wildcard by necessity: the session ARN is
      // resolved at runtime from contact data and is not known at synth time.
      // Scope stays bounded to this specific assistant.
      profileLookupFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['wisdom:UpdateSessionData'],
          resources: [
            `arn:aws:wisdom:${this.region}:${this.account}:assistant/${props.assistantId}`,
            `arn:aws:wisdom:${this.region}:${this.account}:session/${props.assistantId}/*`,
          ],
        }),
      );
      profileLookupFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['connect:DescribeContact'],
          resources: [`${props.connectInstanceArn}/contact/*`],
        }),
      );

      this.associateFlowLambda(
        'AssociateProfileLookupLambda',
        profileLookupFunction,
        props.connectInstanceId,
        props.connectInstanceArn,
      );

      new cdk.CfnOutput(this, 'ProfileLookupFnArn', {
        value: profileLookupFunction.functionArn,
        description: 'ARN of the ProfileLookup Lambda',
      });
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

    // --- Outputs ---
    new cdk.CfnOutput(this, 'DescribeContactFnArn', {
      value: this.describeContactFunction.functionArn,
      description: 'ARN of the DescribeContact Lambda',
    });
  }
}
