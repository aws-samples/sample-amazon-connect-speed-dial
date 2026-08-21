import { Command } from 'commander'
import { CliError } from './lib/errors.js'
import { RED, YELLOW, NC } from './lib/ui.js'
import { buildValues } from './commands/values.js'
import { renderTemplates } from './commands/render/render.js'
import { preflightLive } from './commands/preflight.live.js'
import { synthProject } from './commands/synth.js'
import { cdkDeployAll, stackOutput } from './commands/cdkDeploy.js'
import { deployCommand } from './commands/deploy.js'
import { realDeployPorts } from './commands/deploy.live.js'
import { redeploy } from './commands/redeploy.js'
import { validatePromptsDir } from './commands/render/prompts.js'
import { initPrompts } from './commands/initPrompts.js'
import { claimDidLive } from './commands/claimDid.live.js'
import { syncKbLive } from './commands/syncKb.live.js'
import { smokeTestProject } from './commands/smokeTest.live.js'
import { setupWidgetLive } from './commands/setupWidget.live.js'
import { setupTestUsersLive } from './commands/setupTestUsers.live.js'
import { teardownLive } from './commands/teardown.live.js'

/** Builds the command tree. A FACTORY, not a module-level singleton, and with no
 *  side effects: importing this module must not parse argv or exit. That is what
 *  lets the tests drive the real CLI surface in-process instead of spawning it —
 *  they call exitOverride() on their own instance so commander throws rather
 *  than calling process.exit. */
export function buildProgram(): Command {
  const emitJson = (enabled: boolean, obj: unknown): void => {
    if (enabled) console.log(JSON.stringify(obj))
  }

  const program = new Command()
    .name('csp')
    .description('Connect Skill Project — deployment CLI (single implementation of the deployment pipeline)')
    .version('0.1.0')

  program
    .command('values')
    .description('Derive the render values file from an order file')
    .argument('<order>', 'path to .connect-skill-order.<project>.json')
    .argument('<out>', 'path to write .connect-skill-values.json')
    .option('--json', 'emit a JSON result object as the last stdout line', false)
    .action((order: string, out: string, o: { json: boolean }) => {
      const values = buildValues(order, out)
      emitJson(o.json, { ok: true, valuesFile: out, values })
    })

  program
    .command('render')
    .description('Render the CDK template into a project dir')
    .argument('<values>', 'path to .connect-skill-values.json')
    .argument('<src>', 'template dir (templates/cdk-app)')
    .argument('<dest>', 'rendered project dir')
    .option('--json', 'emit a JSON result object as the last stdout line', false)
    .action((values: string, src: string, dest: string, o: { json: boolean }) => {
      renderTemplates(values, src, dest)
      emitJson(o.json, { ok: true, projectDir: dest })
    })

  program
    .command('preflight')
    .description('Verify credentials, CDK bootstrap, Bedrock access, Identity Center prereqs')
    .argument('[region]', 'us-east-1 or eu-central-1', 'us-east-1')
    .argument('[order-file]', 'order JSON — enables the Identity Center gate')
    .option('--bootstrap', 'run cdk bootstrap if the CDKToolkit stack is missing', false)
    .option('--json', 'emit a JSON result object as the last stdout line', false)
    .action(async (region: string, orderFile: string | undefined, o: { bootstrap: boolean; json: boolean }) => {
      const r = await preflightLive({ region, orderFile, bootstrap: o.bootstrap })
      emitJson(o.json, { ok: true, ...r })
    })

  program
    .command('synth')
    .description('npm ci + type-check + cdk synth in a rendered project (region-pinned)')
    .argument('<project-dir>', 'rendered project dir (csp-<name>)')
    .argument('[region]', 'deploy region', 'us-east-1')
    .option('--json', 'emit a JSON result object as the last stdout line', false)
    .action((projectDir: string, region: string, o: { json: boolean }) => {
      synthProject(projectDir, region)
      emitJson(o.json, { ok: true, projectDir, region })
    })

  program
    .command('cdk-deploy')
    .description('cdk deploy --all with outputs file, region-pinned')
    .argument('<project-dir>', 'rendered project dir')
    .argument('[region]', 'deploy region', 'us-east-1')
    .option('--json', 'emit a JSON result object as the last stdout line', false)
    .action((projectDir: string, region: string, o: { json: boolean }) => {
      const outputs = cdkDeployAll(projectDir, region)
      emitJson(o.json, { ok: true, outputs,
        instanceId: stackOutput(outputs, '-ConnectInstance', 'InstanceId'),
        contactFlowId: stackOutput(outputs, '-ContactFlow', 'ContactFlowId'),
        assistantId: stackOutput(outputs, '-Wisdom', 'AssistantId'),
        orchestrationAgentId: stackOutput(outputs, '-Wisdom', 'OrchestrationAgentId') })
    })

  program
    .command('validate-prompts')
    .description('Validate orchestration.md and self-service.md against the prompt contract')
    .argument('<prompts-dir>', 'directory containing orchestration.md and self-service.md')
    .option('--json', 'emit a JSON result object as the last stdout line', false)
    .action((d: string, o: { json: boolean }) => {
      validatePromptsDir(d)
      console.log(`prompts valid: ${d}`)
      emitJson(o.json, { ok: true, promptsDir: d })
    })

  program
    .command('deploy')
    .description('One-shot deployment: interview (or --order-file) → values → preflight → render → synth → deploy → post-deploy')
    .option('--order-file <file>', 'existing order JSON — skips the interview')
    .option('--express', 'defaults for everything (needs -p)', false)
    .option('-p, --project-name <name>', 'project name (with --express)')
    .option('--claim-uk-did', 'claim a UK phone number after deploy (override)', false)
    .option('--kb-content <pathOrSample>', "knowledge-base content path, or 'sample' (override)")
    .option('--synth-only', 'stop after render + synth — no AWS resources created', false)
    .option('--yes', 'skip the order confirmation', false)
    .action(async (o: Record<string, unknown>) => {
      await deployCommand({
        orderFile: o.orderFile as string | undefined,
        express: Boolean(o.express),
        projectName: o.projectName as string | undefined,
        claimUkDid: Boolean(o.claimUkDid),
        kbContent: o.kbContent as string | undefined,
        synthOnly: Boolean(o.synthOnly),
        yes: Boolean(o.yes),
      }, realDeployPorts())
    })

  program.command('claim-did')
    .description('Claim a UK phone number and attach it to the contact flow')
    .argument('<instance-id>').argument('<flow-id>').argument('[region]', '', 'us-east-1')
    .action(async (i: string, f: string, r: string) => { await claimDidLive(i, f, r) })

  program.command('sync-kb')
    .description('Sync content into the Bedrock knowledge base')
    .argument('<project-dir>').argument('<content-path>')
    .argument('[region]', 'deploy region (default: values-file region, else us-east-1)')
    .action(async (p: string, c: string, r?: string) => { await syncKbLive(p, c, r) })

  program.command('smoke-test')
    .description('Post-deploy smoke test against the live instance (ids read from <project-dir>/cdk-outputs.json)')
    .argument('<project-dir>', 'rendered project dir (csp-<name>)')
    .argument('[region]', 'deploy region (default: values-file region, else us-east-1)')
    .option('--no-did-expected', 'no UK DID was requested — report its absence as ✓ instead of ⚠')
    .action(async (projectDir: string, regionArg: string | undefined, o: { didExpected: boolean }) => {
      await smokeTestProject(projectDir, regionArg, o.didExpected)
    })

  program.command('setup-widget')
    .description('Wire a Connect communication widget into the web-call frontend')
    .argument('<project-dir>').argument('<embed-file>').argument('<security-key>')
    .argument('[region]', 'deploy region (default: values-file region, else us-east-1)')
    .action(async (p: string, e: string, k: string, r?: string) => {
      await setupWidgetLive(p, e, k, r)
    })

  program.command('setup-test-users')
    .description('Create a test sign-in and/or matching Customer Profile')
    .argument('<project-dir>', 'rendered project dir (csp-<name>)')
    .requiredOption('--user <name>', 'username for the Cognito sign-in / profile')
    .requiredOption('--first <name>', 'first name')
    .requiredOption('--last <name>', 'last name')
    .requiredOption('--email <address>', 'email address (receives the temporary password)')
    .requiredOption('--locale <xx-XX>', 'contact locale, e.g. de-DE — becomes the contact LanguageCode')
    .option('--phone <e164>', 'phone number in E.164 (required when Customer Profiles is enabled)')
    .option('--customer-number <n>', 'customer number (required when Customer Profiles is enabled)')
    .action(async (p: string, o: { user: string; first: string; last: string; email: string
      locale: string; phone?: string; customerNumber?: string }) => {
      await setupTestUsersLive({ projectDir: p, username: o.user, first: o.first, last: o.last,
        email: o.email, phone: o.phone, customerNumber: o.customerNumber, locale: o.locale })
    })

  program.command('init-prompts')
    .description('Seed editable agent-prompt files into the working dir (never clobbers edits)')
    .argument('[working-dir]', '', process.cwd())
    .action((w: string) => { initPrompts(w) })

  program.command('teardown')
    .description('DESTRUCTIVE full cleanup: cdk destroy + sweep of retained resources (typed confirmation; FORCE_TEARDOWN=1 skips)')
    .argument('<project>', 'project name (→ csp-<name>) or rendered project dir')
    .argument('[region]', 'deploy region (default: values-file region, else AWS_REGION/AWS_DEFAULT_REGION, else us-east-1)')
    .action(async (p: string, r?: string) => { await teardownLive(p, r) })

  program.command('redeploy')
    .description('Re-render from templates and redeploy (order/values/prompts survive)')
    .argument('<project-dir>', 'rendered project dir (csp-<name>)')
    .option('--stack <suffix>', 'deploy only <project>-<suffix> (default: all stacks)')
    .action((p: string, o: { stack?: string }) => { redeploy(p, { stack: o.stack }) })

  return program
}

