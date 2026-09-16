import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
  smokeTest, renderReport, bareId, idsFrom,
  type SmokeTestInput, type SmokeTestPorts,
} from '../src/commands/smokeTest.js'
import { CliError } from '../src/lib/errors.js'

// Ports are faked inline: smoke-test is the only consumer so far, and a shared
// test/fakes.ts for one caller would be premature.
function ports(over: Partial<SmokeTestPorts> = {}): SmokeTestPorts & { calls: string[] } {
  const calls: string[] = []
  const base: SmokeTestPorts = {
    instances: {
      async describe(id) {
        calls.push(`describe:${id}`)
        return { status: 'ACTIVE', identityManagementType: 'SAML' }
      },
    },
    flows: {
      async status(i, f) { calls.push(`flow:${i}/${f}`); return 'PUBLISHED' },
    },
    agents: {
      async status(a, g) { calls.push(`agent:${a}/${g}`); return 'ACTIVE' },
    },
    phoneNumbers: {
      async listClaimed(id, cc) {
        calls.push(`numbers:${id}/${cc}`)
        return [{ phoneNumber: '+441134960000', phoneNumberId: 'pn-1' }]
      },
    },
    rules: {
      async state(n) { calls.push(`rule:${n}`); return 'ENABLED' },
    },
    knowledgeBases: {
      async status(k) { calls.push(`kb:${k}`); return 'ACTIVE' },
    },
  }
  return { ...base, ...over, calls }
}

const FULL_OUTPUTS = {
  'proj-ContactEvents': { RuleArn: 'arn:aws:events:us-east-1:123:rule/proj-contact-events' },
  'proj-ConnectInstance': { InstanceId: 'inst-1', IdentityManagementType: 'SAML' },
  'proj-Wisdom': { BedrockKnowledgeBaseId: 'KB123' },
}

const input = (over: Partial<SmokeTestInput> = {}): SmokeTestInput => ({
  instanceId: 'inst-1',
  flowId: 'flow-1',
  assistantId: 'asst-1',
  agentId: 'agent-1',
  region: 'us-east-1',
  didExpected: true,
  ...over,
})

const byName = (r: Awaited<ReturnType<typeof smokeTest>>, name: string) =>
  r.checks.find((c) => c.name === name)

describe('bareId', () => {
  it('reduces an ARN to the segment after the last slash', () => {
    expect(bareId('arn:aws:connect:us-east-1:123:instance/inst-arn')).toBe('inst-arn')
    expect(bareId('arn:aws:connect:us-east-1:123:instance/inst/contact-flow/flow-arn'))
      .toBe('flow-arn')
  })

  it('drops a :version suffix, with or without an ARN prefix', () => {
    expect(bareId('arn:aws:wisdom:us-east-1:123:ai-agent/asst/agent-arn:1')).toBe('agent-arn')
    expect(bareId('agent-1:2')).toBe('agent-1')
  })

  it('leaves a bare id untouched', () => {
    expect(bareId('inst-1')).toBe('inst-1')
  })
})

