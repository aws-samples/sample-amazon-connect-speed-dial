import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as appintegrations from 'aws-cdk-lib/aws-appintegrations';
import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';
import { BlueprintStack } from './blueprint-stack';

/**
 * Name of the sample Lambda gateway target.
 *
 * AgentCore Gateway namespaces every tool a target exposes as
 * `${targetName}___${toolName}`. Q in Connect AI agents allow-list a tool by
 * that fully-qualified id (see `toolId` in `wisdom-stack.ts`), so the target
 * name is exported and shared rather than duplicated.
 */
export const SAMPLE_GATEWAY_TARGET = 'SampleCustomerLookup';

/** Tool names exposed by the sample gateway target (must match the inline schema below). */
export const SAMPLE_GATEWAY_TOOLS = ['get_customer_info', 'get_order_status'] as const;

export interface AgentCoreGatewayStackProps extends cdk.StackProps {
  instanceAlias: string;
  instanceId: string;
  instanceArn: string;
}

/**
 * Provisions a Bedrock AgentCore MCP gateway for the Connect instance.
 *
 * Creates an S3 bucket for OpenAPI schemas, an IAM role with least-privilege
 * permissions, and the CfnGateway resource configured with custom JWT
 * authorization against the Connect instance's OIDC discovery endpoint.
 */
export class AgentCoreGatewayStack extends BlueprintStack {
  public readonly gatewayArn: string;
  public readonly gatewayId: string;
  public readonly schemaBucketName: string;

  constructor(scope: Construct, id: string, props: AgentCoreGatewayStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'Bedrock AgentCore MCP gateway with schema bucket and JWT authorization';

    const discoveryUrl = `https://${props.instanceAlias}.my.connect.aws/.well-known/openid-configuration`;

    // S3 bucket for hosting OpenAPI schemas — account-regional namespace, TLS enforced
    const schemaBucket = new s3.Bucket(this, 'SchemaBucket', {
      bucketNamePrefix: this.namer.connect('gateway-schemas'),
      bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'TransitionToIA',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
        {
          id: 'RetainLast3Versions',
          noncurrentVersionExpiration: cdk.Duration.days(1),
          noncurrentVersionsToRetain: 3,
        },
      ],
    });

