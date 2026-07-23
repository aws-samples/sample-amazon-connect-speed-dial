/**
 * Deployment configuration and centralized resource naming.
 *
 * The project prefix is the single source of truth for every resource name.
 * It is rendered into `config.prefix` from the project name the user supplies,
 * read once by the `BlueprintStack` base class, and applied through a single
 * `ResourceNamer` so naming is enforced deterministically and identically
 * across all stacks.
 *
 * Different AWS services have different naming constraints, handled by the
 * per-service sanitizers below:
 * - Connect (instance alias, queues, routing profiles): alphanumeric + hyphens, no consecutive hyphens, 1-45 chars
 * - Lex (bot names): alphanumeric + underscores, must start with a letter, 2-100 chars
 * - Wisdom (assistant, KB, agents, prompts): alphanumeric + hyphens + underscores, 1-255 chars
 */

export interface ConnectWidgetConfig {
  /** Widget ID from the Connect console (used as JWT sub claim and script tag id) */
  id: string;
  /** Base64-encoded snippet ID from the Connect widget embed code */
  snippetId: string;
  /** Full URL to the Connect widget JS file (from the embed script src) */
  scriptUrl: string;
  /** Human-readable label for the widget selector (e.g. 'Production', 'Test', 'Chat-only'). Defaults to the widget ID if not set. */
  label?: string;
}

export interface DeploymentConfig {
  /** Deployment prefix (project name) — single source of truth for all resource names. */
  prefix: string;
  /** When true, route the agent's Escalate outcome to a human-transfer queue. */
  transferEnabled: boolean;
  /** When true, provision the sample tool Lambda and associate it for in-flow tool calls. */
  toolEnabled: boolean;
  /** When true, invoke the session-context Lambda in the flow to inject caller context before the agent starts. */
  contextInjectionEnabled: boolean;
  /** When true, open the flow with a DTMF consent gate that records the call (Agent + Customer) on caller consent. */
  recordingEnabled: boolean;
  /** When true, create a customer-managed KMS key and encrypt the storage bucket + Connect storage configs (call recordings, chat transcripts, scheduled reports) with it. Defaults to true. */
  encryptionEnabled: boolean;
  /** When true, seed a demo Customer Profile and look the caller up in the flow, surfacing the profile to the AI agent via session data. Defaults to true. */
  customerProfilesEnabled: boolean;
  /**
   * When true (default), data-bearing resources survive `cdk destroy`: the
   * Connect instance, storage/KB/schema/SAP buckets, the storage KMS key, and
   * the sap-orders DynamoDB table. Set false for disposable deployments
   * (e.g. E2E test runs) so `cdk destroy --all` removes everything, including
   * bucket contents (autoDeleteObjects).
   */
  retainData: boolean;
  /** Base name for the Connect data-storage S3 bucket. Combined with the project prefix and AWS account ID to form the full bucket name: `${prefix}-${storageBucketBaseName}-${accountId}` — the prefix keeps the (globally-unique) bucket name distinct across deployments in the same account. */
  storageBucketBaseName: string;
  /**
   * When true, deploy the sample web-call agent frontend (CloudFront + Cognito +
   * API Gateway + token Lambda). The stack deploys whenever this is true; widget
   * entries in `connectWidgets` are added in the Connect console after the
   * instance exists and are required only for the frontend to place calls.
   * When false, the frontend stack is never deployed.
   */
  frontendEnabled: boolean;
  /** When true, enables the Connect analytics data lake (contact records, flow events, agent stats). */
  dataLakeEnabled: boolean;
  /** When true, enables Contact Events streaming to EventBridge and deploys the ContactEvents stack (EventBridge rules + Lambda for contact lifecycle events). */
  contactEventsEnabled: boolean;
  /** When true, create a Bedrock Managed Knowledge Base with S3 data source and associate it with the Q in Connect assistant. */
  knowledgeBaseEnabled: boolean;
  /**
   * When true, the Connect instance is created with SAML identity management,
   * enabling SSO via IAM Identity Center. When false, the instance uses
   * CONNECT_MANAGED identity (built-in user management). This cannot be changed
   * after instance creation.
   */
  identityCenterEnabled: boolean;
  /** Human-readable language the agent and flow speak ("German" | "English"), rendered from the order's language. Drives localized flow strings. */
  promptLanguage: string;

  // --- Connect Widget Frontend config ---
  // Fill in after creating widget(s) in the Connect console.
  // Widget entries are required for the frontend to place calls.
  // Each widget gets its own Secrets Manager secret for the signing key.

  /** Array of Connect widget configurations. */
  connectWidgets: ConnectWidgetConfig[];
}

/**
 * Deployment configuration — rendered from the project name at scaffold time.
 *
 * `prefix`, `transferEnabled`, and `toolEnabled` are substituted by the render
 * step. The prefix has
 * no hardcoded fallback on purpose: `resolvePrefix()` throws if the template is
 * deployed unrendered, so a stale placeholder can never silently become a real
 * resource name.
 */