describe('smokeTest', () => {
  it('passes every check and reports the claimed number', async () => {
    const r = await smokeTest(input({ outputs: FULL_OUTPUTS }), ports())
    expect(r.ok).toBe(true)
    expect(r.checks.filter((c) => c.status !== 'pass')).toEqual([])
    expect(r.checks.map((c) => c.name)).toEqual([
      'instance', 'contact flow', 'AI agent', 'UK DID',
      'contact-events rule', 'identity management', 'knowledge base',
    ])
    expect(r.phoneNumber).toBe('+441134960000')
  })

  it('turns a thrown AWS error into a failed check carrying the real message', async () => {
    const r = await smokeTest(input(), ports({
      instances: { async describe() { throw new Error('ExpiredTokenException: token expired') } },
    }))
    expect(r.ok).toBe(false)
    expect(byName(r, 'instance')).toEqual({
      name: 'instance', status: 'fail', detail: 'ExpiredTokenException: token expired',
    })
  })

  it('accumulates failures — a failed check never short-circuits the rest', async () => {
    const p = ports({
      instances: { async describe() { throw new Error('boom') } },
      flows: { async status() { return 'SAVED' } },
    })
    const r = await smokeTest(input({ outputs: FULL_OUTPUTS }), p)
    expect(r.checks.filter((c) => c.status === 'fail').map((c) => c.name))
      .toEqual(['instance', 'contact flow'])
    // Later checks still ran.
    expect(p.calls.some((c) => c.startsWith('agent:'))).toBe(true)
    expect(p.calls.some((c) => c.startsWith('numbers:'))).toBe(true)
    expect(p.calls.some((c) => c.startsWith('kb:'))).toBe(true)
  })

  it('reports an unhealthy status as a failure naming the actual value', async () => {
    const r = await smokeTest(input(), ports({
      flows: { async status() { return 'SAVED' } },
    }))
    expect(byName(r, 'contact flow')).toMatchObject({ status: 'fail' })
    expect(byName(r, 'contact flow')!.detail).toContain('SAVED')
    expect(byName(r, 'contact flow')!.detail).toContain('PUBLISHED')
  })

  it('accepts CREATE_COMPLETE as a healthy AI agent status', async () => {
    const r = await smokeTest(input(), ports({
      agents: { async status() { return 'CREATE_COMPLETE' } },
    }))
    expect(byName(r, 'AI agent')).toMatchObject({ status: 'pass', detail: 'CREATE_COMPLETE' })
  })

  it('normalizes ARN and :version ids before calling AWS, and reports the bare ids', async () => {
    const p = ports()
    const r = await smokeTest(input({
      instanceId: 'arn:aws:connect:us-east-1:123:instance/inst-arn',
      flowId: 'arn:aws:connect:us-east-1:123:instance/inst-arn/contact-flow/flow-arn',
      assistantId: 'arn:aws:wisdom:us-east-1:123:assistant/asst-arn',
      agentId: 'arn:aws:wisdom:us-east-1:123:ai-agent/asst-arn/agent-arn:1',
    }), p)
    expect(p.calls).toContain('describe:inst-arn')
    expect(p.calls).toContain('flow:inst-arn/flow-arn')
    expect(p.calls).toContain('agent:asst-arn/agent-arn')
    expect(p.calls).toContain('numbers:inst-arn/GB')
    expect(r.ids).toEqual({
      instanceId: 'inst-arn', flowId: 'flow-arn', assistantId: 'asst-arn', agentId: 'agent-arn',
    })
  })

  it('asks the phone-number registry for GB only', async () => {
    const p = ports()
    await smokeTest(input(), p)
    expect(p.calls).toContain('numbers:inst-1/GB')
  })

  it('skips the conditional checks when there are no outputs, and says so', async () => {
    const p = ports()
    const r = await smokeTest(input(), p)
    expect(r.checks.map((c) => c.name))
      .toEqual(['instance', 'contact flow', 'AI agent', 'UK DID'])
    expect(p.calls.some((c) => c.startsWith('rule:'))).toBe(false)
    expect(p.calls.some((c) => c.startsWith('kb:'))).toBe(false)
    expect(r.notes.join(' ')).toContain('conditional checks skipped')
  })

  it('runs each conditional check only when its output key is present', async () => {
    // Key presence in cdk-outputs.json doubles as the feature flag: a stack that
    // was never deployed contributes no key.
    const p = ports()
    const r = await smokeTest(
      input({ outputs: { 'proj-ConnectInstance': { InstanceId: 'inst-1' } } }), p)
    expect(p.calls.some((c) => c.startsWith('rule:'))).toBe(false)
    expect(p.calls.some((c) => c.startsWith('kb:'))).toBe(false)
    expect(byName(r, 'contact-events rule')).toBeUndefined()
    expect(byName(r, 'knowledge base')).toBeUndefined()
    expect(byName(r, 'identity management')).toBeUndefined()
  })

  it('checks identity management only when the deployment expected SAML', async () => {
    const r = await smokeTest(input({
      outputs: { 'proj-ConnectInstance': { IdentityManagementType: 'CONNECT_MANAGED' } },
    }), ports())
    expect(byName(r, 'identity management')).toBeUndefined()
  })

  it('fails a SAML mismatch and says the type is immutable', async () => {
    const r = await smokeTest(input({
      outputs: { 'proj-ConnectInstance': { IdentityManagementType: 'SAML' } },
    }), ports({
      instances: {
        async describe() { return { status: 'ACTIVE', identityManagementType: 'CONNECT_MANAGED' } },
      },
    }))
    expect(r.ok).toBe(false)
    const c = byName(r, 'identity management')!
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('CONNECT_MANAGED')
    expect(c.detail).toContain('immutable')
  })

  it('describes the instance once, serving both the status and identity checks', async () => {
    // Two DescribeInstance calls for one instance was pure bash transliteration.
    const p = ports()
    await smokeTest(input({ outputs: FULL_OUTPUTS }), p)
    expect(p.calls.filter((c) => c.startsWith('describe:'))).toEqual(['describe:inst-1'])
  })

  it('derives the contact-events rule name from the ARN', async () => {
    const p = ports()
    const r = await smokeTest(input({
      outputs: { 'proj-ContactEvents': { RuleArn: 'arn:aws:events:us-east-1:123:rule/my-rule' } },
    }), p)
    expect(p.calls).toContain('rule:my-rule')
    expect(byName(r, 'contact-events rule')!.detail).toContain('my-rule')
  })

  describe('UK DID expectations', () => {
    const noNumbers = { phoneNumbers: { async listClaimed() { return [] } } }

    it('passes when no DID was requested and none exists', async () => {
      const r = await smokeTest(input({ didExpected: false }), ports(noNumbers))
      expect(r.ok).toBe(true)
      expect(byName(r, 'UK DID')).toMatchObject({ status: 'pass' })
      expect(r.phoneNumber).toBeNull()
    })

    it('warns — but stays ok — when a DID was expected and none exists', async () => {
      const r = await smokeTest(input({ didExpected: true }), ports(noNumbers))
      expect(r.ok).toBe(true)
      expect(byName(r, 'UK DID')).toMatchObject({ status: 'warn' })
      expect(byName(r, 'UK DID')!.detail).toContain('claim-did')
      expect(r.phoneNumber).toBeNull()
    })

    it('reports a DID found even when none was requested', async () => {
      const r = await smokeTest(input({ didExpected: false }), ports())
      expect(byName(r, 'UK DID')).toMatchObject({ status: 'pass', detail: '+441134960000' })
      expect(r.phoneNumber).toBe('+441134960000')
    })
  })

})

