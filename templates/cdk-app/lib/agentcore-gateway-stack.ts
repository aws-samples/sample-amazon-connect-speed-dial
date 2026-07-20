import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as appintegrations from 'aws-cdk-lib/aws-appintegrations';
import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';
import { BlueprintStack } from './blueprint-stack';

/**
 * Name of the SAP order lookup gateway target.
 *
 * AgentCore Gateway namespaces every tool a target exposes as
 * `${targetName}___${toolName}`. Q in Connect AI agents allow-list a tool by
 * that fully-qualified id (see `toolId` in `wisdom-stack.ts`), so the target
 * name is exported and shared rather than duplicated.
 */
export const SAP_GATEWAY_TARGET = 'SapOrderLookup';

/** Tool names exposed by the SAP order gateway target. */
export const SAP_GATEWAY_TOOLS = ['get_order_status', 'get_delivery_tracking', 'get_invoice_status'] as const;

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
  public readonly gatewayRole: iam.IRole;
  public readonly gatewayName: string;
  public readonly sapOrderTableName: string;
  public readonly sapToolFnArn: string;

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
    this.gatewayName = gatewayName;
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
    this.gatewayRole = gatewayRole;

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

    new cdk.CfnOutput(this, 'GatewayArn', { value: this.gatewayArn });
    new cdk.CfnOutput(this, 'GatewayId', { value: this.gatewayId });
    new cdk.CfnOutput(this, 'SchemaBucketName', { value: this.schemaBucketName });
    new cdk.CfnOutput(this, 'DiscoveryUrl', { value: discoveryUrl });
    new cdk.CfnOutput(this, 'McpServerUrl', { value: gatewayMcpUrl });
    new cdk.CfnOutput(this, 'McpApplicationArn', { value: mcpApplication.attrApplicationArn });

    // --- SAP SD Order Lookup API ---
    // DynamoDB-backed mock for AI agent order queries, registered as the
    // gateway's Lambda target.

    const ordersTable = new dynamodb.Table(this, 'SapOrdersTable', {
      tableName: this.namer.connect('sap-orders'),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Seeded/ingested records expire 365 days after write (both SapSeedFn
      // and SapDocumentIngestFn set the `ttl` attribute on every item).
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    ordersTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.sapOrderTableName = ordersTable.tableName;

    const sapToolFn = new lambda.Function(this, 'SapToolFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'SAP SD order lookup — order status, delivery tracking, invoice status',
      environment: {
        TABLE_NAME: ordersTable.tableName,
        LOG_LEVEL: 'ERROR',
      },
      code: lambda.Code.fromInline(SAP_ORDER_TOOL_HANDLER),
    });

    ordersTable.grantReadData(sapToolFn);
    this.sapToolFnArn = sapToolFn.functionArn;

    // Seed data custom resource
    const seedFn = new lambda.Function(this, 'SapSeedFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      description: 'Seeds the SAP orders table with sample data on stack creation',
      code: lambda.Code.fromInline(SAP_SEED_HANDLER),
    });

    ordersTable.grantWriteData(seedFn);

    new cdk.CustomResource(this, 'SapSeedData', {
      serviceToken: seedFn.functionArn,
      properties: {
        TABLE_NAME: ordersTable.tableName,
      },
    });

    // SAP order gateway target — uses the L2 GatewayTarget.forLambda() construct
    const sapTarget = bedrockagentcore.GatewayTarget.forLambda(this, 'SapOrderTarget', {
      gatewayTargetName: SAP_GATEWAY_TARGET,
      description: 'SAP SD order lookup — order status, delivery tracking, invoice status',
      gateway: bedrockagentcore.Gateway.fromGatewayAttributes(this, 'SapGatewayRef', {
        gatewayArn: this.gatewayArn,
        gatewayId: this.gatewayId,
        gatewayName: this.namer.connect('gateway'),
        role: gatewayRole,
      }),
      lambdaFunction: sapToolFn,
      toolSchema: bedrockagentcore.ToolSchema.fromInline([
        {
          name: 'get_order_status',
          description: 'Look up SAP sales order status by order number. Returns order header, line items, and derived lifecycle status. Requires the authenticated caller\'s customer_number for access control.',
          inputSchema: {
            type: bedrockagentcore.SchemaDefinitionType.OBJECT,
            properties: {
              order_number: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'SAP sales order number (e.g. 12345 or 0000012345)' },
              customer_number: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'SAP customer number of the authenticated caller. MUST be the value from session context ({{$.Custom.customerId}}). Used for access control — only orders belonging to this customer are returned.' },
            },
            required: ['order_number', 'customer_number'],
          },
        },
        {
          name: 'get_delivery_tracking',
          description: 'Track delivery status for a SAP sales order. Returns delivery documents, goods issue status, and estimated arrival. Requires the authenticated caller\'s customer_number for access control.',
          inputSchema: {
            type: bedrockagentcore.SchemaDefinitionType.OBJECT,
            properties: {
              order_number: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'SAP sales order number (e.g. 12345 or 0000012345)' },
              customer_number: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'SAP customer number of the authenticated caller. MUST be the value from session context ({{$.Custom.customerId}}). Used for access control — only orders belonging to this customer are returned.' },
              delivery_number: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'Optional specific delivery document number' },
            },
            required: ['order_number', 'customer_number'],
          },
        },
        {
          name: 'get_invoice_status',
          description: 'Check invoice and billing status for a SAP sales order. Returns invoice documents, payment terms, and due dates. Requires the authenticated caller\'s customer_number for access control.',
          inputSchema: {
            type: bedrockagentcore.SchemaDefinitionType.OBJECT,
            properties: {
              order_number: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'SAP sales order number (e.g. 12345 or 0000012345)' },
              customer_number: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'SAP customer number of the authenticated caller. MUST be the value from session context ({{$.Custom.customerId}}). Used for access control — only orders belonging to this customer are returned.' },
              invoice_number: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'Optional specific invoice document number' },
            },
            required: ['order_number', 'customer_number'],
          },
        },
      ]),
    });
    sapTarget.node.addDependency(gateway);

    new cdk.CfnOutput(this, 'SapOrderTableName', { value: ordersTable.tableName });
    new cdk.CfnOutput(this, 'SapToolFnArn', { value: sapToolFn.functionArn });

    // --- SAP document ingestion (S3 -> Lambda -> SapOrdersTable) ---
    // A second, document-driven path into the same table: source documents
    // dropped into this bucket are parsed and written using the same item
    // shape as SapSeedFn (PK/SK, GSI1PK/GSI1SK).
    //
    // ASSUMPTION: this mock integration has no real SAP IDoc/PDF/CSV format to
    // parse against, so uploaded documents are expected to be JSON with the
    // same order/items/delivery/invoice shape as the seed data below. Flag
    // this to the user — swap DOCUMENT_INGEST_HANDLER's parsing logic if the
    // real source format differs.
    const documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketNamePrefix: this.namer.connect('sap-documents'),
      bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'RetainLast3Versions',
          noncurrentVersionsToRetain: 3,
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    // Deny uploads using customer-provided encryption keys (SSE-C) — same
    // pattern as SchemaBucket's RestrictSSECObjectUploads statement above.
    documentsBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'RestrictSSECObjectUploads',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [documentsBucket.arnForObjects('*')],
      conditions: {
        Null: { 's3:x-amz-server-side-encryption-customer-algorithm': 'false' },
      },
    }));

    const documentIngestFn = new lambda.Function(this, 'SapDocumentIngestFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      description: 'Parses uploaded SAP source documents and writes extracted order/delivery/invoice data into SapOrdersTable',
      environment: {
        TABLE_NAME: ordersTable.tableName,
        LOG_LEVEL: 'ERROR',
      },
      code: lambda.Code.fromInline(SAP_DOCUMENT_INGEST_HANDLER),
    });

    ordersTable.grantWriteData(documentIngestFn);
    // Read-only access to the objects this function is triggered by.
    documentsBucket.grantRead(documentIngestFn);

    documentsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(documentIngestFn),
    );

    new cdk.CfnOutput(this, 'SapDocumentsBucketName', { value: documentsBucket.bucketName });
    new cdk.CfnOutput(this, 'SapDocumentIngestFnArn', { value: documentIngestFn.functionArn });
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
// Inline Python handler for the SAP order tool Lambda
// ---------------------------------------------------------------------------
const SAP_ORDER_TOOL_HANDLER = `
import json
import logging
import os
import re
from datetime import date

import boto3
from boto3.dynamodb.conditions import Key

log_level = os.environ.get('LOG_LEVEL', 'ERROR')
logger = logging.getLogger()
logger.setLevel(getattr(logging, log_level, logging.ERROR))

TABLE_NAME = os.environ.get('TABLE_NAME', '')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)


def lambda_handler(event, context):
    """Dispatch to the appropriate tool handler based on AgentCore tool name."""
    try:
        tool_name = ''
        if context.client_context and hasattr(context.client_context, 'custom'):
            extended = context.client_context.custom.get('bedrockAgentCoreToolName', '')
            tool_name = extended.split('___')[-1] if '___' in extended else extended

        logger.info(f"Tool dispatched: {tool_name}")

        args = tool_args(event)

        if tool_name == 'get_order_status':
            return handle_get_order_status(args)
        elif tool_name == 'get_delivery_tracking':
            return handle_get_delivery_tracking(args)
        elif tool_name == 'get_invoice_status':
            return handle_get_invoice_status(args)
        else:
            return {'statusCode': 400, 'body': json.dumps({'error': f'Unknown tool: {tool_name}'})}

    except Exception as e:
        logger.error(f"Handler error: {e}", exc_info=True)
        return {'statusCode': 500, 'body': json.dumps({'error': 'Internal server error'})}


def tool_args(event):
    """Unwrap tool arguments from various AgentCore Gateway payload shapes."""
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


def normalize_order_number(raw):
    """Strip non-digits and zero-pad to 10 digits (SAP VBELN format)."""
    if not raw:
        return ''
    digits = re.sub(r'[^0-9]', '', str(raw))
    if not digits:
        return ''
    return digits.zfill(10)


def derive_order_lifecycle(items):
    """Derive overall order lifecycle status from existing record types."""
    sk_prefixes = {item.get('SK', '') for item in items}
    has_invoice = any(sk.startswith('INVOICE#') for sk in sk_prefixes)
    has_delivery_gi = any(
        item.get('actualGoodsIssueDate') for item in items
        if item.get('SK', '').startswith('DELIVERY#')
    )
    has_delivery = any(sk.startswith('DELIVERY#') for sk in sk_prefixes)

    if has_invoice:
        return 'Invoiced'
    if has_delivery_gi:
        return 'Delivered'
    if has_delivery:
        return 'In Delivery'
    return 'Open'


def format_order_response(items, order_number):
    """Format DynamoDB items into a structured order response."""
    header = None
    line_items = []
    for item in items:
        sk = item.get('SK', '')
        if sk.startswith('HEADER'):
            header = {
                'orderNumber': item.get('VBELN', order_number),
                'customerNumber': item.get('customerNumber', ''),
                'orderType': item.get('orderType', ''),
                'netValue': item.get('netValue', ''),
                'currency': item.get('currency', ''),
                'requestedDeliveryDate': item.get('requestedDeliveryDate', ''),
                'salesOrg': item.get('salesOrg', ''),
            }
        elif sk.startswith('ITEM#'):
            line_items.append({
                'itemNumber': item.get('itemNumber', ''),
                'materialNumber': item.get('materialNumber', ''),
                'description': item.get('description', ''),
                'quantity': item.get('quantity', ''),
                'unit': item.get('unit', ''),
                'netPrice': item.get('netPrice', ''),
            })

    status = derive_order_lifecycle(items)
    return {
        'order': header or {'orderNumber': order_number},
        'items': line_items,
        'status': status,
    }


def verify_order_ownership(order_number, customer_number):
    """Verify that the order belongs to the customer using the GSI.

    Returns True if ownership is confirmed, False otherwise. This is the
    hard access-control gate — even if the model sends a wrong customer
    number, data for another customer is never returned.
    """
    if not customer_number:
        return False
    gsi_resp = table.query(
        IndexName='GSI1',
        KeyConditionExpression=(
            Key('GSI1PK').eq(f'CUSTOMER#{customer_number}')
            & Key('GSI1SK').eq(f'ORDER#{order_number}')
        ),
    )
    return len(gsi_resp.get('Items', [])) > 0


def handle_get_order_status(args):
    """Look up SAP order status by order number with ownership verification."""
    order_number = normalize_order_number(args.get('order_number', ''))
    customer_number = normalize_order_number(args.get('customer_number', ''))

    logger.info(f"get_order_status: order={order_number} customer={customer_number}")

    # Access control: customer_number is mandatory
    if not customer_number:
        return {'statusCode': 403, 'body': json.dumps({'error': 'customer_number is required for access control'})}

    if not order_number:
        # Customer-only lookup: list orders for this customer via GSI
        gsi_resp = table.query(
            IndexName='GSI1',
            KeyConditionExpression=Key('GSI1PK').eq(f'CUSTOMER#{customer_number}'),
        )
        orders = [item.get('GSI1SK', '').replace('ORDER#', '') for item in gsi_resp.get('Items', [])]
        if not orders:
            return {'statusCode': 200, 'body': json.dumps({'message': 'No orders found for this customer'})}
        # Return first order found
        order_number = orders[0]

    # Ownership check via GSI — reject if order does not belong to this customer
    if not verify_order_ownership(order_number, customer_number):
        return {'statusCode': 200, 'body': json.dumps({'message': f'Order {order_number} not found'})}

    pk = f'ORDER#{order_number}'

    # Query header + items
    header_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('HEADER'),
    )
    items_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('ITEM#'),
    )

    # Also check for delivery/invoice existence to derive status
    delivery_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('DELIVERY#'),
    )
    invoice_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('INVOICE#'),
    )

    all_items = (
        header_resp.get('Items', [])
        + items_resp.get('Items', [])
        + delivery_resp.get('Items', [])
        + invoice_resp.get('Items', [])
    )

    if not header_resp.get('Items'):
        return {'statusCode': 200, 'body': json.dumps({'message': f'Order {order_number} not found'})}

    result = format_order_response(all_items, order_number)
    return {'statusCode': 200, 'body': json.dumps(result, default=str)}


def handle_get_delivery_tracking(args):
    """Track delivery status for a SAP sales order with ownership verification."""
    order_number = normalize_order_number(args.get('order_number', ''))
    customer_number = normalize_order_number(args.get('customer_number', ''))
    delivery_number = normalize_order_number(args.get('delivery_number', ''))

    logger.info(f"get_delivery_tracking: order={order_number} customer={customer_number} delivery={delivery_number}")

    # Access control: customer_number is mandatory
    if not customer_number:
        return {'statusCode': 403, 'body': json.dumps({'error': 'customer_number is required for access control'})}

    if not order_number:
        return {'statusCode': 400, 'body': json.dumps({'error': 'order_number is required'})}

    # Ownership check via GSI — reject if order does not belong to this customer
    if not verify_order_ownership(order_number, customer_number):
        return {'statusCode': 200, 'body': json.dumps({'message': f'No deliveries found for order {order_number}'})}

    pk = f'ORDER#{order_number}'

    # Query deliveries
    if delivery_number:
        sk_condition = Key('SK').eq(f'DELIVERY#{delivery_number}')
    else:
        sk_condition = Key('SK').begins_with('DELIVERY#')

    delivery_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & sk_condition,
    )

    # Query delivery items
    delivery_items_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('DELIVERY_ITEM#'),
    )

    deliveries = delivery_resp.get('Items', [])
    delivery_items = delivery_items_resp.get('Items', [])

    if not deliveries:
        return {'statusCode': 200, 'body': json.dumps({'message': f'No deliveries found for order {order_number}'})}

    # Format delivery response
    formatted_deliveries = []
    for d in deliveries:
        actual_gi = d.get('actualGoodsIssueDate', '')
        planned_gi = d.get('goodsIssueDate', '')
        today_str = date.today().isoformat()

        if actual_gi:
            status = 'Delivered' if actual_gi <= today_str else 'In Transit'
        elif planned_gi:
            status = 'Goods Issued'
        else:
            status = 'Planned'

        formatted_deliveries.append({
            'deliveryNumber': d.get('VBELN', ''),
            'status': status,
            'plannedGoodsIssueDate': planned_gi,
            'actualGoodsIssueDate': actual_gi,
            'route': d.get('route', ''),
            'shippingCondition': d.get('shippingCondition', ''),
            'totalWeight': d.get('totalWeight', ''),
            'weightUnit': d.get('weightUnit', ''),
            'estimatedArrival': d.get('estimatedArrival', planned_gi),
        })

    formatted_items = []
    for item in delivery_items:
        formatted_items.append({
            'itemNumber': item.get('itemNumber', ''),
            'materialNumber': item.get('materialNumber', ''),
            'description': item.get('description', ''),
            'quantity': item.get('quantity', ''),
            'unit': item.get('unit', ''),
        })

    result = {
        'orderNumber': order_number,
        'deliveries': formatted_deliveries,
        'deliveryItems': formatted_items,
    }
    return {'statusCode': 200, 'body': json.dumps(result, default=str)}


def handle_get_invoice_status(args):
    """Check invoice and billing status for a SAP sales order with ownership verification."""
    order_number = normalize_order_number(args.get('order_number', ''))
    customer_number = normalize_order_number(args.get('customer_number', ''))
    invoice_number = normalize_order_number(args.get('invoice_number', ''))

    logger.info(f"get_invoice_status: order={order_number} customer={customer_number} invoice={invoice_number}")

    # Access control: customer_number is mandatory
    if not customer_number:
        return {'statusCode': 403, 'body': json.dumps({'error': 'customer_number is required for access control'})}

    if not order_number:
        return {'statusCode': 400, 'body': json.dumps({'error': 'order_number is required'})}

    # Ownership check via GSI — reject if order does not belong to this customer
    if not verify_order_ownership(order_number, customer_number):
        return {'statusCode': 200, 'body': json.dumps({'message': f'No invoices found for order {order_number}'})}

    pk = f'ORDER#{order_number}'

    # Query invoices
    if invoice_number:
        sk_condition = Key('SK').eq(f'INVOICE#{invoice_number}')
    else:
        sk_condition = Key('SK').begins_with('INVOICE#')

    invoice_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & sk_condition,
    )

    # Query invoice items
    invoice_items_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('INVOICE_ITEM#'),
    )

    invoices = invoice_resp.get('Items', [])
    invoice_items = invoice_items_resp.get('Items', [])

    if not invoices:
        return {'statusCode': 200, 'body': json.dumps({'message': f'No invoices found for order {order_number}', 'status': 'Not Invoiced'})}

    # Format invoice response
    formatted_invoices = []
    for inv in invoices:
        billing_date = inv.get('billingDate', '')
        status = 'Invoiced' if billing_date else 'Not Invoiced'

        formatted_invoices.append({
            'invoiceNumber': inv.get('VBELN', ''),
            'status': status,
            'billingDate': billing_date,
            'netValue': inv.get('netValue', ''),
            'taxAmount': inv.get('taxAmount', ''),
            'currency': inv.get('currency', ''),
            'paymentTerms': inv.get('paymentTerms', ''),
            'paymentTermsDescription': inv.get('paymentTermsDescription', ''),
            'dueDate': inv.get('dueDate', ''),
        })

    formatted_items = []
    for item in invoice_items:
        formatted_items.append({
            'itemNumber': item.get('itemNumber', ''),
            'materialNumber': item.get('materialNumber', ''),
            'description': item.get('description', ''),
            'quantity': item.get('quantity', ''),
            'netPrice': item.get('netPrice', ''),
            'taxAmount': item.get('taxAmount', ''),
        })

    overall_status = 'Invoiced' if any(inv.get('billingDate') for inv in invoices) else 'Not Invoiced'
    result = {
        'orderNumber': order_number,
        'status': overall_status,
        'invoices': formatted_invoices,
        'invoiceItems': formatted_items,
    }
    return {'statusCode': 200, 'body': json.dumps(result, default=str)}
`;