    // Deny uploads using customer-provided encryption keys (SSE-C)
    schemaBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'RestrictSSECObjectUploads',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [schemaBucket.arnForObjects('*')],
      conditions: {
        Null: { 's3:x-amz-server-side-encryption-customer-algorithm': 'false' },
      },
    }));

    // IAM role for the gateway — mirrors reference template permissions
    // Gateway name is reused for name-prefix scoping of the IAM policy below.
    const gatewayName = this.namer.connect('gateway');
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Allows the AgentCore gateway to read schemas, invoke targets, and manage workload identities',
      inlinePolicies: {
        GatewayPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [schemaBucket.arnForObjects('*')],
            }),
            // Scoping note: this role is assumed BY the gateway and must exist
            // BEFORE the CfnGateway, so the concrete gateway ARN cannot go in an
            // inline statement (Role -> Gateway -> Role would be circular). But
            // the gateway ID is `<gatewayName>-<random>` and AgentCore names the
            // gateway's workload identity after the gateway, so both are scopable
            // by name prefix at synth time — no account-wide wildcard needed.
            // Matches the AWS gateway outbound-auth guidance (workload-identity/
            // <GatewayName>-*, token-vault/default/apikeycredentialprovider/*).
            new iam.PolicyStatement({
              actions: ['bedrock-agentcore:InvokeGateway'],
              resources: [
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/${gatewayName}-*`,
              ],
            }),
            new iam.PolicyStatement({
              actions: ['bedrock-agentcore:GetWorkloadAccessToken'],
              resources: [
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/${gatewayName}-*`,
              ],
            }),
            new iam.PolicyStatement({
              actions: ['bedrock-agentcore:GetResourceApiKey'],
              resources: [
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default`,
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default/apikeycredentialprovider/*`,
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/${gatewayName}-*`,
              ],
            }),
            // Scoped to this project's secret name prefix. Widget/gateway signing
            // keys are created with `${prefix}-*` names; customers can tighten to
            // exact secret ARNs when their names are known ahead of deploy.
            new iam.PolicyStatement({
              actions: ['secretsmanager:GetSecretValue'],
              resources: [
                `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${this.prefix}-*`,
              ],
            }),
          ],
        }),
      },
    });

    const gateway = new bedrockagentcore.CfnGateway(this, 'Gateway', {
      name: this.namer.connect('gateway'),
      authorizerType: 'CUSTOM_JWT',
      protocolType: 'MCP',
      roleArn: gatewayRole.roleArn,
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl,
          allowedAudience: ['placeholder'], // Updated post-deploy with gateway ID
        },
      },
    });

    this.gatewayArn = gateway.attrGatewayArn;
    // CfnGateway only exposes attrGatewayArn; extract the ID from the ARN
    // ARN format: arn:aws:bedrock-agentcore:<region>:<account>:gateway/<gatewayId>
    this.gatewayId = cdk.Fn.select(1, cdk.Fn.split('gateway/', gateway.attrGatewayArn));
    this.schemaBucketName = schemaBucket.bucketName;

    // --- Post-creation setup (Lambda-backed custom resource) ---
    // 1. Waits for gateway to reach READY status
    // 2. Updates allowedAudience from 'placeholder' to the real gateway ID
    // This must complete before the gateway is registered with Connect below,
    // since the MCP server association requires the gateway to trust the
    // instance's OIDC issuer (discovery URL + audience).
    const postCreateRole = new iam.Role(this, 'PostCreateRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the gateway post-create custom resource Lambda',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        GatewayPostCreate: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'bedrock-agentcore:GetGateway',
                'bedrock-agentcore:UpdateGateway',
              ],
              // Scoped to the gateway this stack creates — its ARN is known here
              // because this role is defined after the CfnGateway resource.
              resources: [gateway.attrGatewayArn],
            }),
            new iam.PolicyStatement({
              actions: ['iam:PassRole'],
              resources: [gatewayRole.roleArn],
              conditions: {
                StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' },
              },
            }),
          ],
        }),
      },
    });

    const postCreateFn = new lambda.Function(this, 'PostCreateFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      role: postCreateRole,
      timeout: cdk.Duration.minutes(10),
      memorySize: 256,
      description: 'Waits for the gateway to reach READY and updates the JWT allowedAudience',
      code: lambda.Code.fromInline(POST_CREATE_HANDLER),
    });

    const postCreate = new cdk.CustomResource(this, 'PostCreateConfig', {
      serviceToken: postCreateFn.functionArn,
      properties: {
        GatewayId: this.gatewayId,
        GatewayName: this.namer.connect('gateway'),
        RoleArn: gatewayRole.roleArn,
        DiscoveryUrl: discoveryUrl,
      },
    });
    postCreate.node.addDependency(gateway);

    // --- Register the gateway with Connect as an MCP server ---
    // The Connect console's "Add integration -> MCP server" flow is two API
    // calls: AppIntegrations CreateApplication (type MCP_SERVER, pointed at the
    // gateway's MCP URL) and Connect CreateIntegrationAssociation (type
    // APPLICATION, linking the instance to that application). Both have L1-only
    // CDK coverage. The gateway's MCP endpoint follows a fixed format derived
    // from the gateway id and region — the same URL the gateway exposes as
    // `gatewayUrl`.
    const gatewayMcpUrl =
      `https://${this.gatewayId}.gateway.bedrock-agentcore.${this.region}.amazonaws.com/mcp`;

    const mcpApplication = new appintegrations.CfnApplication(this, 'McpApplication', {
      name: this.namer.connect('mcp'),
      // Namespace must match ^[a-zA-Z0-9/._-]+$ — the gateway id satisfies it.
      namespace: this.gatewayId,
      applicationType: 'MCP_SERVER',
      description: 'AgentCore MCP gateway exposed to Connect AI agents as tools',
      applicationSourceConfig: {
        externalUrlConfig: { accessUrl: gatewayMcpUrl },
      },
    });
    // The association requires the gateway to already trust the instance's OIDC
    // issuer, which PostCreateConfig sets (discovery URL + audience). Order them.
    mcpApplication.node.addDependency(postCreate);

    const mcpAssociation = new connect.CfnIntegrationAssociation(this, 'McpAssociation', {
      // CfnIntegrationAssociation.instanceId expects the instance ARN, not the id.
      instanceId: props.instanceArn,
      integrationType: 'APPLICATION',
      integrationArn: mcpApplication.attrApplicationArn,
    });
    mcpAssociation.node.addDependency(mcpApplication);

    // --- Sample Lambda target for testing gateway integration ---
    // This Lambda returns dummy data and demonstrates how AgentCore Gateway
    // invokes Lambda functions as MCP tools.
    const sampleToolFn = new lambda.Function(this, 'SampleToolFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      description: 'Sample Lambda target returning dummy customer data for gateway integration testing',
      code: lambda.Code.fromInline(SAMPLE_TOOL_HANDLER),
    });

    // Use the L2 GatewayTarget.forLambda() construct — no custom resource needed
    const sampleTarget = bedrockagentcore.GatewayTarget.forLambda(this, 'SampleLambdaTarget', {
      gatewayTargetName: 'SampleCustomerLookup',
      description: 'Sample Lambda target returning dummy customer data for testing',
      gateway: bedrockagentcore.Gateway.fromGatewayAttributes(this, 'GatewayRef', {
        gatewayArn: this.gatewayArn,
        gatewayId: this.gatewayId,
        gatewayName: this.namer.connect('gateway'),
        role: gatewayRole,
      }),
      lambdaFunction: sampleToolFn,
      toolSchema: bedrockagentcore.ToolSchema.fromInline([
        {
          name: 'get_customer_info',
          description: 'Look up customer information by customer ID or email address',
          inputSchema: {
            type: bedrockagentcore.SchemaDefinitionType.OBJECT,
            properties: {
              customer_id: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'The customer ID (e.g. CUST001)' },
              email: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'Customer email address' },
            },
            required: ['customer_id'],
          },
        },
        {
          name: 'get_order_status',
          description: 'Check the status of an order by order ID',
          inputSchema: {
            type: bedrockagentcore.SchemaDefinitionType.OBJECT,
            properties: {
              order_id: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'The order ID (e.g. ORD-12345)' },
            },
            required: ['order_id'],
          },
        },
      ]),
    });
    sampleTarget.node.addDependency(gateway);

    new cdk.CfnOutput(this, 'SampleToolFnArn', { value: sampleToolFn.functionArn });

    new cdk.CfnOutput(this, 'GatewayArn', { value: this.gatewayArn });
    new cdk.CfnOutput(this, 'GatewayId', { value: this.gatewayId });
    new cdk.CfnOutput(this, 'SchemaBucketName', { value: this.schemaBucketName });
    new cdk.CfnOutput(this, 'DiscoveryUrl', { value: discoveryUrl });
    new cdk.CfnOutput(this, 'McpServerUrl', { value: gatewayMcpUrl });
    new cdk.CfnOutput(this, 'McpApplicationArn', { value: mcpApplication.attrApplicationArn });
  }
}

