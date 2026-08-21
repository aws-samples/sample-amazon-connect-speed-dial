import { existsSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError } from '../lib/errors.js'
import { parseOrder } from '../core/schema.js'
import { buildValues, serializeJson } from './values.js'
import { stackOutput, type CdkOutputs } from './cdkDeploy.js'
import { prefsFromOrder, foldFlagsIntoOrder, type Prefs } from '../core/prefs.js'
import { nextStepsText } from './nextSteps.js'
import { ok, warn, readJsonObject, YELLOW, NC } from '../lib/ui.js'
import type { PreflightOptions, PreflightResult } from './preflight.js'
import type { SmokeTestInput } from './smokeTest.js'

// cli/src/commands/deploy.ts → repo root is three levels up.
const SKILL_DIR = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const TEMPLATES = join(SKILL_DIR, 'templates', 'cdk-app')

/** Every step of the pipeline that touches AWS, the filesystem beyond the order
 *  file, or a subprocess. Injected so the whole command is testable: without
 *  this seam a test that got past the order gates ran `cdk deploy --all` for
 *  real. Everything else deployCommand uses (parseOrder, buildValues, prefs,
 *  nextStepsText) is pure and stays a direct call. */
export interface DeployPorts {
  interview(opts: { express: boolean; projectName?: string }):
    Promise<{ orderRaw: Record<string, unknown>; prefs: Prefs }>
  confirmOrder(orderRaw: Record<string, unknown>, prefs: Prefs, account: string): Promise<boolean>
  callerAccount(region: string): Promise<string | null>
  preflight(opts: PreflightOptions): Promise<PreflightResult>
  render(valuesPath: string, templatesDir: string, projectDir: string): void
  synth(projectDir: string, region: string): void
  deployAll(projectDir: string, region: string): CdkOutputs
  claimDid(instanceId: string, flowId: string, region: string): Promise<void>
  syncKb(projectDir: string, contentPath: string, region: string): Promise<void>
  smokeTest(input: SmokeTestInput): Promise<void>
}

export interface DeployOptions {
  orderFile?: string
  express: boolean
  projectName?: string
  claimUkDid: boolean
  kbContent?: string
  synthOnly: boolean
  yes: boolean
}

function relToCwd(p: string): string {
  const rel = relative(process.cwd(), resolve(p))
  return rel.startsWith('..') ? p : rel
}

/**
 * How a user invokes this CLI, given the path to the `cli/` package. There is
 * no launcher script any more — `csp` is an npm script — so every command we
 * print has to carry npm's own flags: `--silent` keeps npm's banner off stdout,
 * `--prefix` locates the package from any cwd, and `--` hands the rest through.
 */
const cspCmd = (cliDir: string): string => `npm --silent --prefix ${cliDir} run csp --`