// ---------------------------------------------------------------------------
// Inline Python handler for the seed data custom resource
// ---------------------------------------------------------------------------
const SAP_SEED_HANDLER = `
import json
import logging
import time
import urllib.request

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TTL_SECONDS = 365 * 24 * 60 * 60  # 365 days


def handler(event, context):
    logger.info(
        "SeedData: RequestType=%s PhysicalResourceId=%s",
        event.get('RequestType'),
        event.get('PhysicalResourceId', '-'),
    )
    try:
        if event['RequestType'] == 'Create':
            seed_data(event['ResourceProperties']['TABLE_NAME'])
        # Update and Delete are no-ops
        send(event, context, 'SUCCESS')
    except Exception as e:
        logger.error(f"Seed error: {e}", exc_info=True)
        send(event, context, 'FAILED', reason=str(e))


def seed_data(table_name):
    """Populate 2 complete SAP SD order cycles as sample data."""
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(table_name)

    items = [
        # --- Order 12345: Fully completed cycle ---
        # Order header
        {
            'PK': 'ORDER#0000012345',
            'SK': 'HEADER',
            'VBELN': '0000012345',
            'customerNumber': '0000100042',
            'orderType': 'ZOR',
            'netValue': '15250.00',
            'currency': 'EUR',
            'requestedDeliveryDate': '2025-03-22',
            'salesOrg': '1000',
            'distributionChannel': '10',
            'division': '00',
        },
        # Order items
        {
            'PK': 'ORDER#0000012345',
            'SK': 'ITEM#000010',
            'itemNumber': '000010',
            'materialNumber': 'MAT-A100',
            'description': 'Premium Widget Assembly',
            'quantity': '100',
            'unit': 'EA',
            'netPrice': '12500.00',
            'currency': 'EUR',
        },
        {
            'PK': 'ORDER#0000012345',
            'SK': 'ITEM#000020',
            'itemNumber': '000020',
            'materialNumber': 'MAT-B200',
            'description': 'Standard Connector Kit',
            'quantity': '50',
            'unit': 'EA',
            'netPrice': '2750.00',
            'currency': 'EUR',
        },
        # Delivery (completed)
        {
            'PK': 'ORDER#0000012345',
            'SK': 'DELIVERY#0080012001',
            'VBELN': '0080012001',
            'goodsIssueDate': '2025-03-22',
            'actualGoodsIssueDate': '2025-03-22',
            'route': 'R00001',
            'shippingCondition': 'DDP',
            'shippingPoint': 'Hamburg',
            'totalWeight': '250',
            'weightUnit': 'KG',
        },
        # Delivery items
        {
            'PK': 'ORDER#0000012345',
            'SK': 'DELIVERY_ITEM#0080012001#000010',
            'deliveryNumber': '0080012001',
            'itemNumber': '000010',
            'materialNumber': 'MAT-A100',
            'description': 'Premium Widget Assembly',
            'quantity': '100',
            'unit': 'EA',
        },
        {
            'PK': 'ORDER#0000012345',
            'SK': 'DELIVERY_ITEM#0080012001#000020',
            'deliveryNumber': '0080012001',
            'itemNumber': '000020',
            'materialNumber': 'MAT-B200',
            'description': 'Standard Connector Kit',
            'quantity': '50',
            'unit': 'EA',
        },
        # Invoice (billed)
        {
            'PK': 'ORDER#0000012345',
            'SK': 'INVOICE#0090015001',
            'VBELN': '0090015001',
            'billingDate': '2025-03-23',
            'netValue': '15250.00',
            'taxAmount': '2897.50',
            'currency': 'EUR',
            'paymentTerms': 'Z030',
            'paymentTermsDescription': '30 days net',
            'dueDate': '2025-04-22',
        },
        # Invoice items
        {
            'PK': 'ORDER#0000012345',
            'SK': 'INVOICE_ITEM#0090015001#000010',
            'invoiceNumber': '0090015001',
            'itemNumber': '000010',
            'materialNumber': 'MAT-A100',
            'description': 'Premium Widget Assembly',
            'quantity': '100',
            'netPrice': '12500.00',
            'taxAmount': '2375.00',
        },
        {
            'PK': 'ORDER#0000012345',
            'SK': 'INVOICE_ITEM#0090015001#000020',
            'invoiceNumber': '0090015001',
            'itemNumber': '000020',
            'materialNumber': 'MAT-B200',
            'description': 'Standard Connector Kit',
            'quantity': '50',
            'netPrice': '2750.00',
            'taxAmount': '522.50',
        },
        # Customer index record
        {
            'PK': 'ORDER#0000012345',
            'SK': 'CUSTOMER_IDX',
            'GSI1PK': 'CUSTOMER#0000100042',
            'GSI1SK': 'ORDER#0000012345',
        },

        # --- Order 12346: In transit, no invoice ---
        # Order header
        {
            'PK': 'ORDER#0000012346',
            'SK': 'HEADER',
            'VBELN': '0000012346',
            'customerNumber': '0000100042',
            'orderType': 'ZOR',
            'netValue': '8500.00',
            'currency': 'EUR',
            'requestedDeliveryDate': '2025-03-28',
            'salesOrg': '1000',
            'distributionChannel': '10',
            'division': '00',
        },
        # Order item
        {
            'PK': 'ORDER#0000012346',
            'SK': 'ITEM#000010',
            'itemNumber': '000010',
            'materialNumber': 'MAT-C300',
            'description': 'Industrial Sensor Pack',
            'quantity': '25',
            'unit': 'EA',
            'netPrice': '8500.00',
            'currency': 'EUR',
        },
        # Delivery (in transit — no actual GI date)
        {
            'PK': 'ORDER#0000012346',
            'SK': 'DELIVERY#0080012002',
            'VBELN': '0080012002',
            'goodsIssueDate': '2025-03-26',
            'route': 'R00002',
            'shippingCondition': 'DDP',
            'shippingPoint': 'Munich',
            'totalWeight': '75',
            'weightUnit': 'KG',
        },
        # Delivery item
        {
            'PK': 'ORDER#0000012346',
            'SK': 'DELIVERY_ITEM#0080012002#000010',
            'deliveryNumber': '0080012002',
            'itemNumber': '000010',
            'materialNumber': 'MAT-C300',
            'description': 'Industrial Sensor Pack',
            'quantity': '25',
            'unit': 'EA',
        },
        # Customer index record
        {
            'PK': 'ORDER#0000012346',
            'SK': 'CUSTOMER_IDX',
            'GSI1PK': 'CUSTOMER#0000100042',
            'GSI1SK': 'ORDER#0000012346',
        },
    ]

    ttl_value = int(time.time()) + TTL_SECONDS

    with table.batch_writer() as batch:
        for item in items:
            item['ttl'] = ttl_value
            batch.put_item(Item=item)

    logger.info(f"Seeded {len(items)} items into {table_name}")


def send(event, context, status, reason=None):
    """Send CloudFormation custom resource response."""
    body = {
        'Status': status,
        'Reason': reason or f"See CloudWatch: {context.log_stream_name}",
        'PhysicalResourceId': event.get('PhysicalResourceId', context.log_stream_name),
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
    }
    req = urllib.request.Request(
        event['ResponseURL'],
        data=json.dumps(body).encode(),
        headers={'Content-Type': ''},
        method='PUT',
    )
    urllib.request.urlopen(req)
`;
// ---------------------------------------------------------------------------
// Inline Python handler for the SAP document ingestion Lambda
//
// Parses the SAP SD order-to-cash JSON format documented in
// \`sap-sd-order-sample.json\` (repo root) — technical SAP table/field names
// (VBAK/VBAP sales order, LIKP/LIPS delivery, VBRK/VBRP billing, VBFA document
// flow) — and maps it onto the same PK/SK/GSI1PK/GSI1SK item shape SapSeedFn
// writes, so ingested documents land in SapOrdersTable alongside seed data.
// A document may carry the full order-to-cash bundle (salesOrder + delivery +
// billing, as in the sample file) or just one stage (e.g. a delivery-only or
// billing-only extract); resolve_order_number() below falls back to the LIPS
// VGBEL / VBFA document-flow chain when salesOrder.header is absent.
// ---------------------------------------------------------------------------
const SAP_DOCUMENT_INGEST_HANDLER = `
import json
import logging
import os
import time
import urllib.parse

import boto3

log_level = os.environ.get('LOG_LEVEL', 'ERROR')
logger = logging.getLogger()
logger.setLevel(getattr(logging, log_level, logging.ERROR))

TABLE_NAME = os.environ.get('TABLE_NAME', '')
TTL_SECONDS = 365 * 24 * 60 * 60  # 365 days

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)


def handler(event, context):
    """Entry point for S3 ObjectCreated notifications."""
    records = event.get('Records', [])
    logger.info(f"Processing {len(records)} S3 event record(s)")

    processed = 0
    failed = 0
    for record in records:
        try:
            bucket = record['s3']['bucket']['name']
            key = urllib.parse.unquote_plus(record['s3']['object']['key'])
            process_document(bucket, key)
            processed += 1
        except Exception as e:
            # Log only non-sensitive metadata (bucket/key), never document body.
            logger.error(f"Failed to process object: {e}", exc_info=True)
            failed += 1

    logger.info(f"Ingestion complete: processed={processed} failed={failed}")
    if failed and not processed:
        # Let Lambda report failure when nothing succeeded, so S3/Lambda retry
        # policies and any configured DLQ can react.
        raise RuntimeError(f"Failed to process {failed} document(s)")


def process_document(bucket, key):
    logger.info(f"Fetching s3://{bucket}/{key}")
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj['Body'].read()

    try:
        document = json.loads(body)
    except (ValueError, TypeError) as e:
        raise ValueError(f"Unable to parse {key} as JSON: {e}")

    items = extract_items(document)
    if not items:
        logger.info(f"No extractable order data in {key}")
        return

    ttl_value = int(time.time()) + TTL_SECONDS
    with table.batch_writer() as batch:
        for item in items:
            item['ttl'] = ttl_value
            batch.put_item(Item=item)

    logger.info(f"Wrote {len(items)} item(s) from {key} into {TABLE_NAME}")


def normalize_order_number(raw):
    """Strip non-digits and zero-pad to 10 digits (SAP VBELN format)."""
    digits = ''.join(c for c in str(raw or '') if c.isdigit())
    return digits.zfill(10) if digits else ''


def resolve_order_number(document):
    """Determine the sales order number (VBELN) a document belongs to.

    Prefers the direct salesOrder.header.VBELN. Falls back to a delivery
    item's VGBEL (LIPS-VGBEL — SAP populates this with the originating sales
    order number), then walks the VBFA document-flow chain backward
    (billing -> delivery -> order) when only a billing document is present.
    """
    sales_order = document.get('salesOrder') or {}
    vbeln = (sales_order.get('header') or {}).get('VBELN')
    if vbeln:
        return normalize_order_number(vbeln)

    delivery_items = (document.get('delivery') or {}).get('items') or []
    if delivery_items and delivery_items[0].get('VGBEL'):
        return normalize_order_number(delivery_items[0]['VGBEL'])

    billing_items = (document.get('billing') or {}).get('items') or []
    flow_links = (document.get('documentFlow') or {}).get('links') or []
    if billing_items and billing_items[0].get('VGBEL'):
        # VBRP-VGBEL on a billing item is the originating delivery number;
        # walk the VBFA link (predecessor VBELV -> successor VBELN) backward
        # from that delivery number to find the order that produced it.
        delivery_vbeln = billing_items[0]['VGBEL']
        for link in flow_links:
            if link.get('VBELN') == delivery_vbeln:
                return normalize_order_number(link.get('VBELV'))

    return ''


def extract_items(document):
    """Map an SAP SD order-to-cash JSON document onto SapOrdersTable's
    PK/SK item shape (same shape SapSeedFn writes — see sap-sd-order-sample.json
    for the source field names: VBAK/VBAP, LIKP/LIPS, VBRK/VBRP).
    """
    order_number = resolve_order_number(document)
    if not order_number:
        raise ValueError(
            'unable to resolve order number: document has no salesOrder.header.VBELN, '
            'delivery item VGBEL, or resolvable VBFA document flow'
        )

    pk = f'ORDER#{order_number}'
    items = []

    sales_order = document.get('salesOrder') or {}
    header = sales_order.get('header') or {}
    if header:
        items.append({
            'PK': pk,
            'SK': 'HEADER',
            'VBELN': order_number,
            'customerNumber': normalize_order_number(header.get('KUNNR')),
            'orderType': header.get('AUART', ''),
            'netValue': str(header.get('NETWR', '')),
            'currency': header.get('WAERK', ''),
            'requestedDeliveryDate': header.get('VDATU', ''),
            'salesOrg': header.get('VKORG', ''),
            'distributionChannel': header.get('VTWEG', ''),
            'division': header.get('SPART', ''),
        })

    for line in sales_order.get('items', []):
        item_number = str(line.get('POSNR', ''))
        items.append({
            'PK': pk,
            'SK': f'ITEM#{item_number}',
            'itemNumber': item_number,
            'materialNumber': line.get('MATNR', ''),
            'description': line.get('ARKTX', ''),
            'quantity': str(line.get('KWMENG', '')),
            'unit': line.get('VRKME', ''),
            'netPrice': str(line.get('NETWR', '')),
            'currency': line.get('WAERK', header.get('WAERK', '')),
        })

    delivery = document.get('delivery') or {}
    delivery_header = delivery.get('header') or {}
    if delivery_header:
        delivery_number = normalize_order_number(delivery_header.get('VBELN'))
        items.append({
            'PK': pk,
            'SK': f'DELIVERY#{delivery_number}',
            'VBELN': delivery_number,
            'goodsIssueDate': delivery_header.get('WADAT', ''),
            'actualGoodsIssueDate': delivery_header.get('WADAT_IST', ''),
            'route': delivery_header.get('ROUTE', ''),
            'shippingCondition': delivery_header.get('INCO1', ''),
            'shippingPoint': delivery_header.get('INCO2', ''),
            'totalWeight': str(delivery_header.get('BTGEW', '')),
            'weightUnit': delivery_header.get('GEWEI', ''),
        })
        for line in delivery.get('items', []):
            item_number = str(line.get('POSNR', ''))
            items.append({
                'PK': pk,
                'SK': f'DELIVERY_ITEM#{delivery_number}#{item_number}',
                'deliveryNumber': delivery_number,
                'itemNumber': item_number,
                'materialNumber': line.get('MATNR', ''),
                'description': line.get('ARKTX', ''),
                'quantity': str(line.get('LFIMG', '')),
                'unit': line.get('VRKME', ''),
            })

    billing = document.get('billing') or {}
    billing_header = billing.get('header') or {}
    if billing_header:
        invoice_number = normalize_order_number(billing_header.get('VBELN'))
        billing_line_items = billing.get('items', [])
        # VBRK (billing header) carries no tax total in this source format;
        # derive it from the sum of VBRP (line item) MWSBP, matching how the
        # seed fixture's header taxAmount equals the sum of its line items.
        tax_total = sum(float(li.get('MWSBP', 0) or 0) for li in billing_line_items)
        items.append({
            'PK': pk,
            'SK': f'INVOICE#{invoice_number}',
            'VBELN': invoice_number,
            'billingDate': billing_header.get('FKDAT', ''),
            'netValue': str(billing_header.get('NETWR', '')),
            'taxAmount': f'{tax_total:.2f}' if billing_line_items else '',
            'currency': billing_header.get('WAERK', ''),
            'paymentTerms': billing_header.get('ZTERM', ''),
            # Not present in this source document (VBRK carries the payment
            # terms code but not a human-readable description or computed due
            # date — that requires joining table T052) — left blank rather
            # than guessed.
            'paymentTermsDescription': '',
            'dueDate': '',
        })
        for line in billing_line_items:
            item_number = str(line.get('POSNR', ''))
            items.append({
                'PK': pk,
                'SK': f'INVOICE_ITEM#{invoice_number}#{item_number}',
                'invoiceNumber': invoice_number,
                'itemNumber': item_number,
                'materialNumber': line.get('MATNR', ''),
                'description': line.get('ARKTX', ''),
                'quantity': str(line.get('FKIMG', '')),
                'netPrice': str(line.get('NETWR', '')),
                'taxAmount': str(line.get('MWSBP', '')),
            })

    customer_number = normalize_order_number(header.get('KUNNR')) if header else ''
    if customer_number:
        items.append({
            'PK': pk,
            'SK': 'CUSTOMER_IDX',
            'GSI1PK': f'CUSTOMER#{customer_number}',
            'GSI1SK': f'ORDER#{order_number}',
        })

    return items
`;
