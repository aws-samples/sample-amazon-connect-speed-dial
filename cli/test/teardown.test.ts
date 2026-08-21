import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { teardown, resolveTeardownProjectDir, type TeardownPorts, ownedBuckets, bucketPrefixFor } from '../src/commands/teardown.js'
import { CliError } from '../src/lib/errors.js'

// All tests run against fakes — teardown is DESTRUCTIVE and must never touch
// AWS from the suite. The fakes record every call so ordering and best-effort
// continuation can be asserted.

interface FakeOpts {
  /** cdk-outputs.json content (undefined = the default full outputs; null = no file). */
  outputs?: Record<string, Record<string, string>> | null
  /** Confirmation answer typed at the prompt. */
  confirmAnswer?: string
  instanceByAlias?: string | null
  assistantByName?: string | null
  agentByName?: string | null
  securityProfileId?: string | null
  versions?: number[]
  connectStackExists?: boolean
  cdkDestroyThrows?: boolean
  /** Stacks visible to list-stacks (used by the DELETE_FAILED scan AND verify). */
  stacks?: Array<{ name: string; status: string }>
  deleteFailedResourceIds?: string[]
  waitThrows?: boolean
  /** Initial buckets: name → object versions still in it. */
  buckets?: Record<string, Array<{ key: string; versionId?: string }>>
  deleteBucketThrows?: boolean
  deleteInstanceThrows?: boolean
  deleteTableThrows?: boolean
  scheduleKeyDeletionThrows?: boolean
  applicationArns?: string[]
  applicationListThrows?: boolean
  deleteApplicationThrows?: boolean
}

interface FakeState {
  calls: string[]
  prompts: string[]
  disassociations: Array<{ instanceId: string; entityArn: string; securityProfileId: string }>
  deletedStacks: Array<{ stackName: string; retainResources: string[] }>
  deleteObjectBatches: Array<{ bucket: string; size: number }>
  deletedBuckets: string[]
  deletedTables: string[]
  scheduledKeys: Array<{ keyArn: string; pendingDays: number }>
  deletedApplications: string[]
  destroyedProjects: string[]
}

let projectDir: string
let skillRoot: string
let lines: string[]
let savedForce: string | undefined

const fullOutputs = {
  'proj-ConnectInstance': {
    InstanceArn: 'arn:aws:connect:eu-central-1:123456789012:instance/inst-1',
    StorageKmsKeyArn: 'arn:aws:kms:eu-central-1:123456789012:key/kms-1',
  },
  'proj-Wisdom': { AssistantId: 'as-1', OrchestrationAgentId: 'ag-1' },
}