export const config: DeploymentConfig = {
  prefix: '{{projectName}}',
  transferEnabled: {{transferEnabled}},
  toolEnabled: {{toolEnabled}},
  contextInjectionEnabled: {{contextInjectionEnabled}},
  recordingEnabled: {{recordingEnabled}},
  encryptionEnabled: {{encryptionEnabled}},
  customerProfilesEnabled: {{customerProfilesEnabled}},
  retainData: {{retainData}},
  storageBucketBaseName: 'connect-storage',
  frontendEnabled: {{frontendEnabled}},
  dataLakeEnabled: {{dataLakeEnabled}},
  contactEventsEnabled: {{contactEventsEnabled}},
  knowledgeBaseEnabled: {{knowledgeBaseEnabled}},
  identityCenterEnabled: {{identityCenterEnabled}},
  promptLanguage: '{{promptLanguage}}',

  // Connect Widget Frontend — add entries after creating widget(s) in Connect console
  // Example:
  // connectWidgets: [
  //   { id: 'widget-uuid', snippetId: 'base64...', scriptUrl: 'https://...my.connect.aws/...' },
  // ],
  connectWidgets: [],
};

/** Max length of a Connect instance alias (also the strictest Connect name limit). */
const CONNECT_MAX = 45;

/**
 * Return the validated deployment prefix.
 *
 * Throws if the template was deployed without being rendered (the placeholder
 * `{{...}}` survives) or if the prefix is empty — making the wrong thing fail
 * loudly instead of producing a garbage resource name.
 */
export function resolvePrefix(): string {
  const prefix = config.prefix;
  if (!prefix || prefix.includes('{{')) {
    throw new Error(
      'config.prefix is not set. It must be rendered from the project name via ' +
      'scripts/render-templates.sh before deploying.',
    );
  }
  return prefix;
}

/**
 * Sanitize for Connect resources (instance alias, queue name, routing profile, HoO, contact flow).
 * Allowed: lowercase alphanumeric + single hyphens, no leading/trailing hyphens. Max 45 chars.
 */
export function sanitizeForConnect(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')   // replace disallowed chars with hyphen
    .replace(/-{2,}/g, '-')         // collapse consecutive hyphens
    .replace(/^-+|-+$/g, '')        // trim leading/trailing hyphens
    .slice(0, CONNECT_MAX);
}

/**
 * Sanitize for Lex resources (bot names, alias names).
 * Allowed: alphanumeric + underscores, must start with a letter. Max 100 chars.
 */
export function sanitizeForLex(value: string): string {
  let sanitized = value
    .replace(/[^A-Za-z0-9_]/g, '_') // replace disallowed chars with underscore
    .replace(/_{2,}/g, '_')         // collapse consecutive underscores
    .replace(/^_+|_+$/g, '');       // trim leading/trailing underscores

  // Must start with a letter
  if (sanitized.length > 0 && !/^[A-Za-z]/.test(sanitized)) {
    sanitized = 'L' + sanitized;
  }

  return sanitized.slice(0, 100);
}

/**
 * Sanitize for Wisdom resources (assistant, KB, agents, prompts).
 * Allowed: alphanumeric + hyphens + underscores. Max 255 chars.
 */
export function sanitizeForWisdom(value: string): string {
  return value
    .replace(/[^A-Za-z0-9\-_]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255);
}

/**
 * Centralized resource namer.
 *
 * Built once per stack from the project prefix (and account ID) by
 * `BlueprintStack`. Every physical resource name in the blueprint flows through
 * one of its methods, so the prefix is applied identically everywhere and the
 * per-service naming rules live in exactly one place.
 */
export class ResourceNamer {
  constructor(
    private readonly prefix: string,
    private readonly accountId: string,
  ) {}

  /** Connect resources: queues, routing profiles, hours-of-operation, contact flow. */
  connect(baseName: string): string {
    return sanitizeForConnect(`${this.prefix}-${baseName}`);
  }

  /** Lex bot and alias names. */
  lex(baseName: string): string {
    return sanitizeForLex(`${this.prefix}-${baseName}`);
  }

  /** Wisdom assistant, knowledge base, AI agents and prompts. */
  wisdom(baseName: string): string {
    return sanitizeForWisdom(`${this.prefix}-${baseName}`);
  }

  /**
   * Connect instance alias.
   *
   * The alias becomes a public DNS hostname (`<alias>.my.connect.aws`) that must
   * be unique across ALL AWS accounts, not just this one. The account ID is
   * folded in to guarantee global uniqueness, and is preserved intact if the
   * combined string would exceed the 45-char limit (the prefix is truncated,
   * never the account ID).
   */
  instanceAlias(): string {
    const suffix = this.accountId;
    const room = Math.max(0, CONNECT_MAX - suffix.length - 1);
    const head = sanitizeForConnect(this.prefix).slice(0, room);
    return sanitizeForConnect(`${head}-${suffix}`);
  }
}
