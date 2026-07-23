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
  /** ARN of the customer-managed storage key when encryptionEnabled; undefined otherwise. */
  public readonly storageKeyArn?: string;

  constructor(scope: Construct, id: string, props: ConnectInstanceStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'Amazon Connect instance, Customer Profiles domain, and data storage';

    const alias = this.namer.instanceAlias();

    // --- Identity management type ---
    // When Identity Center is enabled, the Connect instance uses SAML-based
    // identity (SSO via Identity Center). Otherwise it falls back to
    // CONNECT_MANAGED (built-in user/password management). This decision is
    // irreversible — identity type is fixed at instance creation time.
    const identityManagementType = config.identityCenterEnabled ? 'SAML' : 'CONNECT_MANAGED';

    const instance = new connect.CfnInstance(this, 'Instance', {
      identityManagementType,
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
      config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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
      'MESSAGE_STREAMING',
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

    // --- Storage encryption key (customer-managed KMS) ---
    // When encryption is enabled, a CMK encrypts both the storage bucket, the
    // Connect storage configs, AND the Customer Profiles domain. The Connect
    // "Data storage" setting only supports SSE_KMS (no AES256 option), so
    // enabling it requires a key.
    //
    // The key policy MUST allow the Amazon Connect service AND the Customer
    // Profiles service to use the key, or recordings/transcripts/reports/profile
    // data fail at runtime even though the deploy succeeds.
    let storageKey: kms.Key | undefined;
    // (exposed as storageKeyArn below once created — flow Lambdas that read
    // CMK-encrypted Customer Profiles data need kms:Decrypt on this key)
    if (config.encryptionEnabled) {
      storageKey = new kms.Key(this, 'StorageKey', {
        alias: this.namer.connect('storage'),
        description: 'Customer-managed key for Connect storage (recordings, transcripts, reports), S3 bucket, and Customer Profiles domain',
        enableKeyRotation: true,
        removalPolicy: config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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
      // Customer Profiles needs kms:CreateGrant, kms:Decrypt, and
      // kms:GenerateDataKey to encrypt/decrypt profile data at rest when the
      // domain is created with a DefaultEncryptionKey.
      storageKey.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowCustomerProfilesUseOfTheKey',
          principals: [new iam.ServicePrincipal('profile.amazonaws.com')],
          actions: ['kms:CreateGrant', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
        }),
      );
    }

    // --- Customer Profiles ---
    // Compliance note: this domain and the seeded demo profile store personal
    // data (name, email, phone, account/order details). When Customer Profiles
    // holds regulated data (PHI under HIPAA, PII subject to GDPR, or cardholder
    // data under PCI-DSS), additional controls are the customer's responsibility
    // under the AWS shared responsibility model — e.g. a customer-managed KMS key
    // on the domain, data-retention/expiry tuning, access logging, and least-
    // privilege access. See https://aws.amazon.com/compliance/shared-responsibility-model/
    const profilesDomainName = `amazon-connect-${this.prefix}-profiles`;

    // Create a Customer Profiles domain
    // When encryption is enabled, the storage CMK is reused as the domain's
    // DefaultEncryptionKey so all profile data at rest is encrypted with the
    // same customer-managed key used for recordings/transcripts/reports.
    const createDomain = new cr.AwsCustomResource(this, 'CustomerProfilesDomain', {
      onCreate: {
        service: 'CustomerProfiles',
        action: 'createDomain',
        parameters: {
          DomainName: profilesDomainName,
          DefaultExpirationDays: 366,
          ...(storageKey ? { DefaultEncryptionKey: storageKey.keyArn } : {}),
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
        // The custom resource Lambda needs KMS permissions to pass the key as
        // DefaultEncryptionKey when calling createDomain/createProfile.
        ...(storageKey ? [new iam.PolicyStatement({
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey', 'kms:CreateGrant'],
          resources: [storageKey.keyArn],
        })] : []),
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
        // The domain may already be deleted (by CustomerProfilesDomain's onDelete
        // or the instance teardown), so tolerate "not found" errors gracefully.
        ignoreErrorCodesMatching: 'NotFoundException|ResourceNotFoundException|BadRequestException',
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
    // lookup has something to find. The persona matches the AgentCore gateway's
    // SAP order lookup tools and the context-injection demo data (Alice Johnson
    // / order 0000012345, seeded in the SAP orders DynamoDB table), so the whole
    // blueprint tells one coherent customer story. The demo phone (a clearly-fake
    // fixed E.164) is also the static fallback lookup key the flow uses on
    // web-call / fresh-DID contacts that have no matching ANI.
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
            AccountNumber: '0000100042',
            PhoneNumber: DEMO_PROFILE_PHONE,
            EmailAddress: 'alice@example.com',
            PartyType: 'INDIVIDUAL',
            Attributes: {
              accountTier: 'Premium',
              recentOrderId: '0000012345',
              orderStatus: 'Invoiced',
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

    this.storageKeyArn = storageKey?.keyArn;

    this.customerProfilesDomainName = profilesDomainName;

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

    const attachmentsStorage = new connect.CfnInstanceStorageConfig(this, 'AttachmentsStorage', {
      instanceArn: instance.attrArn,
      resourceType: 'ATTACHMENTS',
      storageType: 'S3',
      s3Config: s3StorageConfig('attachments'),
    });
    attachmentsStorage.node.addDependency(storageBucket);

    const screenRecordingsStorage = new connect.CfnInstanceStorageConfig(this, 'ScreenRecordingsStorage', {
      instanceArn: instance.attrArn,
      resourceType: 'SCREEN_RECORDINGS',
      storageType: 'S3',
      s3Config: s3StorageConfig('screen-recordings'),
    });
    screenRecordingsStorage.node.addDependency(storageBucket);

    const emailMessagesStorage = new connect.CfnInstanceStorageConfig(this, 'EmailMessagesStorage', {
      instanceArn: instance.attrArn,
      resourceType: 'EMAIL_MESSAGES',
      storageType: 'S3',
      s3Config: s3StorageConfig('email-messages'),
    });
    emailMessagesStorage.node.addDependency(storageBucket);

    // NOTE: REAL_TIME_CONTACT_ANALYSIS_SEGMENTS, REAL_TIME_CONTACT_ANALYSIS_CHAT_SEGMENTS,
    // and REAL_TIME_CONTACT_ANALYSIS_VOICE_SEGMENTS do NOT support S3 as storageType —
    // they require KINESIS_STREAM or KINESIS_FIREHOSE. Omitted until Kinesis resources
    // are provisioned (see TODO Phase B — Kinesis-based storage configs).

    // --- Contact Events → EventBridge ---
    // Amazon Connect publishes contact lifecycle events to the default
    // EventBridge bus automatically — no instance storage config needed.
    // The ContactEvents stack's rules match them directly.

    new cdk.CfnOutput(this, 'InstanceArn', { value: this.instanceArn });
    new cdk.CfnOutput(this, 'InstanceId', { value: this.instanceId });
    new cdk.CfnOutput(this, 'InstanceAlias', { value: this.instanceAlias });
    new cdk.CfnOutput(this, 'ServiceRole', {
      value: instance.attrServiceRole,
      description: 'Connect service role ARN — used when configuring SAML trust in Identity Center',
    });
    new cdk.CfnOutput(this, 'CustomerProfilesDomainName', { value: this.customerProfilesDomainName });
    new cdk.CfnOutput(this, 'StorageBucketName', { value: this.storageBucketName });
    if (storageKey) {
      new cdk.CfnOutput(this, 'StorageKmsKeyArn', { value: storageKey.keyArn });
    }
    new cdk.CfnOutput(this, 'IdentityManagementType', { value: identityManagementType });

    // --- SAML federation resources (Identity Center) ---
    // When using SAML identity, create the IAM SAML Provider and Federation Role
    // needed for Identity Center SSO into Connect. These are the resources that
    // Identity Center's attribute mapping references (Role = <FederationRoleArn>,<SamlProviderArn>).
    if (config.identityCenterEnabled) {
      const instanceUuid = cdk.Fn.select(1, cdk.Fn.split('instance/', this.instanceArn));
      const relayState = `https://${this.region}.console.aws.amazon.com/connect/federate/${instanceUuid}`;

      // IAM SAML Provider — created from the Identity Center SAML metadata XML.
      // The metadata file must be downloaded from the Identity Center console
      // (IAM Identity Center → Applications → your app → IAM Identity Center metadata → Download)
      // and placed at `saml-metadata.xml` in the project root before deploying.
      const samlMetadataPath = require('path').resolve(__dirname, '..', 'saml-metadata.xml');
      if (!require('fs').existsSync(samlMetadataPath)) {
        throw new Error(
          'Identity Center is enabled but saml-metadata.xml is missing.\n' +
          'Download it from: IAM Identity Center → Applications → your Connect app → ' +
          'IAM Identity Center metadata → Download.\n' +
          'Save it in your WORKING directory (next to .connect-skill-order.json), NOT here — ' +
          'this project dir is generated output and re-renders would lose it. ' +
          'render-templates.sh / redeploy.sh copy it into the rendered project automatically.\n' +
          `(Expected rendered location: ${samlMetadataPath})`,
        );
      }

      const samlProvider = new iam.SamlProvider(this, 'IdentityCenterSamlProvider', {
        metadataDocument: iam.SamlMetadataDocument.fromFile(samlMetadataPath),
        name: `${this.prefix}-IdentityCenterSamlProvider`,
      });

      // IAM Federation Role — assumed via SAML console sign-in flow.
      // Identity Center sends a SAML assertion; AWS STS validates it against the
      // provider above and issues temporary credentials for this role.
      const samlFederationRole = new iam.Role(this, 'SamlFederationRole', {
        assumedBy: new iam.SamlConsolePrincipal(samlProvider),
        description: 'Role for SAML federation with Amazon Connect via IAM Identity Center',
      });

      // Grant the SAML role permission to get a federation token for Connect.
      // This is the permission that lets the federated user actually access the
      // Connect agent workspace after SAML authentication completes.
      // The resource uses a wildcard on the user segment because Connect resolves
      // the federated identity internally — the caller's ${aws:userid} (roleId:sessionName)
      // must match the resource pattern, and Connect requires the instance-level
      // wildcard to authorize the GetFederationToken call before the user is mapped.
      samlFederationRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['connect:GetFederationToken'],
        resources: [
          cdk.Fn.join('', [this.instanceArn, '/user/*']),
        ],
      }));

      // --- Outputs for SAML setup ---
      new cdk.CfnOutput(this, 'SamlRelayStateUrl', {
        value: relayState,
        description: 'Configure this as the Relay State in your IAM Identity Center Amazon Connect application',
      });

      new cdk.CfnOutput(this, 'SamlProviderArn', {
        value: samlProvider.samlProviderArn,
        description: 'SAML Provider ARN — use in Identity Center Role attribute mapping (second value in the comma pair)',
      });

      new cdk.CfnOutput(this, 'SamlFederationRoleArn', {
        value: samlFederationRole.roleArn,
        description: 'SAML Federation Role ARN — use in Identity Center Role attribute mapping (first value in the comma pair)',
      });
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

      // The DataLakeAccess construct emits a fixed-name CloudFormation export
      // 'DataLakeAccessErrors'. Export names must be unique per account/region,
      // so that fixed name collides when multiple project instances deploy into
      // the same account/region. Prefix it with the project name to keep each
      // deployment's export unique. (This export is informational and not
      // imported by any other stack, so renaming it is safe.)
      dataLake.node.findAll().forEach((child) => {
        if (child instanceof cdk.CfnOutput && child.exportName === 'DataLakeAccessErrors') {
          child.exportName = `${this.prefix}-DataLakeAccessErrors`;
        }
      });
    }
  }
}
