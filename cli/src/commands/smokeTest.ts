import { CliError } from '../lib/errors.js'
import { GREEN, RED, YELLOW, NC } from '../lib/ui.js'
import { outputBySuffix } from './shared.js'
import type { CdkOutputs } from './cdkDeploy.js'
import type {
  AiAgents, ConnectInstances, ContactFlows, EventRules, InstanceDescription,
  KnowledgeBases, PhoneNumbers,
} from '../core/ports.js'

// Verify a deployed contact center. The command COLLECTS findings and returns
// them; it prints nothing and throws only on invalid input. Rendering is
// renderReport(); deciding the exit code is the caller's.
//
// Four checks always run. Three more are conditional on cdk-outputs.json: a
// stack that was never deployed contributes no key, so key presence doubles as
// the feature flag.

/** UK numbers are what this blueprint claims; the port stays country-agnostic. */
const UK = 'GB'

export interface SmokeTestInput {
  instanceId: string
  flowId: string
  assistantId: string
  agentId: string
  region: string
  /** False when the deployment deliberately has no DID (web-call or manual reach). */
  didExpected: boolean
  /** Parsed cdk-outputs.json. Absent → the conditional checks are skipped.
   *  Already validated by readCdkOutputs at the file boundary. */
  outputs?: CdkOutputs
}

export interface SmokeTestPorts {
  /** One describe serves both the status and identity checks. */
  instances: Pick<ConnectInstances, 'describe'>
  flows: ContactFlows
  agents: Pick<AiAgents, 'status'>
  /** Only the read is needed — smoke-test never claims anything. */
  phoneNumbers: Pick<PhoneNumbers, 'listClaimed'>
  rules: EventRules
  /** Only the status read — smoke-test never ingests. */
  knowledgeBases: Pick<KnowledgeBases, 'status'>
}

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
}

export interface SmokeTestReport {
  checks: Check[]
  /** Why something was not checked at all. Never a failure. */
  notes: string[]
  ids: { instanceId: string; flowId: string; assistantId: string; agentId: string }
  phoneNumber: string | null
  didExpected: boolean
  /** True when no check failed. A 'warn' does not sink the run. */
  ok: boolean
}

export interface DeployedIds {
  instanceId: string
  flowId: string
  assistantId: string
  agentId: string
}

/** The four ids a deployed project exposes, read from its cdk-outputs.json. A
 *  missing output names itself and the stack it should have come from — this is
 *  the first thing a user hits when they smoke-test before deploying. */
export function idsFrom(outputs: CdkOutputs): DeployedIds {
  const need = (suffix: string, key: string): string => {
    const value = outputBySuffix(outputs, suffix, key)
    if (!value) {
      throw new CliError(`cdk-outputs.json has no ${key} output (stack -${suffix}) — deploy first`)
    }
    return value
  }
  return {
    instanceId: need('ConnectInstance', 'InstanceId'),
    flowId: need('ContactFlow', 'ContactFlowId'),
    assistantId: need('Wisdom', 'AssistantId'),
    agentId: need('Wisdom', 'OrchestrationAgentId'),
  }
}

/** Ids may arrive as ARNs, and an AI-agent id may carry a `:version` suffix.
 *  Both reduce to the bare id: the part after the last '/', minus the version. */
export const bareId = (v: string): string => v.slice(v.lastIndexOf('/') + 1).split(':')[0]

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const expectStatus = (name: string, actual: string, allowed: string[]): Check =>
  allowed.includes(actual)
    ? { name, status: 'pass', detail: actual }
    : { name, status: 'fail', detail: `${actual} (expected ${allowed.join(' or ')})` }

