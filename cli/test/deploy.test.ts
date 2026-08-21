import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deployCommand, type DeployPorts } from '../src/commands/deploy.js'
import { CliError } from '../src/lib/errors.js'

// SAFETY — read before adding a case here.
//
// deployCommand takes a DeployPorts seam: every AWS-touching step (callerAccount,
// preflight, deployAll, claim-did, sync-kb, smoke test) and every subprocess
// (render, synth) arrives injected, so a case that passes fakeDeps() cannot
// reach AWS however far it gets. Cases that deliberately stop early still carry
// an INVALID projectName, and the credential env is neutralized below as a
// second belt — keep both. (History: before this seam existed, writing this file
// deployed a live contact center once.)
const baseOpts = {
  express: false, claimUkDid: false, synthOnly: false, yes: true,
} as const

// Rejected by PROJECT_NAME_RE (spaces), so parseOrder throws before preflight.
const UNDEPLOYABLE = 'Bad Name'

/** Records every step, then delegates. Overrides change behaviour but never
 *  silence the log — a fake where an override drops the record makes every
 *  "did not run X" assertion vacuously true. */
function fakeDeps(over: Partial<DeployPorts> = {}): DeployPorts & { calls: string[] } {
  const calls: string[] = []
  const defaults: DeployPorts = {
    async interview() {
      return {
        orderRaw: { projectName: 'demo' },
        prefs: { claimUkDid: false, kbContent: 'skip', kbContentPath: '' },
      }
    },
    async confirmOrder() { return true },
    async callerAccount() { return '123456789012' },
    async preflight(opts) {
      return { account: '123456789012', region: opts.region, warnings: [] }
    },
    render() {},
    synth() {},
    deployAll() {
      return {
        'demo-ConnectInstance': { InstanceId: 'inst-1' },
        'demo-ContactFlow': { ContactFlowId: 'flow-1' },
        'demo-Wisdom': { AssistantId: 'as-1', OrchestrationAgentId: 'ag-1' },
      }
    },
    async claimDid() {},
    async syncKb() {},
    async smokeTest() {},
  }
  const impl = { ...defaults, ...over }
  const logged: Record<string, unknown> = {}
  for (const key of Object.keys(impl)) {
    const fn = (impl as Record<string, (...a: unknown[]) => unknown>)[key]!
    logged[key] = (...a: unknown[]) => { calls.push(key); return fn(...a) }
  }
  return Object.assign(logged as unknown as DeployPorts, { calls })
}

