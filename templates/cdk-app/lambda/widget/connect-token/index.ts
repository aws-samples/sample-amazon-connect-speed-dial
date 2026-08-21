import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import * as jwt from 'jsonwebtoken';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const secretsClient = new SecretsManagerClient({});

// Cache secrets by widget ID to avoid repeated Secrets Manager calls
const secretCache: Record<string, string> = {};

// Parse the widget-to-secret-ARN mapping from environment
const widgetSecretMap: Record<string, string> = JSON.parse(
  process.env.WIDGET_SECRET_MAP || '{}',
);

async function getSecretKey(widgetId: string): Promise<string> {
  if (secretCache[widgetId]) return secretCache[widgetId];

  const secretArn = widgetSecretMap[widgetId];
  if (!secretArn) {
    throw new Error(`No secret configured for widget ${widgetId}`);
  }

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  if (!response.SecretString || response.SecretString === 'PLACEHOLDER_SET_VIA_SETUP_WIDGET') {
    throw new Error(
      `Secret for widget ${widgetId} is not configured. Run "csp setup-widget" to store the Connect widget security key.`,
    );
  }

  secretCache[widgetId] = response.SecretString;
  return secretCache[widgetId];
}

// Build CORS headers that echo the request Origin only when it is the app's own
// CloudFront origin (or an explicitly allowed ALLOWED_ORIGIN), instead of '*'.
// The widget is served same-origin from CloudFront, so this is a defensive
// restriction rather than a functional requirement.
function corsHeaders(event: APIGatewayProxyEvent): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const origin = event.headers?.origin ?? event.headers?.Origin;
  const allowed = process.env.ALLOWED_ORIGIN;
  if (origin && (origin === allowed || /^https:\/\/[a-z0-9-]+\.cloudfront\.net$/i.test(origin))) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The widgetId is passed as a query string parameter
  const widgetId = event.queryStringParameters?.widgetId;

  if (!widgetId) {
    return {
      statusCode: 400,
      headers: corsHeaders(event),
      body: JSON.stringify({ error: 'Missing required query parameter: widgetId' }),
    };
  }

  if (!widgetSecretMap[widgetId]) {
    return {
      statusCode: 400,
      headers: corsHeaders(event),
      body: JSON.stringify({ error: `Unknown widget: ${widgetId}` }),
    };
  }

  try {
    const secretKey = await getSecretKey(widgetId);

    // Extract user information from Cognito claims
    const claims = event.requestContext.authorizer?.claims ?? {};
    const username = claims['cognito:username'] ?? '';
    const email = claims['email'] ?? '';
    const customerId = claims['sub'] ?? '';

    // Timestamps
    const now = Math.floor(Date.now() / 1000);
    const expiration = now + 600; // 10 minutes max per AWS requirements

    // JWT payload
    const payload = {
      sub: widgetId,
      iat: now,
      exp: expiration,
      attributes: {
        name: username,
        email,
        customerId,
      },
    };

    const token = jwt.sign(payload, secretKey, {
      algorithm: 'HS256',
      header: { typ: 'JWT', alg: 'HS256' },
    });

    return {
      statusCode: 200,
      headers: corsHeaders(event),
      body: JSON.stringify({ token }),
    };
  } catch {
    // Never log the error detail: it can carry the Secrets Manager signing
    // key or Cognito claims (email, customerId). Log a static string only.
    console.error('Error generating Connect token');
    return {
      statusCode: 500,
      headers: corsHeaders(event),
      body: JSON.stringify({ error: 'Failed to generate token' }),
    };
  }
};