export async function deployCommand(opts: DeployOptions, deps: DeployPorts): Promise<void> {
  const cwd = process.cwd()
  const flags = { claimUkDid: opts.claimUkDid || undefined, kbContent: opts.kbContent }

  // --- 1. Order: interview, or load an existing file ---
  let orderRaw: Record<string, unknown>
  let prefs: Prefs
  let orderPath: string
  if (opts.orderFile) {
    orderPath = opts.orderFile
    if (!existsSync(orderPath)) throw new CliError(`order file not found: ${orderPath}`)
    orderRaw = readJsonObject(orderPath, 'order file')
    if (!orderRaw.projectName) throw new CliError('order file has no projectName')
    prefs = prefsFromOrder(orderRaw, flags)
    const updated = foldFlagsIntoOrder(orderRaw, flags)
    if (updated) {
      orderRaw = updated
      writeFileSync(orderPath, serializeJson(orderRaw))
      ok(`Order file updated with CLI overrides: ${orderPath}`)
    }
  } else {
    ;({ orderRaw, prefs } = await deps.interview({
      express: opts.express, projectName: opts.projectName }))
    orderPath = join(cwd, `.connect-skill-order.${orderRaw.projectName}.json`)
    if (!opts.yes) {
      const account = await deps.callerAccount(String(orderRaw.region ?? 'us-east-1'))
      if (!(await deps.confirmOrder(orderRaw, prefs, account ?? ''))) {
        console.log('aborted by user'); return
      }
    }
    // Persist orchestration prefs so a rerun with --order-file reproduces the
    // exact same deployment, no extra flags.
    orderRaw.claimUkDid = prefs.claimUkDid
    if (prefs.kbContent === 'sample') orderRaw.kbContent = 'sample'
    else if (prefs.kbContent === 'path') orderRaw.kbContent = prefs.kbContentPath
    writeFileSync(orderPath, serializeJson(orderRaw))
    ok(`Order written: ${orderPath}`)
  }

  const rerunHint = `${cspCmd(relToCwd(join(SKILL_DIR, 'cli')))} deploy --order-file ${relToCwd(orderPath)}`

  // Fail before the 20-minute deploy, not after it: the interview validates the
  // knowledge-base path as it is typed, but --kb-content / an order file's
  // kbContent reached syncKb unchecked, so a typo surfaced only once every
  // stack was already deployed and billing.
  if (prefs.kbContent === 'path' && !existsSync(prefs.kbContentPath)) {
    throw new CliError(`knowledge-base content path not found: ${prefs.kbContentPath}`)
  }

  try {
    const order = parseOrder(orderRaw) // full validation before any AWS action
    const project = order.projectName
    const region = order.region
    const projectDir = join(cwd, `csp-${project}`)
    const valuesPath = join(projectDir, '.connect-skill-values.json')

    // --- 2. Values → 3. Preflight → 4. Render → 5. Synth ---
    const values = buildValues(orderPath, valuesPath)
    await deps.preflight({ region, orderFile: orderPath, bootstrap: true })
    deps.render(valuesPath, TEMPLATES, projectDir)
    deps.synth(projectDir, region)
    if (opts.synthOnly) {
      ok('Synth complete (--synth-only) — no AWS resources created.')
      return
    }

    // --- 6. Deploy ---
    const outputs = deps.deployAll(projectDir, region)
    const instanceId = stackOutput(outputs, '-ConnectInstance', 'InstanceId')
    const flowId = stackOutput(outputs, '-ContactFlow', 'ContactFlowId')
    const assistantId = stackOutput(outputs, '-Wisdom', 'AssistantId')
    const agentId = stackOutput(outputs, '-Wisdom', 'OrchestrationAgentId')

    // Steps 7-9 run AFTER a successful `cdk deploy --all`: the infrastructure
    // exists and is billing. A failure here must not swallow the next-steps
    // checklist — it carries the one REQUIRED manual step (publishing the
    // orchestration agent, without which tool calling stays inert) and there is
    // no other place the user is told about it. Collect failures, print the
    // checklist, then exit non-zero.
    const softFailures: string[] = []
    const soft = async (label: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warn(`${label} failed: ${message}`)
        softFailures.push(label)
      }
    }

    // --- 7./8. Optional: UK DID + knowledge base ---
    if (prefs.claimUkDid && instanceId && flowId) {
      await soft('claim UK DID', () => deps.claimDid(instanceId, flowId, region))
    }
    if (order.knowledgeBaseEnabled && prefs.kbContent !== 'skip') {
      const content = prefs.kbContentPath || join(SKILL_DIR, 'sample-data')
      await soft('knowledge-base sync', () => deps.syncKb(projectDir, content, region))
    }

    // --- 9. Smoke test ---
    if (instanceId && flowId && assistantId && agentId) {
      // No DID requested → its absence is expected, not a warning.
      // The outputs came back from the deploy — pass them rather than
      // re-reading the file.
      await soft('smoke test', () => deps.smokeTest({
        instanceId, flowId, assistantId, agentId, region, outputs,
        didExpected: prefs.claimUkDid }))
    } else {
      warn('could not resolve all IDs from cdk-outputs.json — smoke test skipped')
    }

    // --- 10. Next steps ---
    console.log(nextStepsText({
      orderRaw, prefs, outputs, project, region, cwd, projectDir,
      cspPath: cspCmd(join(SKILL_DIR, 'cli')), locale: values.ttsLanguageCode || 'en-US',
    }))

    if (softFailures.length > 0) {
      warn(`deployment complete, but ${softFailures.length} post-deploy step(s) failed: `
        + `${softFailures.join(', ')} — the stacks are deployed; re-run the step(s) above.`)
      process.exitCode = 1
    }
  } catch (err) {
    if (err instanceof CliError) {
      err.message += `\n\n${YELLOW}Once fixed, restart the deployment with:${NC}\n  ${rerunHint}`
    }
    throw err
  }
}