describe('renderReport', () => {
  it('shows the summary facts and the call-to-action when everything passed', async () => {
    const r = await smokeTest(input({ outputs: FULL_OUTPUTS }), ports())
    const text = renderReport(r).join('\n')
    expect(text).toContain('inst-1')
    expect(text).toContain('+441134960000')
    expect(text).toContain('https://console.aws.amazon.com/connect/v2/app/instances/inst-1')
    expect(text).toContain('Call +441134960000')
  })

  it('lists the failures and prints no summary when a check failed', async () => {
    const r = await smokeTest(input(), ports({
      flows: { async status() { return 'SAVED' } },
    }))
    const text = renderReport(r).join('\n')
    expect(text).toContain('contact flow')
    expect(text).toContain('SAVED')
    expect(text).not.toContain('Admin console')
    expect(text).not.toContain('Call +')
  })

  it('names a missing DID as an advisory rather than a failure', async () => {
    const r = await smokeTest(input({ didExpected: true }),
      ports({ phoneNumbers: { async listClaimed() { return [] } } }))
    const text = renderReport(r).join('\n')
    expect(text).toContain('claim-did')
    expect(text).toContain('Admin console') // still a success report
  })
})

describe('idsFrom', () => {
  // The four ids come from the deploy's own outputs file. A missing one must name
  // itself AND the stack it should have come from — this is the first thing a
  // user hits when they smoke-test before deploying.
  const full = {
    'proj-ConnectInstance': { InstanceId: 'inst-1' },
    'proj-ContactFlow': { ContactFlowId: 'flow-1' },
    'proj-Wisdom': { AssistantId: 'as-1', OrchestrationAgentId: 'ag-1' },
  }

  it('reads all four ids', () => {
    expect(idsFrom(full)).toEqual({
      instanceId: 'inst-1', flowId: 'flow-1', assistantId: 'as-1', agentId: 'ag-1',
    })
  })

  it.each([
    ['InstanceId', 'ConnectInstance', {}],
    ['ContactFlowId', 'ContactFlow', { 'proj-ConnectInstance': { InstanceId: 'inst-1' } }],
    ['AssistantId', 'Wisdom', {
      'proj-ConnectInstance': { InstanceId: 'inst-1' },
      'proj-ContactFlow': { ContactFlowId: 'flow-1' },
    }],
    ['OrchestrationAgentId', 'Wisdom', {
      'proj-ConnectInstance': { InstanceId: 'inst-1' },
      'proj-ContactFlow': { ContactFlowId: 'flow-1' },
      'proj-Wisdom': { AssistantId: 'as-1' },
    }],
  ])('names the missing %s and its stack', (key, stack, outputs) => {
    expect(() => idsFrom(outputs)).toThrow(new CliError(
      `cdk-outputs.json has no ${key} output (stack -${stack}) — deploy first`))
  })
})

describe('csp smoke-test end to end (one spawn, wiring only)', () => {
  // Everything above runs in-process. This single spawn is the only thing that
  // proves main.ts -> program.ts -> smokeTestProject is actually connected.
  const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'csp-smoke-cli-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('fails with the deploy-first hint when cdk-outputs.json is missing', () => {
    let status: number | null = 0
    let stderr = ''
    try {
      execFileSync('npm', ['--silent', '--prefix', cliDir, 'run', 'csp', '--', 'smoke-test', dir],
        { encoding: 'utf8', stdio: 'pipe' })
    } catch (err) {
      const e = err as { status: number | null; stderr: string }
      status = e.status
      stderr = e.stderr
    }
    expect(status).toBe(1)
    expect(stderr).toContain(
      `cdk-outputs.json not found at ${join(dir, 'cdk-outputs.json')} (deploy the project first)`)
  })
})
