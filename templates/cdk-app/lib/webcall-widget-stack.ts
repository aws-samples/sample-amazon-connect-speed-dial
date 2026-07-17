import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';
import { BlueprintStack } from './blueprint-stack';
import { config, ConnectWidgetConfig } from './config';

export interface WebcallWidgetStackProps extends cdk.StackProps {
  /** When true, S3 buckets are emptied and deleted on stack teardown. */
  autoDeleteBuckets: boolean;
}

/**
 * Sample web-call agent frontend: CloudFront + Cognito + API Gateway + token Lambda.
 *
 * Hosts a static SPA behind CloudFront, authenticates users via a Cognito User Pool,
 * and exposes a /api/token endpoint that generates signed JWTs for Connect widget
 * authentication. One Secrets Manager secret per widget stores the signing key.
 */
export class WebcallWidgetStack extends BlueprintStack {
  constructor(scope: Construct, id: string, props: WebcallWidgetStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'Web-call agent frontend with CloudFront, Cognito auth, and API Gateway';

    // Only fully-configured widgets
    const widgets = config.connectWidgets.filter(
      (w) => w.id.trim() !== '' && w.snippetId.trim() !== '' && w.scriptUrl.trim() !== '',
    );

    // =========================================================================
    // S3 Bucket for static website hosting
    // =========================================================================
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketNamePrefix: this.namer.connect('webcall-site'),
      bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: props.autoDeleteBuckets ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.autoDeleteBuckets,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
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
    websiteBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'RestrictSSECObjectUploads',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [websiteBucket.arnForObjects('*')],
      conditions: {
        Null: { 's3:x-amz-server-side-encryption-customer-algorithm': 'false' },
      },
    }));

    // =========================================================================
    // CloudFront Distribution
    // =========================================================================
    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'OAI', {
      comment: `OAI for ${this.prefix} webcall widget`,
    });
    websiteBucket.grantRead(originAccessIdentity);

    const s3Origin = origins.S3BucketOrigin.withOriginAccessIdentity(websiteBucket, {
      originAccessIdentity,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    // =========================================================================
    // Cognito User Pool
    // =========================================================================
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: this.namer.connect('webcall-users'),
      selfSignUpEnabled: false,
      signInAliases: {
        username: true,
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
    });

    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: this.namer.connect('webcall-client'),
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
      preventUserExistenceErrors: true,
    });

    // =========================================================================
    // Secrets Manager — one secret per widget for its signing key
    // =========================================================================
    // The secret is created with a placeholder value (Secrets Manager rejects an
    // empty SecretString), then the real signing key is written after deploy via
    // `aws secretsmanager put-secret-value` (see scripts/setup-widget.sh). The
    // token Lambda treats the placeholder as "not yet configured".
    // Mapping: widgetId -> secretArn (passed to Lambda as JSON env var)
    const widgetSecretMap: Record<string, string> = {};

    for (const widget of widgets) {
      const secret = new secretsmanager.Secret(this, `WidgetSecret-${widget.id}`, {
        secretName: `${this.prefix}-widget-secret-${widget.id}`,
        description:
          `Connect widget signing key for widget ${widget.id}. ` +
          'Set via scripts/setup-widget.sh (put-secret-value) after deploying.',
        secretStringValue: cdk.SecretValue.unsafePlainText('PLACEHOLDER_SET_VIA_SETUP_WIDGET'),
      });
      widgetSecretMap[widget.id] = secret.secretArn;
    }

    // =========================================================================
    // Token Lambda — reads the correct secret based on widgetId param
    // =========================================================================
    const connectTokenFn = new NodejsFunction(this, 'ConnectTokenHandler', {
      entry: path.join(__dirname, '..', 'lambda', 'widget', 'connect-token', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      description: 'Generate JWT tokens for Amazon Connect widget authentication',
      environment: {
        WIDGET_SECRET_MAP: JSON.stringify(widgetSecretMap),
      },
      bundling: {
        minify: true,
        sourceMap: false,
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Grant read access to all widget secrets
    for (const widget of widgets) {
      const secret = secretsmanager.Secret.fromSecretCompleteArn(
        this, `SecretRef-${widget.id}`, widgetSecretMap[widget.id],
      );
      secret.grantRead(connectTokenFn);
    }

    // =========================================================================
    // API Gateway with Cognito authorizer
    // =========================================================================
    const api = new apigateway.RestApi(this, 'WebcallApi', {
      restApiName: `${this.prefix}-webcall-api`,
      description: 'API for Connect webcall widget token generation',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
      // No CORS preflight here: the widget is served from the same CloudFront
      // distribution that fronts this API (the /api/* behavior), so the browser
      // calls it same-origin and never issues a CORS preflight. We deliberately
      // avoid apigateway.Cors.ALL_ORIGINS (which would let any site call the
      // API). The token Lambda additionally returns Access-Control-Allow-Origin
      // only for the CloudFront origin (see the connect-token handler).
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      authorizerName: 'CognitoAuthorizer',
      cognitoUserPools: [userPool],
      identitySource: 'method.request.header.Authorization',
    });
    authorizer._attachToApi(api);

    // GET /api/token?widgetId=<id>
    const apiResource = api.root.addResource('api');
    const tokenResource = apiResource.addResource('token');
    tokenResource.addMethod('GET', new apigateway.LambdaIntegration(connectTokenFn), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Add API Gateway as additional CloudFront behavior
    const apiOrigin = new origins.RestApiOrigin(api);
    distribution.addBehavior('/api/*', apiOrigin, {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    });

    // =========================================================================
    // Deploy website assets + generated config.js to S3
    // =========================================================================
    // Both the static site and the generated config.js are deployed in a SINGLE
    // BucketDeployment. BucketDeployment defaults to prune: true, which deletes
    // any object in the destination not present in its own source set — so two
    // separate deployments to the same bucket fight each other (a targeted update
    // that re-runs only one of them wipes the other's files). Merging the sources
    // into one deployment means one prune pass over the union, never a conflict.
    const widgetsJson = JSON.stringify(
      widgets.map((w) => ({ id: w.id, snippetId: w.snippetId, scriptUrl: w.scriptUrl, label: w.label || w.id })),
      null, 2,
    );

    const configJsContent = [
      '// Auto-generated by CDK — do not edit manually',
      'window.cognitoConfig = {',
      `  userPoolId: '${userPool.userPoolId}',`,
      `  clientId: '${userPoolClient.userPoolClientId}',`,
      `  region: '${this.region}',`,
      `  apiEndpoint: '/api',`,
      `  widgets: ${widgetsJson}`,
      '};',
      '',
    ].join('\n');

    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '../website')),
        s3deploy.Source.data('config.js', configJsContent),
      ],
      destinationBucket: websiteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront Distribution URL',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'API Gateway endpoint URL',
    });

    for (const widget of widgets) {
      new cdk.CfnOutput(this, `SecretArn-${widget.id}`, {
        value: widgetSecretMap[widget.id],
        description: `Secrets Manager ARN for widget ${widget.id} — paste the signing key here`,
      });
    }
  }
}
