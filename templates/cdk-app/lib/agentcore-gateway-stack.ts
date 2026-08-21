import * as path from 'path';
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
import { config } from './config';

/** Where the Lambda function source folders live, relative to this file. */
const LAMBDA_DIR = path.join(__dirname, '..', 'lambda', 'tools');

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
export const SAP_GATEWAY_TOOLS = ['get_order_history', 'get_order_status', 'get_delivery_tracking', 'get_invoice_status', 'get_active_promotions'] as const;

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
      bucketNamePrefix: this.namer.bucketPrefix('gateway-schemas'),
      bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !config.retainData,
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

    // Gate: a new Connect instance is reported "created" before its public
    // hostname resolves in DNS. The gateway stabilizes by fetching the OIDC
    // discovery URL, so creating it too early yields UnknownHostException and a
    // full rollback. Poll the URL until it serves HTTP 200, then create the
    // gateway. (Outbound HTTPS only; basic Lambda logging role.)
    const oidcReadyFn = new lambda.Function(this, 'OidcReadyFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(6),
      memorySize: 128,
      description: 'Waits for the Connect instance OIDC discovery URL to resolve and serve 200',
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, 'oidc-ready')),
    });
    const oidcReady = new cdk.CustomResource(this, 'OidcReadyGate', {
      serviceToken: oidcReadyFn.functionArn,
      properties: { DiscoveryUrl: discoveryUrl },
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
    // Do not create the gateway until the OIDC endpoint is reachable.
    gateway.node.addDependency(oidcReady);

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
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, 'agentcore-gateway-post-create')),
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
      removalPolicy: config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, 'sap-order')),
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
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, 'sap-seed')),
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
          name: 'get_order_history',
          description: 'List all SAP sales orders for the authenticated caller, most recent first. Returns a summary row per order (order number, type, net value, requested delivery date, lifecycle status). Use this when the caller asks what orders they have, about "my orders", or about their most recent/last order without giving an order number — then call get_order_status with a returned order number for full detail. Requires only the authenticated caller\'s customer_number.',
          inputSchema: {
            type: bedrockagentcore.SchemaDefinitionType.OBJECT,
            properties: {
              customer_number: { type: bedrockagentcore.SchemaDefinitionType.STRING, description: 'SAP customer number of the authenticated caller. MUST be the value from session context ({{$.Custom.customerId}}). Used for access control — only orders belonging to this customer are returned.' },
            },
            required: ['customer_number'],
          },
        },
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
        {
          name: 'get_active_promotions',
          // No customer_number: promotions are public campaign data, identical
          // for every caller — the ONE tool an unidentified caller may use.
          // The e2e tool-call test relies on this tool precisely because it
          // needs no identity and its answer exists nowhere but the tool.
          description: 'List the currently active promotions and discount codes. Public campaign information — available to EVERY caller, identified or not; requires no customer number and no arguments. Use this whenever the caller asks about promotions, discounts, offers, deals, or vouchers. Always read the promotion code aloud exactly as returned.',
          inputSchema: {
            type: bedrockagentcore.SchemaDefinitionType.OBJECT,
            properties: {},
            required: [],
          },
        },
      ]),
    });
    // Order the target strictly AFTER PostCreateConfig, not just after the
    // gateway. PostCreateConfig calls UpdateGateway (to set the JWT
    // allowedAudience), which transiently moves the gateway into UPDATING —
    // and CreateGatewayTarget is rejected with a 400 while the gateway is
    // UPDATING. Both resources depended only on `gateway`, so CloudFormation
    // ran them concurrently and the target creation intermittently raced the
    // update. PostCreateConfig waits for the gateway to return to READY before
    // it completes, so depending on it guarantees the target sees a stable
    // gateway. (postCreate already depends on gateway, so that edge is
    // preserved transitively — same ordering as mcpApplication above.)
    sapTarget.node.addDependency(postCreate);

    // --- SAP document ingestion (S3 -> Lambda -> SapOrdersTable) ---
    // A second, document-driven path into the same table: source documents
    // dropped into this bucket are parsed and written using the same item
    // shape as SapSeedFn (PK/SK, GSI1PK/GSI1SK).
    //
    // ASSUMPTION: this mock integration has no real SAP IDoc/PDF/CSV format to
    // parse against, so uploaded documents are expected to be JSON with the
    // same order/items/delivery/invoice shape as the seed data. Flag this to
    // the user — swap the parsing logic in
    // `lambda/tools/sap-document-ingest/index.py` if the real source format
    // differs.
    const documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketNamePrefix: this.namer.bucketPrefix('sap-documents'),
      bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !config.retainData,
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
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, 'sap-document-ingest')),
    });

    ordersTable.grantWriteData(documentIngestFn);
    // Read-only access to the objects this function is triggered by.
    documentsBucket.grantRead(documentIngestFn);

    documentsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(documentIngestFn),
    );

    // --- Stack outputs ---
    new cdk.CfnOutput(this, 'GatewayArn', { value: this.gatewayArn });
    new cdk.CfnOutput(this, 'GatewayId', { value: this.gatewayId });
    new cdk.CfnOutput(this, 'SchemaBucketName', { value: this.schemaBucketName });
    new cdk.CfnOutput(this, 'DiscoveryUrl', { value: discoveryUrl });
    new cdk.CfnOutput(this, 'McpServerUrl', { value: gatewayMcpUrl });
    new cdk.CfnOutput(this, 'McpApplicationArn', { value: mcpApplication.attrApplicationArn });
    new cdk.CfnOutput(this, 'SapOrderTableName', { value: ordersTable.tableName });
    new cdk.CfnOutput(this, 'SapToolFnArn', { value: sapToolFn.functionArn });
    new cdk.CfnOutput(this, 'SapDocumentsBucketName', { value: documentsBucket.bucketName });
    new cdk.CfnOutput(this, 'SapDocumentIngestFnArn', { value: documentIngestFn.functionArn });
  }
}