function fakePorts(opts: FakeOpts = {}): TeardownPorts & FakeState {
  const state: FakeState = {
    calls: [], prompts: [], disassociations: [], deletedStacks: [],
    deleteObjectBatches: [], deletedBuckets: [], deletedTables: [],
    scheduledKeys: [], deletedApplications: [], destroyedProjects: [],
  }
  const buckets = new Map(Object.entries(opts.buckets ?? {}))
  const flat = {
    async callerAccount() {
      state.calls.push('callerAccount')
      return '123456789012'
    },
    async confirmInput(prompt: string) {
      state.calls.push('confirmInput')
      state.prompts.push(prompt)
      return opts.confirmAnswer ?? 'proj'
    },
    async instanceIdByAlias(alias: string) {
      state.calls.push(`instanceIdByAlias:${alias}`)
      return opts.instanceByAlias ?? null
    },
    async securityProfileIdByName(instanceId: string, name: string) {
      state.calls.push(`securityProfileIdByName:${instanceId}:${name}`)
      return opts.securityProfileId ?? null
    },
    async disassociateSecurityProfile(instanceId: string, entityArn: string, securityProfileId: string) {
      state.calls.push('disassociateSecurityProfile')
      state.disassociations.push({ instanceId, entityArn, securityProfileId })
    },
    async deleteInstance(instanceId: string) {
      state.calls.push(`deleteInstance:${instanceId}`)
      if (opts.deleteInstanceThrows) throw new Error('ResourceInUse')
    },
    async assistantIdByName(name: string) {
      state.calls.push(`assistantIdByName:${name}`)
      return opts.assistantByName ?? null
    },
    async aiAgentIdByName(assistantId: string, name: string) {
      state.calls.push(`aiAgentIdByName:${assistantId}:${name}`)
      return opts.agentByName ?? null
    },
    async aiAgentVersionNumbers() {
      state.calls.push('aiAgentVersionNumbers')
      return opts.versions ?? []
    },
    async stackExists(stackName: string) {
      state.calls.push(`stackExists:${stackName}`)
      return opts.connectStackExists ?? true
    },
    async listStacks(prefix: string) {
      state.calls.push(`listStacks:${prefix}`)
      return opts.stacks ?? []
    },
    async deleteFailedResourceIds(stackName: string) {
      state.calls.push(`deleteFailedResourceIds:${stackName}`)
      return opts.deleteFailedResourceIds ?? []
    },
    async deleteStack(stackName: string, retainResources: string[]) {
      state.calls.push(`deleteStack:${stackName}`)
      state.deletedStacks.push({ stackName, retainResources })
    },
    async waitStackDeleteComplete(stackName: string) {
      state.calls.push(`waitStackDeleteComplete:${stackName}`)
      if (opts.waitThrows) throw new Error('waiter timed out')
    },
    cdkDestroyAll(dir: string) {
      state.calls.push('cdkDestroyAll')
      state.destroyedProjects.push(dir)
      if (opts.cdkDestroyThrows) throw new CliError('command failed (exit 1): npx')
    },
    async bucketNames() {
      state.calls.push('bucketNames')
      return [...buckets.keys()]
    },
    async listObjectVersions(bucket: string) {
      state.calls.push(`listObjectVersions:${bucket}`)
      return [...(buckets.get(bucket) ?? [])]
    },
    async deleteObjects(bucket: string, objects: Array<{ key: string; versionId?: string }>) {
      state.calls.push(`deleteObjects:${bucket}:${objects.length}`)
      state.deleteObjectBatches.push({ bucket, size: objects.length })
      const rest = (buckets.get(bucket) ?? []).slice(objects.length)
      buckets.set(bucket, rest)
    },
    async deleteBucket(bucket: string) {
      state.calls.push(`deleteBucket:${bucket}`)
      if (opts.deleteBucketThrows) throw new Error('BucketNotEmpty')
      state.deletedBuckets.push(bucket)
      buckets.delete(bucket)
    },
    async deleteTable(name: string) {
      state.calls.push(`deleteTable:${name}`)
      if (opts.deleteTableThrows) throw new Error('ResourceNotFoundException')
      state.deletedTables.push(name)
    },
    async scheduleKeyDeletion(keyArn: string, pendingDays: number) {
      state.calls.push('scheduleKeyDeletion')
      if (opts.scheduleKeyDeletionThrows) throw new Error('KMSInvalidStateException')
      state.scheduledKeys.push({ keyArn, pendingDays })
    },
    async applicationArnsByName(name: string) {
      state.calls.push(`applicationArnsByName:${name}`)
      if (opts.applicationListThrows) throw new Error('AccessDenied')
      return opts.applicationArns ?? []
    },
    async deleteApplication(arn: string) {
      state.calls.push(`deleteApplication:${arn}`)
      if (opts.deleteApplicationThrows) throw new Error('ResourceInUse')
      state.deletedApplications.push(arn)
    },
  }

  // The port groups are assembled from the flat implementations above. The
  // `calls` labels keep their original names so the ~40 assertions below stay
  // untouched; they are test-internal labels, not production identifiers.
  return {
    ...state,
    identity: { accountId: flat.callerAccount },
    prompt: { ask: flat.confirmInput },
    toolchain: { destroyAll: flat.cdkDestroyAll },
    instances: { findIdByAlias: flat.instanceIdByAlias, delete: flat.deleteInstance },
    securityProfiles: {
      findIdByName: flat.securityProfileIdByName,
      disassociateAiAgent: flat.disassociateSecurityProfile,
    },
    agents: {
      findAssistantIdByName: flat.assistantIdByName,
      findAgentIdByName: flat.aiAgentIdByName,
      versionNumbers: flat.aiAgentVersionNumbers,
    },
    stacks: {
      exists: flat.stackExists,
      list: flat.listStacks,
      deleteFailedResourceIds: flat.deleteFailedResourceIds,
      delete: flat.deleteStack,
      waitDeleted: flat.waitStackDeleteComplete,
    },
    storage: {
      listBuckets: flat.bucketNames,
      listVersions: flat.listObjectVersions,
      deleteObjects: flat.deleteObjects,
      deleteBucket: flat.deleteBucket,
    },
    tables: { delete: flat.deleteTable },
    keys: { scheduleDeletion: flat.scheduleKeyDeletion },
    applications: {
      findArnsByName: flat.applicationArnsByName,
      delete: flat.deleteApplication,
    },
  }
}

