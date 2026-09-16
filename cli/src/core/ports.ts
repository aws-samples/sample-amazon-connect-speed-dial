// Abstractions the commands depend on, named for the ROLE they play rather than
// for the AWS API behind them. Implementations live in cli/src/adapters/.
//
// Two rules keep this file honest:
//   1. Types only — no implementations, no `@aws-sdk/*` imports. Importing this
//      module must stay free, so `csp --help` never loads an SDK.
//   2. No sentinel values. A port either returns the real answer or throws.
//      Deciding that a failure is "a failed check" rather than fatal is the
//      COMMAND's job, not the adapter's.

export interface Identity {
  /** The account this run is using. Throws when it cannot be resolved. */
  accountId(): Promise<string>
  /** Same, but null instead of throwing — preflight reports it as a check result. */
  accountIdOrNull(): Promise<string | null>
}

export interface InstanceDescription {
  status: string
  identityManagementType: string
}

export interface ConnectInstances {
  describe(instanceId: string): Promise<InstanceDescription>
  findIdByAlias(alias: string): Promise<string | null>
  delete(instanceId: string): Promise<void>
}

export interface SecurityProfiles {
  findIdByName(instanceId: string, name: string): Promise<string | null>
  /** Detach a security profile from an AI_AGENT entity. Throws when not attached. */
  disassociateAiAgent(instanceId: string, entityArn: string, securityProfileId: string): Promise<void>
}

export interface ContactFlows {
  status(instanceId: string, flowId: string): Promise<string>
}

export interface AiAgents {
  status(assistantId: string, agentId: string): Promise<string>
  findAssistantIdByName(name: string): Promise<string | null>
  findAgentIdByName(assistantId: string, name: string): Promise<string | null>
  versionNumbers(assistantId: string, aiAgentId: string): Promise<number[]>
}

export interface ClaimedNumber {
  phoneNumber: string
  phoneNumberId: string
}

/** A registry of telephone numbers that can be searched, claimed and routed.
 *  Country code and number type are the CALLER's policy, passed as arguments. */
export interface PhoneNumbers {
  listClaimed(instanceId: string, countryCode: string): Promise<ClaimedNumber[]>
  /** Unclaimed numbers this instance may take. */
  searchAvailable(instanceArn: string, countryCode: string, numberType: string,
                  limit: number): Promise<string[]>
  /** Claim one number → its id, or null when the claim did not take. */
  claim(instanceArn: string, phoneNumber: string): Promise<string | null>
  /** Route inbound calls on a claimed number to a contact flow. */
  routeToFlow(phoneNumberId: string, instanceId: string, flowId: string): Promise<void>
}

export interface EventRules {
  state(ruleName: string): Promise<string>
}

export interface IngestionState {
  status: string
  failureReasons?: string[]
  statistics?: Record<string, number>
}

export interface KnowledgeBases {
  status(knowledgeBaseId: string): Promise<string>
  /** Begin ingesting the data source → the job id. */
  startIngestion(knowledgeBaseId: string, dataSourceId: string): Promise<string>
  getIngestion(knowledgeBaseId: string, dataSourceId: string, jobId: string): Promise<IngestionState>
}

export interface StoredObject { key: string; versionId?: string }

export interface ObjectStore {
  upload(localPath: string, bucket: string, key: string): Promise<void>
  listBuckets(): Promise<string[]>
  /** Object versions first, then delete markers. */
  listVersions(bucket: string): Promise<StoredObject[]>
  /** A batch of at most 1000. Throws when the response reports per-object errors. */
  deleteObjects(bucket: string, objects: StoredObject[]): Promise<void>
  deleteBucket(bucket: string): Promise<void>
}

export interface Tables {
  delete(name: string): Promise<void>
}

export interface Keys {
  scheduleDeletion(keyArn: string, pendingDays: number): Promise<void>
}

export interface Applications {
  findArnsByName(name: string): Promise<string[]>
  delete(arn: string): Promise<void>
}

export interface PoolUser {
  exists: boolean
  status?: string
  sub?: string
}

export interface UserPool {
  /** Must NOT throw for a missing user (exists: false); other errors may throw. */
  getUser(poolId: string, username: string): Promise<PoolUser>
  /** Creates with email + email_verified and EMAIL delivery, and NO temporary
   *  password — Cognito generates one and emails it, so it never reaches stdout.
   *  resend=true re-invites a still-pending user with a fresh password. */
  createUser(poolId: string, username: string, email: string, resend: boolean): Promise<void>
}

export interface ProfileRecord {
  accountNumber: string
  firstName: string
  lastName: string
  phone: string
  email: string
  attributes: Record<string, string>
}

export interface Profiles {
  findId(domain: string, keyName: string, value: string): Promise<string | null>
  create(domain: string, profile: ProfileRecord): Promise<string>
  update(domain: string, profileId: string, profile: ProfileRecord): Promise<void>
}

/** Asking the operator something on stdin. Injected so tests never block. */
export interface Prompt {
  ask(question: string): Promise<string>
}

/** Waiting, injected so tests never actually wait. */
export interface Clock {
  sleep(ms: number): Promise<void>
}

export interface StackSummary { name: string; status: string }

export interface Stacks {
  /** True when the stack exists. "Absent" is a real answer, so it returns false;
   *  any other failure (no permission, network) throws. */
  exists(stackName: string): Promise<boolean>
  /** Every stack, any status, whose name starts with `prefix`. */
  list(prefix: string): Promise<StackSummary[]>
  /** Logical ids currently in DELETE_FAILED. */
  deleteFailedResourceIds(stackName: string): Promise<string[]>
  /** DeleteStack, retaining the given logical resources when the list is non-empty. */
  delete(stackName: string, retainResources: string[]): Promise<void>
  /** Block until the delete finishes; throw on failure or timeout. */
  waitDeleted(stackName: string): Promise<void>
  /** One output value, or null when the stack or the key is absent. */
  output(stackName: string, outputKey: string): Promise<string | null>
}

export interface Models {
  /** False only when the account genuinely lacks access to the model. A
   *  throttle or credential failure throws — it is not the same finding. */
  accessible(modelId: string): Promise<boolean>
}

export interface SsoInstances {
  /** Whether an IAM Identity Center instance is visible from this account. */
  visible(): Promise<boolean>
}

/** A subprocess runner. Injected so tests never spawn. */
export interface Shell {
  /** Inherits stdio; throws CliError on a non-zero exit. */
  run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }): void
  /** Captures stdout; never throws — the exit status is the answer. */
  runQuiet(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }):
    { status: number; stdout: string }
}

/** The CDK CLI as this project drives it. Region is bound by the adapter. */
export interface Toolchain {
  cdkAvailable(): Promise<boolean>
  bootstrap(account: string): Promise<void>
  /** Deploy exactly one stack — nothing it depends on. Throws on failure. */
  deployStackExclusively(projectDir: string, stackName: string): void
  /** cdk destroy --all --force. Throws on failure. */
  destroyAll(projectDir: string): void
}

export interface Secrets {
  put(name: string, value: string): Promise<void>
}
