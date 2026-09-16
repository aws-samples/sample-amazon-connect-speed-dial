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
  /** When true, deploy the Customer Profiles domain, look the caller up in the flow, and surface their identity to the AI agent via Q Connect session data. */
  customerProfilesEnabled: boolean;
  /**
   * When true (default), data-bearing resources survive `cdk destroy`: the
   * Connect instance, storage/KB/schema/SAP buckets, the storage KMS key, and
   * the sap-orders DynamoDB table. Set false for disposable deployments
   * (e.g. E2E test runs) so `cdk destroy --all` removes everything, including
   * bucket contents (autoDeleteObjects).
   */
  retainData: boolean;
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

// Values are populated by `csp render` from the user's order.
// The .ts file has no placeholders so it stays valid TypeScript in the
// unrendered template — the render step overwrites `deployment-values.json`.
// The checked-in JSON has `prefix: ""` on purpose: `resolvePrefix()` throws
// on an empty prefix, so an unrendered template fails loudly at deploy time.
import deploymentValues from './deployment-values.json';

export const config: DeploymentConfig = {
  ...deploymentValues,
};

/** Max length of a Connect instance alias (also the strictest Connect name limit). */
const CONNECT_MAX = 45;

/**
 * Max length of an S3 `BucketNamePrefix` when `BucketNamespace: ACCOUNT_REGIONAL`.
 *
 * S3 appends a `--<accountId>--<region>--rs3` suffix and enforces a 63-char
 * total bucket-name limit, leaving 34 chars for the prefix (29-char suffix +
 * hyphen separator). Longer prefixes fail at CreateBucket with:
 *   "The full bucket name, including the account regional suffix, cannot exceed 63-characters."
 */
const S3_BUCKET_NAME_PREFIX_MAX = 34;

/**
 * Return the validated deployment prefix.
 *
 * Throws when the template is deployed unrendered (prefix is empty in the
 * checked-in `deployment-values.json`) — making the wrong thing fail loudly
 * instead of producing a garbage resource name.
 */
export function resolvePrefix(): string {
  const prefix = config.prefix;
  if (!prefix) {
    throw new Error(
      'config.prefix is not set. It must be rendered from the project name via ' +
      '"csp render" before deploying.',
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
   * S3 `BucketNamePrefix` for `BucketNamespace: ACCOUNT_REGIONAL`.
   *
   * S3 appends a 29-char `--<accountId>--<region>--rs3` suffix to reach the
   * 63-char total limit; the prefix itself must be ≤34 chars. When the
   * combined `${prefix}-${baseName}` overshoots, the project prefix is
   * truncated (never the baseName) so different resource kinds stay
   * distinguishable in the same account.
   */
  bucketPrefix(baseName: string): string {
    const combined = `${this.prefix}-${baseName}`.toLowerCase();
    if (combined.length <= S3_BUCKET_NAME_PREFIX_MAX) return combined;
    const room = Math.max(0, S3_BUCKET_NAME_PREFIX_MAX - baseName.length - 1);
    return `${this.prefix.toLowerCase().slice(0, room)}-${baseName.toLowerCase()}`
      .replace(/^-+|-+$/g, '');
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