function writeProject(opts: FakeOpts = {}): void {
  writeFileSync(join(projectDir, '.connect-skill-values.json'),
    JSON.stringify({ projectName: 'proj', region: 'eu-central-1' }))
  const outputs = opts.outputs === undefined ? fullOutputs : opts.outputs
  if (outputs !== null) {
    writeFileSync(join(projectDir, 'cdk-outputs.json'), JSON.stringify(outputs))
  }
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'csp-teardown-proj-'))
  skillRoot = mkdtempSync(join(tmpdir(), 'csp-teardown-root-'))
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
  savedForce = process.env.FORCE_TEARDOWN
  delete process.env.FORCE_TEARDOWN
  process.exitCode = undefined
})
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(skillRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
  if (savedForce === undefined) delete process.env.FORCE_TEARDOWN
  else process.env.FORCE_TEARDOWN = savedForce
  process.exitCode = undefined
})

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const stripped = () => lines.map(strip)

describe('project resolution', () => {
  it('rejects an unknown project with the verbatim two-line error', async () => {
    const name = 'no-such-proj-xyz'
    await expect(teardown(name, 'eu-central-1', fakePorts(), skillRoot)).rejects.toThrow(
      `could not find a rendered project for '${name}'\n` +
      `  expected a values file at <project-dir>/.connect-skill-values.json or ./csp-${name}/`)
  })

  it('accepts an explicit project dir containing a values file', () => {
    writeProject()
    expect(resolveTeardownProjectDir(projectDir, skillRoot)).toBe(projectDir)
  })

  it('resolves csp-<name> under the skill root', () => {
    mkdirSync(join(skillRoot, 'csp-rooted'))
    writeFileSync(join(skillRoot, 'csp-rooted', '.connect-skill-values.json'), '{}')
    expect(resolveTeardownProjectDir('rooted', skillRoot)).toBe(join(skillRoot, 'csp-rooted'))
  })

  it('rejects a values file without projectName BEFORE any dep is called (empty prefix must never reach the confirmation gate)', async () => {
    const valuesPath = join(projectDir, '.connect-skill-values.json')
    writeFileSync(valuesPath, '{}')
    const deps = fakePorts()
    await expect(teardown(projectDir, 'eu-central-1', deps, skillRoot)).rejects.toThrow(CliError)
    await expect(teardown(projectDir, 'eu-central-1', deps, skillRoot)).rejects.toThrow(
      `values file has no projectName: ${valuesPath}`)
    expect(deps.calls).toEqual([])
  })
})

