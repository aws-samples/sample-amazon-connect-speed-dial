import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CliError } from '../lib/errors.js'
import type {
  AiAgents, Applications, ConnectInstances, Identity, Keys, ObjectStore, Prompt,
  SecurityProfiles, Stacks, Tables, Toolchain,
} from '../core/ports.js'
import { readJsonObject } from '../lib/ui.js'
import { readCdkOutputs } from './cdkDeploy.js'
import {SKILL_ROOT} from './shared.js'
import { ok, info, warn, RED, NC } from '../lib/ui.js'
import type { CdkOutputs } from './cdkDeploy.js'

// Full cleanup of a blueprint deployment.
//
// `cdk destroy --all` alone is NOT enough:
//   1. DELETE_FAILED on the ai-agent security profile: publishing the
//      orchestration agent (console or automation) associates the profile with
//      the agent's numbered version ARNs — associations CloudFormation doesn't
//      know about. They must be disassociated BEFORE destroy.
//   2. Retained-by-design resources survive destroy when retainData=true (the
//      default): the Connect instance, storage/KB/schema/SAP buckets, the
//      storage KMS key, and the sap-orders DynamoDB table. This module sweeps
//      them afterwards.
//
// It also unblocks the "Instance alias is already used" error on redeploy: a
// failed first deploy leaves the retained instance behind, and its globally-
// unique alias blocks a fresh deploy until the instance is deleted.
//
// DESTRUCTIVE. Retained resources may hold call recordings, transcripts,
// knowledge-base documents, and customer data you are legally required to keep
// (see README "Full delete"). Requires an interactive typed confirmation; set
// FORCE_TEARDOWN=1 to skip it in automation.
//
// Deliberately NOT fail-fast: teardown is a best-effort
// sweep; every step tolerates already-deleted resources and CONTINUES, so a
// partial teardown is safely re-runnable.

export interface TeardownPorts {
  identity: Pick<Identity, 'accountId'>
  prompt: Prompt
  toolchain: Pick<Toolchain, 'destroyAll'>
  instances: Pick<ConnectInstances, 'findIdByAlias' | 'delete'>
  securityProfiles: SecurityProfiles
  agents: Pick<AiAgents, 'findAssistantIdByName' | 'findAgentIdByName' | 'versionNumbers'>
  stacks: Pick<Stacks, 'exists' | 'list' | 'deleteFailedResourceIds' | 'delete' | 'waitDeleted'>
  storage: Pick<ObjectStore, 'listBuckets' | 'listVersions' | 'deleteObjects' | 'deleteBucket'>
  tables: Tables
  keys: Keys
  applications: Applications
}

/** The bucket baseNames the blueprint creates, one per calling stack
 *  (templates/cdk-app/lib/*.ts, all via ConfigNamer.bucketPrefix). */
const BUCKET_BASE_NAMES = [
  'connect-storage', 'kb-docs', 'gateway-schemas', 'sap-documents', 'webcall-site',
] as const

/** Mirrors S3_BUCKET_NAME_PREFIX_MAX in templates/cdk-app/lib/config.ts. */
const BUCKET_NAME_PREFIX_MAX = 34

/** Port of ConfigNamer.bucketPrefix: `<project>-<baseName>`, lowercased, with the
 *  PROJECT truncated (never the baseName) when the pair exceeds the 34-char cap
 *  that leaves room for the `-<account>-<region>-<suffix>` S3 appends. */
export function bucketPrefixFor(project: string, baseName: string): string {
  const combined = `${project}-${baseName}`.toLowerCase()
  if (combined.length <= BUCKET_NAME_PREFIX_MAX) return combined
  const room = Math.max(0, BUCKET_NAME_PREFIX_MAX - baseName.length - 1)
  return `${project.toLowerCase().slice(0, room)}-${baseName.toLowerCase()}`
    .replace(/^-+|-+$/g, '')
}

/** The buckets this project owns, matched on the exact generated
 *  `<prefix>-<baseName>` names. Exported for the tests.
 *
 *  This used to be `name.startsWith(`${project}-`)`, which was wrong in both
 *  directions: it matched SIBLING projects whose name extends this one (tearing
 *  down 'demo' purged every version in 'demo-test-connect-storage-…' — call
 *  recordings, transcripts and knowledge-base documents from a deployment the
 *  user never named and was never asked to confirm), and it MISSED this
 *  project's own buckets whenever the 34-char cap truncated the prefix. */