// ---------------------------------------------------------------------------
// Inline Python handler for the post-create custom resource
// ---------------------------------------------------------------------------
const POST_CREATE_HANDLER = `
import json, logging, time, urllib.request
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    # Log only non-sensitive request metadata — never the full event, which
    # carries ResourceProperties config values.
    logger.info(
        "Event: RequestType=%s PhysicalResourceId=%s",
        event.get('RequestType'),
        event.get('PhysicalResourceId', '-'),
    )
    rt = event.get('RequestType')
    props = event.get('ResourceProperties', {})
    try:
        if rt in ('Create', 'Update'):
            res = handle_create(props)
        elif rt == 'Delete':
            res = handle_delete(event)
        else:
            raise ValueError(f"Unknown RequestType: {rt}")
        send(event, context, 'SUCCESS', res)
    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        send(event, context, 'FAILED', reason=str(e))


def wait_for_gateway(client, gw_id, max_attempts=30):
    """Poll until the gateway reaches READY status."""
    for i in range(max_attempts):
        try:
            r = client.get_gateway(gatewayIdentifier=gw_id)
            status = r.get('status')
            logger.info(f"Gateway {gw_id} status: {status} (attempt {i + 1})")
            if status == 'READY':
                return r
            if status in ('FAILED', 'DELETE_FAILED'):
                raise RuntimeError(f"Gateway in terminal state: {status}")
        except ClientError as e:
            if i < 5:
                logger.warning(f"GetGateway error (attempt {i + 1}): {e}")
            else:
                raise
        time.sleep(2)
    raise TimeoutError(f"Gateway {gw_id} did not reach READY in {max_attempts * 2}s")


def handle_create(props):
    gw_id = props['GatewayId']
    gw_name = props['GatewayName']
    role_arn = props['RoleArn']
    discovery_url = props['DiscoveryUrl']

    ac_client = boto3.client('bedrock-agentcore-control')

    # Step 1: Wait for gateway to be READY
    logger.info("Step 1: Waiting for gateway to be READY...")
    wait_for_gateway(ac_client, gw_id)

    # Step 2: Update allowedAudience from 'placeholder' to the real gateway ID
    logger.info(f"Step 2: Updating allowedAudience to [{gw_id}]...")
    ac_client.update_gateway(
        gatewayIdentifier=gw_id,
        name=gw_name,
        roleArn=role_arn,
        protocolType='MCP',
        authorizerType='CUSTOM_JWT',
        authorizerConfiguration={
            'customJWTAuthorizer': {
                'discoveryUrl': discovery_url,
                'allowedAudience': [gw_id],
            }
        },
    )
    logger.info("Gateway audience updated successfully")

    # Wait for gateway to stabilize after update
    gw_info = wait_for_gateway(ac_client, gw_id)
    gw_url = gw_info.get('gatewayUrl', '')

    return {
        'GatewayId': gw_id,
        'GatewayUrl': gw_url,
    }


def handle_delete(event):
    # Nothing to clean up — the CfnGateway resource handles gateway deletion.
    return {}


def send(event, context, status, data=None, reason=None):
    phys_id = (data or {}).get('GatewayId', event.get('PhysicalResourceId', context.log_stream_name))
    body = {
        'Status': status,
        'Reason': reason or f"See CloudWatch: {context.log_stream_name}",
        'PhysicalResourceId': phys_id,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
    }
    if data:
        body['Data'] = data
    req = urllib.request.Request(
        event['ResponseURL'],
        data=json.dumps(body).encode(),
        headers={'Content-Type': ''},
        method='PUT',
    )
    urllib.request.urlopen(req)
`;