describe('confirmation gate', () => {
  it('prints the red warning, prompts with the project name, and aborts on mismatch with exit code 1 — BEFORE any id capture', async () => {
    writeProject()
    const deps = fakePorts({ confirmAnswer: 'wrong' })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(stripped().slice(0, 3)).toEqual([
      "This will PERMANENTLY DELETE the 'proj' deployment in 123456789012 (eu-central-1),",
      'including retained data: Connect instance, storage/KB/schema/SAP buckets,',
      'the storage KMS key, and the sap-orders table.',
    ])
    // the three warning lines are red
    expect(lines[0]).toBe("\x1b[0;31mThis will PERMANENTLY DELETE the 'proj' deployment in 123456789012 (eu-central-1),\x1b[0m")
    expect(deps.prompts).toEqual(["Type the project name ('proj') to confirm: "])
    expect(stripped()).toContain("aborted — input did not match 'proj'")
    expect(process.exitCode).toBe(1)
    // the gate sits BEFORE id capture and every destructive step:
    // only sts get-caller-identity and the prompt itself may have run
    expect(deps.calls).toEqual(['callerAccount', 'confirmInput'])
  })

  it('proceeds when the typed input matches the project name', async () => {
    writeProject()
    const deps = fakePorts({ confirmAnswer: 'proj' })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(process.exitCode).toBeUndefined()
    expect(deps.calls).toContain('cdkDestroyAll')
  })

  it('FORCE_TEARDOWN=1 skips the prompt entirely', async () => {
    writeProject()
    process.env.FORCE_TEARDOWN = '1'
    const deps = fakePorts({ confirmAnswer: 'would-not-match' })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(deps.prompts).toEqual([])
    expect(deps.calls).not.toContain('confirmInput')
    expect(deps.calls).toContain('cdkDestroyAll')
  })

  it('any other FORCE_TEARDOWN value still prompts', async () => {
    writeProject()
    process.env.FORCE_TEARDOWN = 'true'
    const deps = fakePorts({ confirmAnswer: 'proj' })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(deps.prompts.length).toBe(1)
  })
})

describe('region resolution', () => {

  it('values-file region is used when no arg is given', async () => {
    writeProject()
    await teardown(projectDir, 'eu-central-1', fakePorts(), skillRoot)
    expect(stripped()[0]).toContain('(eu-central-1)')
  })
})

describe('id capture', () => {
  it('uses cdk-outputs.json when present (instance id stripped from the ARN) — no API fallbacks', async () => {
    writeProject()
    const deps = fakePorts({ securityProfileId: 'sp-1' })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(deps.calls).not.toContain('instanceIdByAlias:proj-123456789012')
    expect(deps.calls.some((c) => c.startsWith('assistantIdByName'))).toBe(false)
    expect(deps.calls).toContain('deleteInstance:inst-1')
    expect(deps.scheduledKeys).toEqual([
      { keyArn: 'arn:aws:kms:eu-central-1:123456789012:key/kms-1', pendingDays: 7 }])
  })

  it('falls back to alias/name lookups when the outputs file is missing', async () => {
    writeProject({ outputs: null })
    const deps = fakePorts({
      outputs: null, instanceByAlias: 'inst-live', assistantByName: 'as-live', agentByName: 'ag-live',
      securityProfileId: 'sp-1',
    })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(deps.calls).toContain('instanceIdByAlias:proj-123456789012')
    expect(deps.calls).toContain('assistantIdByName:proj-assistant')
    expect(deps.calls).toContain('aiAgentIdByName:as-live:proj-orchestrator')
    expect(deps.calls).toContain('deleteInstance:inst-live')
    // no KMS ARN captured → the KMS sweep is skipped entirely
    expect(deps.calls).not.toContain('scheduleKeyDeletion')
    expect(stripped()).not.toContain('→ sweep: KMS key (7-day scheduled deletion)')
  })

  it('skips the agent lookup when no assistant was found', async () => {
    writeProject({ outputs: null })
    const deps = fakePorts({ assistantByName: null })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(deps.calls.some((c) => c.startsWith('aiAgentIdByName'))).toBe(false)
  })
})