let tmp: string
let cwd: string
let lines: string[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'csp-deploy-cmd-'))
  cwd = process.cwd()
  process.chdir(tmp)
  // Belt: even if a case slipped past its gate, preflight's callerAccount()
  // resolves null and it dies with "AWS credentials not configured".
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) {
    vi.stubEnv(k, '')
  }
  vi.stubEnv('AWS_CONFIG_FILE', '/dev/null')
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', '/dev/null')
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
})
afterEach(() => {
  process.chdir(cwd)
  rmSync(tmp, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const writeOrder = (obj: unknown, name = 'order.json'): string => {
  const p = join(tmp, name)
  writeFileSync(p, JSON.stringify(obj))
  return p
}

describe('deployCommand — order loading', () => {
  it('names the missing order file', async () => {
    await expect(deployCommand({ ...baseOpts, orderFile: join(tmp, 'nope.json') }, fakeDeps()))
      .rejects.toThrow(`order file not found: ${join(tmp, 'nope.json')}`)
  })

  it('rejects an order file with no projectName', async () => {
    await expect(deployCommand({ ...baseOpts, orderFile: writeOrder({ companyName: 'X' }) }, fakeDeps()))
      .rejects.toThrow('order file has no projectName')
  })

  it('appends the rerun hint to a validation failure', async () => {
    // The rerun hint is the CLI's main recovery affordance: every failure inside
    // the deploy must carry the exact command that resumes it.
    const err = await deployCommand({ ...baseOpts, orderFile: writeOrder({ projectName: UNDEPLOYABLE }) }, fakeDeps())
      .catch((e) => e)
    expect(err).toBeInstanceOf(CliError)
    expect(err.message).toContain(`invalid projectName '${UNDEPLOYABLE}'`)
    expect(err.message).toContain('Once fixed, restart the deployment with:')
    expect(err.message).toContain('run csp -- deploy --order-file')
  })

  it('folds CLI overrides into the order file on disk', async () => {
    // The fold is written back BEFORE validation, so an invalid projectName
    // stops the run right after it — which is what keeps this case offline.
    const orderPath = writeOrder({ projectName: UNDEPLOYABLE, claimUkDid: false })
    await expect(deployCommand({ ...baseOpts, orderFile: orderPath, claimUkDid: true }, fakeDeps()))
      .rejects.toThrow(/invalid projectName/)
    expect(JSON.parse(readFileSync(orderPath, 'utf8')).claimUkDid).toBe(true)
  })
})

describe('deployCommand — knowledge-base content path', () => {
  it('fails before the deploy when --kb-content does not exist', async () => {
    // Regression: this used to be validated only by syncKb, i.e. AFTER a
    // ~20-minute `cdk deploy --all` had already created and billed every stack.
    // The order name here is valid-but-undeployable, proving the kb gate fires
    // ahead of projectName validation and therefore ahead of everything AWS.
    const orderPath = writeOrder({ projectName: UNDEPLOYABLE, knowledgeBaseEnabled: true })
    const missing = join(tmp, 'kb_data_typo')
    await expect(deployCommand({ ...baseOpts, orderFile: orderPath, kbContent: missing }, fakeDeps()))
      .rejects.toThrow(`knowledge-base content path not found: ${missing}`)
  })

  it('accepts an existing directory and the sample sentinel', async () => {
    const orderPath = writeOrder({ projectName: UNDEPLOYABLE, knowledgeBaseEnabled: true })
    for (const kbContent of ['sample', tmp]) {
      const err = await deployCommand({ ...baseOpts, orderFile: orderPath, kbContent }, fakeDeps())
        .catch((e) => e)
      // Past the kb gate, stopped by the invalid projectName — never at AWS.
      expect(err.message).not.toContain('knowledge-base content path not found')
      expect(err.message).toContain('invalid projectName')
    }
  })
})

describe('deployCommand — pipeline', () => {
  // These run the WHOLE command against fakes. None of it was reachable in a
  // test before the seam existed.
  let order: string
  beforeEach(() => { order = writeOrder({ projectName: 'demo' }) })
  afterEach(() => { process.exitCode = undefined })

  it('runs the steps in order and stops before deploy with --synth-only', async () => {
    const deps = fakeDeps()
    await deployCommand({ ...baseOpts, orderFile: order, synthOnly: true }, deps)
    expect(deps.calls).toEqual(['preflight', 'render', 'synth'])
  })

  it('deploys, then runs the post-deploy steps it was asked for', async () => {
    const deps = fakeDeps()
    await deployCommand({ ...baseOpts, orderFile: order }, deps)
    expect(deps.calls).toEqual(['preflight', 'render', 'synth', 'deployAll', 'smokeTest'])
  })

  it('claims a DID only when the order asks for one', async () => {
    const withDid = fakeDeps()
    await deployCommand({ ...baseOpts, orderFile: order, claimUkDid: true }, withDid)
    expect(withDid.calls).toContain('claimDid')

    const without = fakeDeps()
    await deployCommand({ ...baseOpts, orderFile: writeOrder({ projectName: 'demo' }, 'o2.json') },
      without)
    expect(without.calls).not.toContain('claimDid')
  })

  it('syncs the knowledge base only when the order enables it', async () => {
    const deps = fakeDeps()
    await deployCommand(
      { ...baseOpts, orderFile: writeOrder({ projectName: 'demo', knowledgeBaseEnabled: true }),
        kbContent: 'sample' }, deps)
    expect(deps.calls).toContain('syncKb')
  })

  it('keeps the next-steps checklist and exits non-zero when a post-deploy step fails', async () => {
    // The checklist carries the one REQUIRED manual step (publishing the
    // orchestration agent). A post-deploy failure must not swallow it.
    const deps = fakeDeps({ async smokeTest() { throw new Error('smoke boom') } })
    await deployCommand({ ...baseOpts, orderFile: order }, deps)
    expect(process.exitCode).toBe(1)
    const out = lines.join('\n')
    expect(out).toContain('publish the orchestration AI agent')
    expect(out).toContain('post-deploy step(s) failed')
  })

  it('does not run post-deploy steps when the deploy itself fails', async () => {
    const deps = fakeDeps({ deployAll() { throw new CliError('cdk deploy exploded') } })
    await expect(deployCommand({ ...baseOpts, orderFile: order }, deps))
      .rejects.toThrow(/cdk deploy exploded[\s\S]*deploy --order-file/)
    expect(deps.calls).not.toContain('smokeTest')
  })

  it('aborts without deploying when the interview is not confirmed', async () => {
    const deps = fakeDeps({ async confirmOrder() { return false } })
    await deployCommand({ ...baseOpts, yes: false, express: true, projectName: 'demo' }, deps)
    expect(deps.calls).toEqual(['interview', 'callerAccount', 'confirmOrder'])
  })
})