// Inputs arrive already validated — from idsFrom() on the CLI path, or from the
// deploy's own outputs in deploy.ts — so there is no second runtime check here.
// See AGENTS.md: validate where data enters the program, not at every hop.
export async function smokeTest(args: SmokeTestInput, aws: SmokeTestPorts): Promise<SmokeTestReport> {
  const ids = {
    instanceId: bareId(args.instanceId),
    flowId: bareId(args.flowId),
    assistantId: bareId(args.assistantId),
    agentId: bareId(args.agentId),
  }

  const checks: Check[] = []
  const notes: string[] = []

  // A port that throws is a failed check carrying the real cause — not a
  // sentinel string. One root cause produces one failure.
  const attempt = async (name: string, fn: () => Promise<Check>): Promise<void> => {
    try {
      checks.push(await fn())
    } catch (err) {
      checks.push({ name, status: 'fail', detail: messageOf(err) })
    }
  }

  // One DescribeInstance serves both the status check and the identity check.
  let instance: InstanceDescription | null = null
  try {
    instance = await aws.instances.describe(ids.instanceId)
    checks.push(expectStatus('instance', instance.status, ['ACTIVE']))
  } catch (err) {
    checks.push({ name: 'instance', status: 'fail', detail: messageOf(err) })
  }

  await attempt('contact flow', async () =>
    expectStatus('contact flow', await aws.flows.status(ids.instanceId, ids.flowId), ['PUBLISHED']))

  await attempt('AI agent', async () =>
    expectStatus('AI agent', await aws.agents.status(ids.assistantId, ids.agentId),
      ['ACTIVE', 'CREATE_COMPLETE']))

  // A number's TargetArn is always the *instance* ARN — the number-to-flow
  // binding is not visible here, so the verifiable condition is "a GB number is
  // claimed on this instance".
  let phoneNumber: string | null = null
  await attempt('UK DID', async () => {
    const [claimed] = await aws.phoneNumbers.listClaimed(ids.instanceId, UK)
    if (claimed) {
      phoneNumber = claimed.phoneNumber
      return { name: 'UK DID', status: 'pass', detail: claimed.phoneNumber }
    }
    return args.didExpected
      ? { name: 'UK DID', status: 'warn', detail: 'none claimed — run `csp claim-did` to receive calls' }
      : { name: 'UK DID', status: 'pass', detail: 'none — not requested' }
  })

  if (!args.outputs) {
    notes.push('no cdk-outputs.json — conditional checks skipped '
      + '(contact events, identity management, knowledge base)')
    return finish(checks, notes, ids, phoneNumber, args.didExpected)
  }

  const ruleArn = outputBySuffix(args.outputs, 'ContactEvents', 'RuleArn')
  if (ruleArn) {
    await attempt('contact-events rule', async () => {
      const ruleName = bareId(ruleArn)
      const state = await aws.rules.state(ruleName)
      return state === 'ENABLED'
        ? { name: 'contact-events rule', status: 'pass', detail: `ENABLED (${ruleName})` }
        : { name: 'contact-events rule', status: 'fail',
            detail: `${state} (expected ENABLED, rule ${ruleName})` }
    })
  }

  // The identity type is IMMUTABLE after instance creation, so a mismatch is
  // reported loudly rather than as a warning.
  if (outputBySuffix(args.outputs, 'ConnectInstance', 'IdentityManagementType') === 'SAML') {
    if (!instance) {
      notes.push('identity management not checked — the instance could not be described')
    } else {
      checks.push(instance.identityManagementType === 'SAML'
        ? { name: 'identity management', status: 'pass', detail: 'SAML' }
        : { name: 'identity management', status: 'fail',
            detail: `${instance.identityManagementType} (expected SAML — the type is immutable; `
              + 'recreating the instance is the only fix)' })
    }
  }

  const kbId = outputBySuffix(args.outputs, 'Wisdom', 'BedrockKnowledgeBaseId')
  if (kbId) {
    await attempt('knowledge base', async () => {
      const status = await aws.knowledgeBases.status(kbId)
      return status === 'ACTIVE'
        ? { name: 'knowledge base', status: 'pass', detail: `ACTIVE (${kbId})` }
        : { name: 'knowledge base', status: 'fail', detail: `${status} (expected ACTIVE, kb ${kbId})` }
    })
  }

  return finish(checks, notes, ids, phoneNumber, args.didExpected)
}

function finish(
  checks: Check[], notes: string[], ids: SmokeTestReport['ids'],
  phoneNumber: string | null, didExpected: boolean,
): SmokeTestReport {
  return { checks, notes, ids, phoneNumber, didExpected, ok: !checks.some((c) => c.status === 'fail') }
}

const MARK: Record<CheckStatus, string> = {
  pass: `${GREEN}✓${NC}`,
  warn: `${YELLOW}⚠${NC}`,
  fail: `${RED}✗${NC}`,
}

export function renderReport(r: SmokeTestReport): string[] {
  const width = Math.max(...r.checks.map((c) => c.name.length))
  const lines = [`Smoke test — ${r.checks.length} checks`]
  for (const c of r.checks) lines.push(`  ${MARK[c.status]} ${c.name.padEnd(width)}  ${c.detail}`)
  for (const n of r.notes) lines.push(`  ${YELLOW}·${NC} ${n}`)
  lines.push('')

  if (!r.ok) {
    const failed = r.checks.filter((c) => c.status === 'fail').map((c) => c.name)
    lines.push(`${RED}✗ Smoke test failed: ${failed.join(', ')}${NC}`)
    return lines
  }

  lines.push(`Instance       ${r.ids.instanceId}`)
  lines.push(`Flow           ${r.ids.flowId}`)
  lines.push(`AI agent       ${r.ids.agentId}`)
  lines.push(`Phone          ${r.phoneNumber ?? '(none)'}`)
  lines.push('Admin console  '
    + `https://console.aws.amazon.com/connect/v2/app/instances/${r.ids.instanceId}`)
  lines.push('')
  lines.push(r.phoneNumber
    ? `${GREEN}✓ All checks passed. Call ${r.phoneNumber} to test the voice agent.${NC}`
    : `${GREEN}✓ All checks passed.${NC}`)
  return lines
}
