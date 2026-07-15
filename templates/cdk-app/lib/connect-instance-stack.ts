import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import { DataLakeAccess, DataType } from '@cdklabs/cdk-construct-connect-datalake';
import { Construct } from 'constructs';
import { config } from './config';
import { BlueprintStack } from './blueprint-stack';

/**
 * Phone number on the seeded demo Customer Profile. A clearly-fake fixed E.164
 * value, reused by the flow as the static fallback lookup key so the demo
 * profile resolves even on web-call / fresh-DID contacts with no matching ANI.
 */
export const DEMO_PROFILE_PHONE = '+15550100123';

export interface ConnectInstanceStackProps extends cdk.StackProps {
  /** When true, S3 buckets are emptied and deleted on stack teardown. */
  autoDeleteBuckets: boolean;
}

/**
 * Provisions the Amazon Connect instance and foundational integrations.
 *
 * Creates the Connect instance with managed identity, a Customer Profiles
 * domain (with CTR integration), and a data-storage S3 bucket. When
 * `config.encryptionEnabled` (default), a customer-managed KMS key is created
 * and used to encrypt the storage bucket and the Connect storage configs (call
 * recordings, chat transcripts, scheduled reports). All downstream stacks
 * depend on outputs from this stack (instance ARN, ID, alias).
 */
export class ConnectInstanceStack extends BlueprintStack {
  public readonly instanceArn: string;
  public readonly instanceId: string;
  public readonly instanceAlias: string;
  public readonly customerProfilesDomainName: string;
  public readonly storageBucketName: string;
  public readonly storageBucketArn: string;