export function ownedBuckets(project: string, all: string[]): string[] {
  const prefixes = BUCKET_BASE_NAMES.map((base) => bucketPrefixFor(project, base))
  return all.filter((name) => prefixes.some((p) => name === p || name.startsWith(`${p}-`)))
}

/** Resolve the rendered project dir: accept either a project name (→ csp-<name>,
 *  relative to the cwd then the repo root) or an explicit directory path.
 *  Exported for the tests. */
export function resolveTeardownProjectDir(arg: string, skillRoot: string = SKILL_ROOT): string {
  const hasValues = (dir: string): boolean => existsSync(join(dir, '.connect-skill-values.json'))
  let isDir = false
  try { isDir = statSync(arg).isDirectory() } catch { isDir = false }
  if (isDir && hasValues(arg)) return resolve(arg)
  if (hasValues(join(process.cwd(), `csp-${arg}`))) return join(process.cwd(), `csp-${arg}`)
  if (hasValues(join(skillRoot, `csp-${arg}`))) return join(skillRoot, `csp-${arg}`)
  throw new CliError(
    `could not find a rendered project for '${arg}'\n` +
    `  expected a values file at <project-dir>/.connect-skill-values.json or ./csp-${arg}/`)
}

export async function teardown(
  arg: string,
  region: string,
  aws: TeardownPorts,
  /** Test seam: repo root for csp-<name> resolution. */
  skillRoot: string = SKILL_ROOT,
): Promise<void> {
  const projectDir = resolveTeardownProjectDir(arg, skillRoot)

  const valuesPath = join(projectDir, '.connect-skill-values.json')
  const values = readJsonObject(valuesPath, 'values file')
  const prefix = typeof values.projectName === 'string' ? values.projectName : ''
  // An empty prefix must never reach the confirmation gate: a bare Enter at the
  // prompt would match '' and green-light a sweep over unprefixed resources.
  if (!prefix) throw new CliError(`values file has no projectName: ${valuesPath}`)


  const account = await aws.identity.accountId()

  // --- confirmation guard ------------------------------------------------------
  console.log(`${RED}This will PERMANENTLY DELETE the '${prefix}' deployment in ${account} (${region}),${NC}`)
  console.log(`${RED}including retained data: Connect instance, storage/KB/schema/SAP buckets,${NC}`)
  console.log(`${RED}the storage KMS key, and the sap-orders table.${NC}`)
  if (process.env.FORCE_TEARDOWN !== '1') {
    // Trim: a pasted project name often carries a trailing space or newline,
    // and aborting an authorized teardown over invisible whitespace just gets
    // the whole destructive command re-run.
    const confirm = (await aws.prompt.ask(`Type the project name ('${prefix}') to confirm: `)).trim()
    if (confirm !== prefix) {
      // A user abort is not an error banner: print a plain line and set
      // process.exitCode instead of throwing a CliError, which main.ts
      // would decorate with a red ✗.
      console.log(`aborted — input did not match '${prefix}'`)
      process.exitCode = 1
      return
    }
  }

  // --- capture ids from outputs (best effort; outputs may predate destroy) ----
  let instanceId = ''
  let assistant = ''
  let agent = ''
  let kmsArn = ''
  const outputsPath = join(projectDir, 'cdk-outputs.json')
  if (existsSync(outputsPath)) {
    try {
      const outputs = readCdkOutputs(outputsPath)
      const bySuffix = (suffix: string, key: string): string => {
        for (const [name, vals] of Object.entries(outputs)) {
          if (name.endsWith(suffix) && vals?.[key]) return vals[key]
        }
        return ''
      }
      const instanceArn = bySuffix('-ConnectInstance', 'InstanceArn')
      instanceId = instanceArn.slice(instanceArn.lastIndexOf('/') + 1) // ${INSTANCE_ID##*/}
      assistant = bySuffix('-Wisdom', 'AssistantId')
      agent = bySuffix('-Wisdom', 'OrchestrationAgentId')
      kmsArn = bySuffix('-ConnectInstance', 'StorageKmsKeyArn')
    } catch { /* unreadable outputs file ⇒ no captured ids, sweep by name instead */ }
  }
  // fall back to lookup by alias
  if (!instanceId) {
    try { instanceId = (await aws.instances.findIdByAlias(`${prefix}-${account}`)) ?? '' } catch { instanceId = '' }
  }
  // API fallback for assistant/agent (the widget --exclusively deploy overwrites
  // cdk-outputs.json, dropping the Wisdom keys — without these the pre-clean
  // silently skips and cdk destroy hits DELETE_FAILED on the security profile)
  if (!assistant) {
    try { assistant = (await aws.agents.findAssistantIdByName(`${prefix}-assistant`)) ?? '' } catch { assistant = '' }
  }
  if (!agent && assistant) {
    try { agent = (await aws.agents.findAgentIdByName(assistant, `${prefix}-orchestrator`)) ?? '' } catch { agent = '' }
  }

  // --- 1. pre-clean: disassociate publish-created security-profile bindings ---
  if (instanceId && assistant && agent) {
    info('pre-clean: disassociating ai-agent security-profile bindings')
    let sp: string | null = null
    try { sp = await aws.securityProfiles.findIdByName(instanceId, `${prefix}-ai-agent`) } catch { sp = null }
    if (sp) {
      const base = `arn:aws:wisdom:${region}:${account}:ai-agent/${assistant}/${agent}`
      let versions: number[] = []
      try { versions = await aws.agents.versionNumbers(assistant, agent) } catch { versions = [] }
      // ONLY the base ARN + numbered versions (created outside CloudFormation by
      // the console/browser publish). $SAVED/$LATEST belong to the CDK custom
      // resource — removing them here makes its onDelete fail on templates
      // released before the InvalidParameterException ignore-guard fix.
      for (const suffix of ['', ...versions.map(String)]) {
        const arn = suffix ? `${base}:${suffix}` : base
        try {
          await aws.securityProfiles.disassociateAiAgent(instanceId, arn, sp)
          info(`  disassociated ${arn.slice(arn.lastIndexOf('/') + 1)}`) // ${ARN##*/}
        } catch { /* not associated / already gone — best effort */ }
      }
      ok('security-profile bindings cleared')
    }
  }

  // --- 2. cdk destroy ----------------------------------------------------------
  let haveConnectStack = false
  try { haveConnectStack = await aws.stacks.exists(`${prefix}-ConnectInstance`) } catch { haveConnectStack = false }
  if (haveConnectStack) {
    info(`cdk destroy --all (${prefix})`)
    try {
      aws.toolchain.destroyAll(projectDir)
    } catch {
      warn('cdk destroy reported errors — sweeping anyway')
    }
  } else {
    info('stacks already gone — proceeding to sweep')
  }

  // --- 2b. recover stacks stuck in DELETE_FAILED --------------------------------
  // Custom resources (e.g. the security-profile disassociate on templates released
  // before the ignore-guard fix) can wedge a stack. Retry the delete while
  // retaining the failed logical resources — they hold no real infrastructure.
  let failedStacks: string[] = []
  try {
    failedStacks = (await aws.stacks.list(`${prefix}-`))
      .filter((s) => s.status === 'DELETE_FAILED').map((s) => s.name)
  } catch { failedStacks = [] }
  for (const stack of failedStacks) {
    let failedRes: string[] = []
    try { failedRes = await aws.stacks.deleteFailedResourceIds(stack) } catch { failedRes = [] }
    warn(`retrying delete of ${stack} (retaining stuck: ${failedRes.join(' ')})`)
    try { await aws.stacks.delete(stack, failedRes) } catch { /* best effort */ }
    try {
      await aws.stacks.waitDeleted(stack)
      ok(`${stack} deleted`)
    } catch {
      warn(`${stack} still not deleted`)
    }
  }

  // --- 3. sweep retained resources --------------------------------------------
  info('sweep: Connect instance')
  if (instanceId) {
    try {
      await aws.instances.delete(instanceId)
      ok(`instance ${instanceId} deletion requested`)
    } catch {
      info('  instance already gone or not deletable yet')
    }
  }

  info(`sweep: S3 buckets (${prefix}-{${BUCKET_BASE_NAMES.join(',')}})`)
  let buckets: string[] = []
  try { buckets = ownedBuckets(prefix, await aws.storage.listBuckets()) } catch { buckets = [] }
  for (const bucket of buckets) {
    info(`  emptying ${bucket} (incl. versions)`)
    // batch-delete versions + delete markers, ≤1000 per DeleteObjects call,
    // re-listing until the bucket is empty
    let lastHead = ''
    for (;;) {
      let batch: Array<{ key: string; versionId?: string }>
      try { batch = (await aws.storage.listVersions(bucket)).slice(0, 1000) } catch { break }
      if (batch.length === 0) break
      // Belt and braces against an infinite sweep: DeleteObjects can report
      // per-object failures WITHOUT throwing (HTTP 200 + an Errors array).
      // aws.storage.deleteObjects turns that into a throw, but if anything ever
      // stops it from doing so, an undeletable object (missing
      // s3:DeleteObjectVersion, object lock) would re-list forever. If the
      // same object heads the listing after a delete pass, nothing moved.
      const head = `${batch[0].key} ${batch[0].versionId ?? ''}`
      if (head === lastHead) {
        warn(`  ${bucket}: objects could not be deleted (object lock, or missing s3:DeleteObjectVersion)`)
        break
      }
      lastHead = head
      // Break rather than re-list on failure: a persistent error (object lock, a
      // missing s3:DeleteObjectVersion) would otherwise loop forever. The
      // delete-bucket below then reports the leftover via its warn line.
      try { await aws.storage.deleteObjects(bucket, batch) } catch { break }
    }
    try {
      await aws.storage.deleteBucket(bucket)
      ok(`  deleted ${bucket}`)
    } catch {
      warn(`  could not delete ${bucket}`)
    }
  }

  info(`sweep: DynamoDB table ${prefix}-sap-orders`)
  try {
    await aws.tables.delete(`${prefix}-sap-orders`)
    ok('table deletion requested')
  } catch {
    info('  table already gone')
  }

  if (kmsArn) {
    info('sweep: KMS key (7-day scheduled deletion)')
    try {
      await aws.keys.scheduleDeletion(kmsArn, 7)
      ok('key deletion scheduled')
    } catch {
      info('  key already scheduled/gone')
    }
  }

  info('sweep: orphaned app-integrations MCP application')
  // The <prefix>-mcp application can survive if the instance was deleted while
  // the gateway stack still existed (its ApplicationAssociation has no delete
  // API and only clears asynchronously after instance deletion propagates).
  // Best effort; harmless/zero-cost if it lingers — re-run teardown to retry.
  let appArns: string[] = []
  try { appArns = await aws.applications.findArnsByName(`${prefix}-mcp`) } catch { appArns = [] }
  for (const arn of appArns) {
    try {
      await aws.applications.delete(arn)
      ok(`deleted application ${prefix}-mcp`)
    } catch {
      warn(`application ${prefix}-mcp still has associations — retry after instance deletion propagates`)
    }
  }

  // --- 4. verify ---------------------------------------------------------------
  info('verify')
  let leftStacks: number | '' = '' // '' = count unknown (the list call failed)
  try {
    leftStacks = (await aws.stacks.list(`${prefix}-`))
      .filter((s) => s.status !== 'DELETE_COMPLETE').length
  } catch { leftStacks = '' }
  let leftBuckets: number | '' = ''
  try {
    // Same ownership rule as the sweep: counting every `${prefix}-*` bucket
    // would report a sibling project's buckets as this teardown's leftovers.
    leftBuckets = ownedBuckets(prefix, await aws.storage.listBuckets()).length
  } catch { leftBuckets = '' }
  console.log(`  remaining stacks: ${leftStacks}, remaining buckets: ${leftBuckets} (instance deletion is async)`)
  if (leftStacks === 0 && leftBuckets === 0) ok('teardown complete')
  else warn('leftovers remain — re-run after a few minutes')
}