describe('pre-clean: security-profile disassociation', () => {
  it('disassociates the base ARN plus each numbered version — never $SAVED/$LATEST', async () => {
    writeProject()
    const deps = fakePorts({ securityProfileId: 'sp-1', versions: [1, 2] })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    const base = 'arn:aws:wisdom:eu-central-1:123456789012:ai-agent/as-1/ag-1'
    expect(deps.disassociations.map((d) => d.entityArn)).toEqual([base, `${base}:1`, `${base}:2`])
    for (const d of deps.disassociations) {
      expect(d.instanceId).toBe('inst-1')
      expect(d.securityProfileId).toBe('sp-1')
      expect(d.entityArn).not.toMatch(/\$SAVED|\$LATEST/)
    }
    expect(stripped()).toContain('→ pre-clean: disassociating ai-agent security-profile bindings')
    expect(stripped()).toContain('→   disassociated ag-1')
    expect(stripped()).toContain('→   disassociated ag-1:1')
    expect(stripped()).toContain('→   disassociated ag-1:2')
    expect(stripped()).toContain('✓ security-profile bindings cleared')
  })

  it('a failing disassociate is silent and does not stop the remaining ARNs', async () => {
    writeProject()
    const deps = fakePorts({ securityProfileId: 'sp-1', versions: [1] })
    let first = true
    deps.securityProfiles.disassociateAiAgent = async (_i: string, entityArn: string) => {
      deps.calls.push('disassociateSecurityProfile')
      if (first) { first = false; throw new Error('ResourceNotFound') }
      deps.disassociations.push({ instanceId: 'inst-1', entityArn, securityProfileId: 'sp-1' })
    }
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    // base failed silently; version 1 still attempted and reported
    expect(stripped()).not.toContain('→   disassociated ag-1')
    expect(stripped()).toContain('→   disassociated ag-1:1')
    expect(stripped()).toContain('✓ security-profile bindings cleared')
  })

  it('skips the pre-clean when the security profile is not found (no ✓ line)', async () => {
    writeProject()
    const deps = fakePorts({ securityProfileId: null })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(deps.disassociations).toEqual([])
    expect(stripped()).toContain('→ pre-clean: disassociating ai-agent security-profile bindings')
    expect(stripped()).not.toContain('✓ security-profile bindings cleared')
  })

  it('skips the pre-clean entirely when instance, assistant or agent is missing', async () => {
    writeProject({ outputs: { 'proj-ConnectInstance': { InstanceArn: 'arn:aws:connect:r:a:instance/inst-1' } } })
    const deps = fakePorts({ assistantByName: null })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(deps.calls.some((c) => c.startsWith('securityProfileIdByName'))).toBe(false)
    expect(stripped()).not.toContain('→ pre-clean: disassociating ai-agent security-profile bindings')
  })
})

describe('cdk destroy', () => {
  it('runs cdk destroy when the ConnectInstance stack exists', async () => {
    writeProject()
    const deps = fakePorts({ connectStackExists: true })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(deps.calls).toContain('stackExists:proj-ConnectInstance')
    expect(deps.destroyedProjects).toEqual([projectDir])
    expect(stripped()).toContain('→ cdk destroy --all (proj)')
  })

  it('a failed destroy warns and CONTINUES to the sweeps', async () => {
    writeProject()
    const deps = fakePorts({ cdkDestroyThrows: true })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(stripped()).toContain('⚠ cdk destroy reported errors — sweeping anyway')
    expect(deps.calls).toContain('deleteInstance:inst-1')
    expect(deps.deletedTables).toEqual(['proj-sap-orders'])
  })

  it('skips destroy when the stack is already gone', async () => {
    writeProject()
    const deps = fakePorts({ connectStackExists: false })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(deps.calls).not.toContain('cdkDestroyAll')
    expect(stripped()).toContain('→ stacks already gone — proceeding to sweep')
  })
})

describe('DELETE_FAILED recovery', () => {
  it('retries the delete retaining the stuck resources, then reports the waiter result', async () => {
    writeProject()
    const deps = fakePorts({
      stacks: [
        { name: 'proj-Wisdom', status: 'DELETE_FAILED' },
        { name: 'proj-ContactFlow', status: 'DELETE_COMPLETE' },
      ],
      deleteFailedResourceIds: ['AgentAssoc0', 'AgentAssoc1'],
    })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(stripped()).toContain('⚠ retrying delete of proj-Wisdom (retaining stuck: AgentAssoc0 AgentAssoc1)')
    expect(deps.deletedStacks).toEqual([
      { stackName: 'proj-Wisdom', retainResources: ['AgentAssoc0', 'AgentAssoc1'] }])
    expect(stripped()).toContain('✓ proj-Wisdom deleted')
  })

  it('a failing waiter warns but the sweeps still run', async () => {
    writeProject()
    const deps = fakePorts({
      stacks: [{ name: 'proj-Wisdom', status: 'DELETE_FAILED' }],
      waitThrows: true,
    })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(stripped()).toContain('⚠ proj-Wisdom still not deleted')
    expect(deps.calls).toContain('deleteInstance:inst-1')
  })
})