/** Formats a failure the way the CLI contracts require and returns the exit
 *  code. Separated from runMain so it can be tested without killing the runner. */
export function reportError(err: unknown): number {
  if (err instanceof CliError) {
    console.error(`${RED}✗ ${err.message}${NC}`)
    return 1
  }
  // Anything else is an unexpected failure — most often an AWS SDK exception
  // escaping an adapter. Rethrowing dumped 25 lines of SDK internals on the
  // single most common real failure (expired credentials), where preflight has a
  // one-line message for exactly the same condition. Print the cause, add the
  // hint that resolves it, and keep the stack behind CSP_DEBUG.
  const name = (err as { name?: string })?.name ?? ''
  const message = err instanceof Error ? err.message : String(err)
  const credentialish = /Token|Credential|Expired|AccessDenied|Unrecognized|NotAuthorized/i
    .test(`${name} ${message}`)
  console.error(`${RED}✗ ${name && name !== 'Error' ? `${name}: ` : ''}${message}${NC}`)
  if (credentialish) {
    console.error(`${YELLOW}Check your AWS credentials and region `
      + `(aws sso login / AWS_PROFILE / AWS_REGION), then retry.${NC}`)
  }
  if (process.env.CSP_DEBUG) console.error(err)
  else console.error(`${YELLOW}Set CSP_DEBUG=1 for the full stack trace.${NC}`)
  return 1
}

export async function runMain(argv: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(argv)
  } catch (err) {
    process.exit(reportError(err))
  }
}