// ---------------------------------------------------------------------------
// Inline Python handler for the sample tool Lambda
// ---------------------------------------------------------------------------
const SAMPLE_TOOL_HANDLER = `
import json
import logging
import re

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Compliance note: this sample uses only synthetic demo data. Production
# implementations that look up real customer data (names, emails, phone
# numbers, order history) are handling PII — customers are responsible for
# GDPR/CCPA and other data-protection obligations, including consent, data
# minimization, retention, and access controls (AWS shared responsibility model).
# Dummy customer data
CUSTOMERS = {
    'CUST001': {'customer_id': 'CUST001', 'name': 'Alice Johnson', 'email': 'alice@example.com', 'phone': '+1-555-0101', 'tier': 'Premium', 'lifetime_value': 2850.00},
    'CUST002': {'customer_id': 'CUST002', 'name': 'Bob Smith', 'email': 'bob@example.com', 'phone': '+1-555-0102', 'tier': 'Standard', 'lifetime_value': 1200.00},
    'CUST003': {'customer_id': 'CUST003', 'name': 'Carol Davis', 'email': 'carol@example.com', 'phone': '+1-555-0103', 'tier': 'Gold', 'lifetime_value': 4500.00},
}

# Dummy order data
ORDERS = {
    'ORD-12345': {'order_id': 'ORD-12345', 'customer_id': 'CUST001', 'status': 'Shipped', 'items': ['Widget Pro', 'Cable Kit'], 'total': 149.99, 'eta': '2026-06-28'},
    'ORD-67890': {'order_id': 'ORD-67890', 'customer_id': 'CUST002', 'status': 'Processing', 'items': ['Gadget X'], 'total': 299.99, 'eta': '2026-07-02'},
    'ORD-11111': {'order_id': 'ORD-11111', 'customer_id': 'CUST003', 'status': 'Delivered', 'items': ['Premium Bundle', 'Extended Warranty'], 'total': 899.99, 'eta': None},
}


def lambda_handler(event, context):
    # Do not log the full event payload: it carries user-submitted tool
    # parameters (customer_id, email, order_id). Only the resolved tool name is
    # logged below for traceability.
    # Lambda's ClientContext is an object without __dict__, so vars() raises.
    # Log only its 'custom' dict (where AgentCore puts the tool name).
    client_custom = getattr(context.client_context, 'custom', None) if context.client_context else None
    logger.info(f"Client context custom: {json.dumps(client_custom or {}, default=str)}")

    # PII-safe structural log: the SHAPE of the event only (top-level keys, and
    # the sub-keys of any nested dicts) — never the values — so we can see WHERE
    # the gateway places tool arguments (top level vs nested under
    # arguments/input/parameters/toolInput) without logging customer data.
    def _shape(obj):
        if isinstance(obj, dict):
            return {k: _shape(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return ['<list>'] if obj else []
        return type(obj).__name__
    logger.info(f"Event shape: {json.dumps(_shape(event) if isinstance(event, dict) else type(event).__name__, default=str)}")

    try:
        # AgentCore Gateway passes the tool name via client_context
        tool_name = ''
        if context.client_context and hasattr(context.client_context, 'custom'):
            extended = context.client_context.custom.get('bedrockAgentCoreToolName', '')
            # Format: TargetName___tool_name
            tool_name = extended.split('___')[-1] if '___' in extended else extended

        logger.info(f"Tool name: {tool_name}")

        if tool_name == 'get_customer_info':
            return handle_get_customer(tool_args(event))
        elif tool_name == 'get_order_status':
            return handle_get_order(tool_args(event))
        else:
            return {'statusCode': 400, 'body': f'Unknown tool: {tool_name}'}

    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        return {'statusCode': 500, 'body': f'Internal error: {str(e)}'}


def tool_args(event):
    # AgentCore Gateway does not guarantee where it places the tool's input
    # arguments: observed shapes include the args at the top level
    # ({"order_id": "..."}) and nested under a wrapper ({"arguments": {...}}).
    # A handler that only reads the top level silently gets an empty id and
    # returns "not found" for a real order. Accept either shape by unwrapping
    # the common wrapper keys, then falling back to the event itself.
    if isinstance(event, dict):
        for k in ('arguments', 'input', 'parameters', 'toolInput', 'body'):
            v = event.get(k)
            if isinstance(v, str):
                try:
                    v = json.loads(v)
                except (ValueError, TypeError):
                    v = None
            if isinstance(v, dict):
                return v
        return event
    return {}


def normalize_id(raw, prefix):
    # On a voice call the caller (and the speech-to-text) usually says only the
    # digits ("12345", "order number 12345"), dropping the ORD-/CUST prefix and
    # any zero-padding, so an exact dict-key match fails. Normalize to the stored
    # key shape: if the input contains a run of digits, treat that as the id and
    # re-apply the prefix (CUST ids are zero-padded to 3 digits, e.g. CUST001);
    # otherwise fall back to an uppercased, punctuation-stripped key.
    s = re.sub(r'[^A-Za-z0-9]', '', (raw or '').upper())
    if not s:
        return ''
    if s.startswith(prefix):
        s = s[len(prefix):]
    digits = re.sub(r'\\D', '', s)
    if digits:
        if prefix == 'CUST':
            return f'{prefix}{int(digits):03d}'
        return f'{prefix}-{digits}'
    # No digits at all — rebuild canonically from the alphanumeric remainder.
    return f'{prefix}-{s}' if prefix == 'ORD' else f'{prefix}{s}'


def handle_get_customer(event):
    raw_customer_id = event.get('customer_id', '')
    customer_id = normalize_id(raw_customer_id, 'CUST')
    email = event.get('email', '').strip().lower()
    # A customer record is PII (name/email/phone), so log only the lookup key and
    # whether it matched — never the resolved customer body. Log the presence of
    # an email, not its value.
    logger.info(f"get_customer_info requested id='{raw_customer_id}' normalized='{customer_id}' by_email={bool(email)}")

    customer = None
    if customer_id and customer_id in CUSTOMERS:
        customer = CUSTOMERS[customer_id]
    elif email:
        customer = next((c for c in CUSTOMERS.values() if c['email'] == email), None)

    if not customer:
        logger.info(f"get_customer_info response: customer not found (id='{customer_id}')")
        return {'statusCode': 200, 'body': f'Customer not found (searched: id={customer_id}, email={email})'}

    logger.info(f"get_customer_info response: found customer id='{customer_id}'")
    return {
        'statusCode': 200,
        'body': json.dumps(customer, indent=2),
    }


def handle_get_order(event):
    raw_order_id = event.get('order_id', '')
    order_id = normalize_id(raw_order_id, 'ORD')
    # Order ids are not PII, so log the requested + normalized value and the
    # resolved status to make tool-call troubleshooting possible from the logs.
    logger.info(f"get_order_status requested='{raw_order_id}' normalized='{order_id}'")

    order = ORDERS.get(order_id)
    if not order:
        logger.info(f"get_order_status response: order not found ('{order_id}')")
        return {'statusCode': 200, 'body': f'Order not found: {order_id}'}

    # Log only non-PII fields (order id + status); never dump the full order,
    # which carries customer_id (links to an individual).
    logger.info(
        "get_order_status response: order_id=%s status=%s",
        order.get('order_id', order_id),
        order.get('status', '-'),
    )
    return {
        'statusCode': 200,
        'body': json.dumps(order, indent=2),
    }
`;