describe('S3 bucket purge', () => {
  it('empties versions+markers in ≤1000 batches until the listing is empty, then deletes the bucket', async () => {
    writeProject()
    const objects = Array.from({ length: 1500 }, (_, i) => ({ key: `k${i}`, versionId: `v${i}` }))
    const deps = fakePorts({ buckets: { 'proj-connect-storage-123456789012-us-east-1-an': objects, 'unrelated-bucket': [] } })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    // two delete batches (1000 then 500), then an empty listing breaks the loop
    expect(deps.deleteObjectBatches).toEqual([
      { bucket: 'proj-connect-storage-123456789012-us-east-1-an', size: 1000 },
      { bucket: 'proj-connect-storage-123456789012-us-east-1-an', size: 500 },
    ])
    expect(deps.deletedBuckets).toEqual(['proj-connect-storage-123456789012-us-east-1-an'])
    expect(stripped()).toContain('→   emptying proj-connect-storage-123456789012-us-east-1-an (incl. versions)')
    expect(stripped()).toContain('✓   deleted proj-connect-storage-123456789012-us-east-1-an')
    // buckets not starting with '<prefix>-' are never touched
    expect(deps.calls.some((c) => c.includes('unrelated-bucket'))).toBe(false)
  })

  it('warns when the bucket cannot be deleted and continues', async () => {
    writeProject()
    const deps = fakePorts({ buckets: { 'proj-connect-storage-123456789012-us-east-1-an': [] }, deleteBucketThrows: true })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(stripped()).toContain('⚠   could not delete proj-connect-storage-123456789012-us-east-1-an')
    expect(deps.deletedTables).toEqual(['proj-sap-orders'])
  })
})

describe('best-effort continuation', () => {
  it('throwing sweep steps never stop later steps — every sweep and the verify still run', async () => {
    writeProject()
    const deps = fakePorts({
      deleteInstanceThrows: true,
      deleteTableThrows: true,
      scheduleKeyDeletionThrows: true,
      applicationListThrows: true,
    })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    const out = stripped()
    expect(out).toContain('→   instance already gone or not deletable yet')
    expect(out).toContain('→   table already gone')
    expect(out).toContain('→   key already scheduled/gone')
    expect(out).toContain('→ sweep: orphaned app-integrations MCP application')
    expect(out).toContain('→ verify')
    expect(out.some((l) => l.startsWith('  remaining stacks:'))).toBe(true)
  })

  it('deletes the orphaned MCP application, or warns when it still has associations', async () => {
    writeProject()
    const deps = fakePorts({ applicationArns: ['arn:app/1'] })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(deps.deletedApplications).toEqual(['arn:app/1'])
    expect(stripped()).toContain('✓ deleted application proj-mcp')

    lines = []
    const deps2 = fakePorts({ applicationArns: ['arn:app/1'], deleteApplicationThrows: true })
    await teardown(projectDir, 'eu-central-1', deps2, skillRoot)
    expect(stripped()).toContain(
      '⚠ application proj-mcp still has associations — retry after instance deletion propagates')
  })
})

describe('verify', () => {
  it('reports zero leftovers as teardown complete', async () => {
    writeProject()
    const deps = fakePorts({ stacks: [{ name: 'proj-Wisdom', status: 'DELETE_COMPLETE' }] })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(stripped()).toContain('  remaining stacks: 0, remaining buckets: 0 (instance deletion is async)')
    expect(stripped()).toContain('✓ teardown complete')
  })

  it('counts stacks (status != DELETE_COMPLETE) and surviving buckets, then warns', async () => {
    writeProject()
    const deps = fakePorts({
      stacks: [
        { name: 'proj-Wisdom', status: 'DELETE_FAILED' },
        { name: 'proj-ConnectInstance', status: 'DELETE_IN_PROGRESS' },
        { name: 'proj-ContactFlow', status: 'DELETE_COMPLETE' },
      ],
      buckets: { 'proj-connect-storage-123456789012-us-east-1-an': [] },
      deleteBucketThrows: true,
    })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(stripped()).toContain('  remaining stacks: 2, remaining buckets: 1 (instance deletion is async)')
    expect(stripped()).toContain('⚠ leftovers remain — re-run after a few minutes')
  })
})