  constructor(scope: Construct, id: string, props: ConnectInstanceStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'Amazon Connect instance, Customer Profiles domain, and data storage';

    const alias = this.namer.instanceAlias();

    const instance = new connect.CfnInstance(this, 'Instance', {
      identityManagementType: 'CONNECT_MANAGED',
      instanceAlias: alias,
      attributes: {
        inboundCalls: true,
        outboundCalls: false,
        contactflowLogs: true,
        contactLens: true,
        autoResolveBestVoices: true,
      },
    });
    instance.applyRemovalPolicy(
      config.retainConnectInstance ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    );

    this.instanceArn = instance.attrArn;
    this.instanceId = instance.attrId;
    this.instanceAlias = alias;

    // --- Enable additional instance attributes ---
    // These cannot be set declaratively via CfnInstance.attributes, so a custom
    // resource calls UpdateInstanceAttribute for each one.
    // NOTE: BOT_MANAGEMENT is enabled in WisdomStack to avoid a race condition
    // with Lex SLR creation (it must run after the assistant is created but
    // before the Lex stack deploys).
    const safeAttributes = [
      'AUTOMATED_INTERACTION_LOG',
      'ENABLE_BOT_ANALYTICS_AND_TRANSCRIPTS',
    ];

    for (const attrType of safeAttributes) {
      const attr = new cr.AwsCustomResource(this, `Attr-${attrType}`, {
        onCreate: {
          service: 'Connect',
          action: 'updateInstanceAttribute',
          parameters: {
            InstanceId: instance.attrId,
            AttributeType: attrType,
            Value: 'true',
          },
          physicalResourceId: cr.PhysicalResourceId.of(`${instance.attrId}-attr-${attrType}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['connect:UpdateInstanceAttribute', 'connect:DescribeInstanceAttribute'],
            resources: [instance.attrArn],
          }),
          new iam.PolicyStatement({
            actions: ['iam:PutRolePolicy', 'iam:GetRole', 'iam:GetRolePolicy'],
            resources: [`arn:aws:iam::${this.account}:role/aws-service-role/connect.amazonaws.com/*`],
          }),
        ]),
      });
      attr.node.addDependency(instance);
    }

    // --- Customer Profiles ---
    // Compliance note: this domain and the seeded demo profile store personal
    // data (name, email, phone, account/order details). When Customer Profiles
    // holds regulated data (PHI under HIPAA, PII subject to GDPR, or cardholder
    // data under PCI-DSS), additional controls are the customer's responsibility
    // under the AWS shared responsibility model — e.g. a customer-managed KMS key
    // on the domain, data-retention/expiry tuning, access logging, and least-
    // privilege access. See https://aws.amazon.com/compliance/shared-responsibility-model/
    const profilesDomainName = this.namer.connect('profiles');

    // Create a Customer Profiles domain
    const createDomain = new cr.AwsCustomResource(this, 'CustomerProfilesDomain', {
      onCreate: {
        service: 'CustomerProfiles',
        action: 'createDomain',
        parameters: {
          DomainName: profilesDomainName,
          DefaultExpirationDays: 366,
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('DomainName'),
      },
      onDelete: {
        service: 'CustomerProfiles',
        action: 'deleteDomain',
        parameters: {
          DomainName: profilesDomainName,
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        // CreateDomain/DeleteDomain scoped to the target domain ARN. The domain
        // does not exist at policy-evaluation time, but Customer Profiles
        // authorizes CreateDomain against the requested domain ARN, so this
        // scoped pattern works and avoids an account-wide wildcard.
        new iam.PolicyStatement({
          actions: [
            'profile:CreateDomain',
            'profile:DeleteDomain',
          ],
          resources: [
            `arn:aws:profile:${this.region}:${this.account}:domains/${profilesDomainName}`,
          ],
        }),
        // CreateProfile/SearchProfiles are granted HERE (on the domain resource,
        // which runs first) rather than on the SeedDemoProfile resource below,
        // even though the seed is what actually calls them. All AwsCustomResource
        // constructs in a stack share ONE provider-Lambda role; granting the seed
        // its own policy attaches it to that role only ~2s before the seed invokes,
        // and IAM role-policy propagation to the assumed-role session is eventually
        // consistent (~5-15s), so on a fresh CREATE the call raced ahead of the
        // grant and failed with "not authorized to perform: profile:CreateProfile".
        // Attaching it to createDomain gives the grant the full domain-creation
        // window (~2+ min) to propagate before SeedDemoProfile runs.
        new iam.PolicyStatement({
          actions: ['profile:CreateProfile', 'profile:SearchProfiles'],
          resources: [
            `arn:aws:profile:${this.region}:${this.account}:domains/${profilesDomainName}`,
            `arn:aws:profile:${this.region}:${this.account}:domains/${profilesDomainName}/*`,
          ],
        }),
      ]),
    });
    createDomain.node.addDependency(instance);

    // Associate the Customer Profiles domain with the Connect instance
    const putIntegration = new cr.AwsCustomResource(this, 'CustomerProfilesIntegration', {
      onCreate: {
        service: 'CustomerProfiles',
        action: 'putIntegration',
        parameters: {
          DomainName: profilesDomainName,
          Uri: instance.attrArn,
          ObjectTypeName: 'CTR',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${alias}-profiles-integration`),
      },
      onDelete: {
        service: 'CustomerProfiles',
        action: 'deleteIntegration',
        parameters: {
          DomainName: profilesDomainName,
          Uri: instance.attrArn,
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'profile:PutIntegration',
            'profile:DeleteIntegration',
          ],
          // Scoped to the Customer Profiles domain and its sub-resources
          // (integrations live under domains/<name>/...). The integration URI
          // embeds the full Connect instance ARN, so we match the whole domain
          // sub-tree rather than trying to construct an exact integration ARN.
          resources: [
            `arn:aws:profile:${this.region}:${this.account}:domains/${profilesDomainName}`,
            `arn:aws:profile:${this.region}:${this.account}:domains/${profilesDomainName}/*`,
          ],
        }),
        new iam.PolicyStatement({
          actions: ['connect:DescribeInstance'],
          resources: [instance.attrArn],
        }),
        new iam.PolicyStatement({
          actions: ['iam:CreateServiceLinkedRole'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'iam:AWSServiceName': 'customer-profiles.amazonaws.com',
            },
          },
        }),
      ]),
    });
    putIntegration.node.addDependency(createDomain);

    // --- Seed a demo Customer Profile ---
    // When customer profiles are enabled, seed one demo customer so the flow's
    // lookup has something to find. The persona matches the gateway sample tools
    // and the context-injection demo data (Alice Johnson / CUST001 / ORD-12345),
    // so the whole blueprint tells one coherent customer story. The demo phone
    // (a clearly-fake fixed E.164) is also the static fallback lookup key the
    // flow uses on web-call / fresh-DID contacts that have no matching ANI.
    // Idempotent: search first, only create if absent.
    if (config.customerProfilesEnabled) {
      const seedProfile = new cr.AwsCustomResource(this, 'SeedDemoProfile', {
        onCreate: {
          service: 'CustomerProfiles',
          action: 'createProfile',
          parameters: {
            DomainName: profilesDomainName,
            FirstName: 'Alice',
            LastName: 'Johnson',
            AccountNumber: 'CUST001',
            PhoneNumber: DEMO_PROFILE_PHONE,
            EmailAddress: 'alice@example.com',
            PartyType: 'INDIVIDUAL',
            Attributes: {
              accountTier: 'Premium',
              recentOrderId: 'ORD-12345',
              orderStatus: 'Shipped',
              openCaseCount: '1',
            },
          },
          // Domain-scoped physical id so re-deploys don't create duplicates.
          physicalResourceId: cr.PhysicalResourceId.of(`${profilesDomainName}-demo-profile`),
          ignoreErrorCodesMatching: 'DuplicateResourceException|ConflictException',
        },
        // No onDelete: the domain is deleted with the instance, taking profiles with it.
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['profile:CreateProfile', 'profile:SearchProfiles'],
            resources: [
              `arn:aws:profile:${this.region}:${this.account}:domains/${profilesDomainName}`,
              `arn:aws:profile:${this.region}:${this.account}:domains/${profilesDomainName}/*`,
            ],
          }),
        ]),
      });
      seedProfile.node.addDependency(putIntegration);
    }

    this.customerProfilesDomainName = profilesDomainName;

    // --- Storage encryption key (customer-managed KMS) ---
    // When encryption is enabled, a CMK encrypts both the storage bucket and the
    // Connect storage configs below. The Connect "Data storage" setting only
    // supports SSE_KMS (no AES256 option), so enabling it requires a key.
    //
    // The key policy MUST allow the Amazon Connect service to use the key, or
    // recordings/transcripts/reports fail to write at runtime even though the
    // deploy succeeds. The grant is scoped to this account via SourceAccount.
    let storageKey: kms.Key | undefined;
    if (config.encryptionEnabled) {
      storageKey = new kms.Key(this, 'StorageKey', {
        alias: this.namer.connect('storage'),
        description: 'Customer-managed key for Connect storage (recordings, transcripts, reports) and the storage bucket',
        enableKeyRotation: true,
        removalPolicy: config.retainConnectInstance ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      });
      storageKey.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowAmazonConnectUseOfTheKey',
          principals: [new iam.ServicePrincipal('connect.amazonaws.com')],
          actions: ['kms:GenerateDataKey*', 'kms:Decrypt', 'kms:DescribeKey'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
        }),
      );
    }

    // --- S3 Storage Bucket ---
    const storageBucket = new s3.Bucket(this, 'StorageBucket', {
      bucketNamePrefix: `${this.prefix}-${config.storageBucketBaseName}`,
      bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: storageKey ? s3.BucketEncryption.KMS : s3.BucketEncryption.S3_MANAGED,
      encryptionKey: storageKey,
      enforceSSL: true,
      versioned: true,
      removalPolicy: props.autoDeleteBuckets ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.autoDeleteBuckets,
      lifecycleRules: [
        {
          id: 'TransitionToIAAndGlacier',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(180),
            },
          ],
        },
      ],
    });

    this.storageBucketName = storageBucket.bucketName;
    this.storageBucketArn = storageBucket.bucketArn;

    // Deny uploads using customer-provided encryption keys (SSE-C)
    storageBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'RestrictSSECObjectUploads',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [storageBucket.arnForObjects('*')],
      conditions: {
        Null: { 's3:x-amz-server-side-encryption-customer-algorithm': 'false' },
      },
    }));

    // --- Instance Storage Configs ---
    // When encryption is enabled, each config encrypts with the CMK via
    // encryptionConfig (SSE_KMS — the only Connect-layer option). When disabled,
    // encryptionConfig is omitted and Connect uses its service-managed default.
    const s3StorageConfig = (prefix: string): connect.CfnInstanceStorageConfig.S3ConfigProperty => ({
      bucketName: storageBucket.bucketName,
      bucketPrefix: prefix,
      ...(storageKey
        ? { encryptionConfig: { encryptionType: 'KMS', keyId: storageKey.keyArn } }
        : {}),
    });

    const callRecordingsStorage = new connect.CfnInstanceStorageConfig(this, 'CallRecordingsStorage', {
      instanceArn: instance.attrArn,
      resourceType: 'CALL_RECORDINGS',
      storageType: 'S3',
      s3Config: s3StorageConfig('call-recordings'),
    });
    callRecordingsStorage.node.addDependency(storageBucket);

    const chatTranscriptsStorage = new connect.CfnInstanceStorageConfig(this, 'ChatTranscriptsStorage', {
      instanceArn: instance.attrArn,
      resourceType: 'CHAT_TRANSCRIPTS',
      storageType: 'S3',
      s3Config: s3StorageConfig('chat-transcripts'),
    });
    chatTranscriptsStorage.node.addDependency(storageBucket);

    const scheduledReportsStorage = new connect.CfnInstanceStorageConfig(this, 'ScheduledReportsStorage', {
      instanceArn: instance.attrArn,
      resourceType: 'SCHEDULED_REPORTS',
      storageType: 'S3',
      s3Config: s3StorageConfig('scheduled-reports'),
    });
    scheduledReportsStorage.node.addDependency(storageBucket);

    const contactEvaluationsStorage = new connect.CfnInstanceStorageConfig(this, 'ContactEvaluationsStorage', {
      instanceArn: instance.attrArn,
      resourceType: 'CONTACT_EVALUATIONS',
      storageType: 'S3',
      s3Config: s3StorageConfig('contact-evaluations'),
    });
    contactEvaluationsStorage.node.addDependency(storageBucket);

    new cdk.CfnOutput(this, 'InstanceArn', { value: this.instanceArn });
    new cdk.CfnOutput(this, 'InstanceId', { value: this.instanceId });
    new cdk.CfnOutput(this, 'InstanceAlias', { value: this.instanceAlias });
    new cdk.CfnOutput(this, 'CustomerProfilesDomainName', { value: this.customerProfilesDomainName });
    new cdk.CfnOutput(this, 'StorageBucketName', { value: this.storageBucketName });
    if (storageKey) {
      new cdk.CfnOutput(this, 'StorageKmsKeyArn', { value: storageKey.keyArn });
    }

    // --- Analytics Data Lake ---
    if (config.dataLakeEnabled) {
      const dataLake = new DataLakeAccess(this, 'DataLakeAccess', {
        instanceId: this.instanceId,
        datasetIds: [
          DataType.CONTACT_RECORD,
          DataType.CONTACT_FLOW_EVENTS,
          DataType.AGENT_STATISTIC_RECORD,
          DataType.CONTACT_STATISTIC_RECORD,
        ],
      });
      dataLake.node.addDependency(instance);
    }
  }
}