describe('full transcript (happy path)', () => {
  it('prints the exact ordered transcript (output contract)', async () => {
    writeProject()
    const deps = fakePorts({
      securityProfileId: 'sp-1', versions: [1],
      buckets: { 'proj-connect-storage-123456789012-us-east-1-an': [{ key: 'a', versionId: '1' }] },
      applicationArns: ['arn:app/1'],
    })
    await teardown(projectDir, 'eu-central-1', deps, skillRoot)
    expect(stripped()).toEqual([
      "This will PERMANENTLY DELETE the 'proj' deployment in 123456789012 (eu-central-1),",
      'including retained data: Connect instance, storage/KB/schema/SAP buckets,',
      'the storage KMS key, and the sap-orders table.',
      '→ pre-clean: disassociating ai-agent security-profile bindings',
      '→   disassociated ag-1',
      '→   disassociated ag-1:1',
      '✓ security-profile bindings cleared',
      '→ cdk destroy --all (proj)',
      '→ sweep: Connect instance',
      '✓ instance inst-1 deletion requested',
      '→ sweep: S3 buckets (proj-{connect-storage,kb-docs,gateway-schemas,sap-documents,webcall-site})',
      '→   emptying proj-connect-storage-123456789012-us-east-1-an (incl. versions)',
      '✓   deleted proj-connect-storage-123456789012-us-east-1-an',
      '→ sweep: DynamoDB table proj-sap-orders',
      '✓ table deletion requested',
      '→ sweep: KMS key (7-day scheduled deletion)',
      '✓ key deletion scheduled',
      '→ sweep: orphaned app-integrations MCP application',
      '✓ deleted application proj-mcp',
      '→ verify',
      '  remaining stacks: 0, remaining buckets: 0 (instance deletion is async)',
      '✓ teardown complete',
    ])
  })
})

describe('ownedBuckets (bucket ownership rule)', () => {
  // Was `name.startsWith(project + '-')`, which is wrong in BOTH directions.
  it('excludes sibling projects whose name extends this one', () => {
    const all = [
      'demo-connect-storage-123456789012-us-east-1-an',
      'demo-kb-docs-123456789012-us-east-1-an',
      'demo-test-connect-storage-123456789012-us-east-1-an',
      'demo-test-kb-docs-123456789012-us-east-1-an',
      'unrelated-bucket',
    ]
    expect(ownedBuckets('demo', all)).toEqual([
      'demo-connect-storage-123456789012-us-east-1-an',
      'demo-kb-docs-123456789012-us-east-1-an',
    ])
    // The sibling's buckets hold ITS call recordings, transcripts and KB
    // documents; the old rule purged every version in them during a teardown
    // the user only confirmed for 'demo'.
    expect(ownedBuckets('demo', all)).not.toContain('demo-test-connect-storage-123456789012-us-east-1-an')
  })

  it('finds buckets whose project prefix was truncated by the 34-char cap', () => {
    // ConfigNamer.bucketPrefix truncates the PROJECT (never the baseName) when
    // `<project>-<baseName>` exceeds 34 chars, so the full project name is not a
    // prefix of the bucket name and the old startsWith missed these entirely.
    const project = 'a-very-long-project-name-indeed'
    const truncated = bucketPrefixFor(project, 'connect-storage')
    expect(truncated.startsWith(project)).toBe(false)
    expect(truncated.endsWith('connect-storage')).toBe(true)
    expect(truncated.length).toBeLessThanOrEqual(34)
    expect(ownedBuckets(project, [`${truncated}-123456789012-us-east-1-an`]))
      .toEqual([`${truncated}-123456789012-us-east-1-an`])
  })

  it('covers every bucket the blueprint creates', () => {
    const names = ['connect-storage', 'kb-docs', 'gateway-schemas', 'sap-documents', 'webcall-site']
      .map((b) => `proj-${b}-123456789012-us-east-1-an`)
    expect(ownedBuckets('proj', names)).toEqual(names)
  })
})
