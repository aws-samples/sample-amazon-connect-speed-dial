import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CliError } from '../lib/errors.js'
import { validateProjectName } from '../core/schema.js'
import { initPrompts } from './initPrompts.js'
import type { Prefs } from '../core/prefs.js'
import type { Prompt } from '../core/ports.js'
import { info, warn, BOLD, YELLOW, NC } from '../lib/ui.js'

// The deployment interview. stdin arrives through the Prompt port, so every
// branch here — the choice re-prompts, the reach mapping, the knowledge-base
// mapping — is testable without a terminal.

const YES = ['y', 'yes', 'true', '1']
const NO = ['n', 'no', 'false', '0']

async function ask(prompt: Prompt, question: string, opts: {
  default?: string; choices?: string[]; validate?: (v: string) => string | null
} = {}): Promise<string> {
  let suffix = ''
  if (opts.choices) suffix = ` (${opts.choices.join('/')})`
  if (opts.default !== undefined) suffix += ` [${opts.default}]`
  for (;;) {
    let raw = (await prompt.ask(`${BOLD}${question}${suffix}: ${NC}`)).trim()
    if (!raw && opts.default !== undefined) raw = opts.default
    if (opts.choices && !opts.choices.includes(raw)) {
      warn(`choose one of: ${opts.choices.join(', ')}`)
      continue
    }
    if (opts.validate) {
      const err = opts.validate(raw)
      if (err) { warn(err); continue }
    }
    return raw
  }
}

async function askBool(prompt: Prompt, question: string, def = false): Promise<boolean> {
  const hint = def ? 'Y/n' : 'y/N'
  // Re-prompt on anything unrecognized, like ask() does. Treating unknown input
  // as "no" meant a typo ('yse', 'yes please') silently turned a [Y/n] default
  // ON option — Customer Profiles, most importantly — off.
  for (;;) {
    const raw = (await prompt.ask(`${BOLD}${question} [${hint}]: ${NC}`)).trim().toLowerCase()
    if (!raw) return def
    if (YES.includes(raw)) return true
    if (NO.includes(raw)) return false
    console.log(`${YELLOW}  answer y or n (Enter for the default: ${def ? 'yes' : 'no'})${NC}`)
  }
}

export interface InterviewOptions {
  express: boolean
  projectName?: string
  /** Where prompt files are seeded and saml-metadata.xml is expected.
   *  Defaults to the cwd; injected so tests never write into the real one. */
  workingDir?: string
}

export async function interview(opts: InterviewOptions, prompt: Prompt):
Promise<{ orderRaw: Record<string, unknown>; prefs: Prefs }> {
  const workingDir = opts.workingDir ?? process.cwd()
  {
    console.log(`\n${BOLD}=== Amazon Connect blueprint — deployment interview ===${NC}\n`)

    let projectName = opts.projectName
    if (!projectName) {
      projectName = await ask(prompt, 'Project name', {
        validate: (v) => v ? validateProjectName(v) : 'project name is required',
      })
    } else {
      const err = validateProjectName(projectName)
      if (err) throw new CliError(`invalid project name '${projectName}': ${err}`)
    }
    const orderRaw: Record<string, unknown> = { projectName }
    const prefs: Prefs = { claimUkDid: false, kbContent: 'skip', kbContentPath: '' }

    if (opts.express) {
      prefs.claimUkDid = true
      info('Express mode: defaults for everything else (us-east-1, English, feminine voice, '
        + 'default add-ons — Customer Profiles on, everything else off — UK number claimed).')
      return { orderRaw, prefs }
    }

    orderRaw.companyName = await ask(prompt, 'Company name', { default: 'My Company' })
    orderRaw.region = await ask(prompt, 'Region', { default: 'us-east-1', choices: ['us-east-1', 'eu-central-1'] })
    orderRaw.language = await ask(prompt, 'Language', { default: 'en', choices: ['en', 'de'] })
    orderRaw.voiceGender = await ask(prompt, 'Voice', { default: 'feminine', choices: ['feminine', 'masculine'] })

    if (await askBool(prompt, "Customize the AI agent's prompts (persona/instructions)?")) {
      initPrompts(workingDir)
      console.log(`  Edit ${workingDir}/prompts/orchestration.md and/or self-service.md now.\n`
        + '  Keep the required scaffolding (system: block, {{$.conversationHistory}},\n'
        + '  <message> tag, {{$.contentExcerpt}}) — the render step validates it.')
      await prompt.ask(`${BOLD}  Press Enter when done editing (or immediately to keep defaults): ${NC}`)
    }

    console.log(`\n${BOLD}Add-on capabilities${NC} (any combination):`)
    info('Human transfer and tool calling are always included; a recording-consent module '
      + 'deploys unwired (enable it in the flow designer).')
    orderRaw.customerProfilesEnabled = await askBool(prompt, '  Customer Profiles (caller lookup)?', true)
    orderRaw.dataLakeEnabled = await askBool(prompt, '  Analytics data lake?')
    orderRaw.contactEventsEnabled = await askBool(prompt, '  Contact-events logging (EventBridge)?')
    orderRaw.knowledgeBaseEnabled = await askBool(prompt, '  Knowledge base (Bedrock RAG)?')
    if (orderRaw.knowledgeBaseEnabled) {
      const choice = await ask(prompt, '    KB content: (a) sample data, (b) add data from disk, (c) empty',
        { default: 'a', choices: ['a', 'b', 'c'] })
      prefs.kbContent = ({ a: 'sample', b: 'path', c: 'skip' } as const)[choice as 'a' | 'b' | 'c']
      if (prefs.kbContent === 'path') {
        prefs.kbContentPath = await ask(prompt, '    Path to your content folder/file',
          { validate: (v) => existsSync(v) ? null : 'path not found' })
      }
    }

    const reach = await ask(prompt,
      'How will you reach the agent? (a) UK phone number, (b) web-call frontend, (c) manual',
      { default: 'a', choices: ['a', 'b', 'c'] })
    prefs.claimUkDid = reach === 'a'
    orderRaw.frontendEnabled = reach === 'b'

    info('Data-bearing resources are RETAINED on stack destroy by default '
      + '(retainData in the order file — advanced toggle, not asked here).')
    info('Stored data (recordings, transcripts, reports, profiles) is always '
      + 'encrypted with a customer-managed KMS key.')
    const idc = await askBool(prompt,
      'Sign in via IAM Identity Center SSO instead of Connect-managed users?\n'
      + `  ${YELLOW}IRREVERSIBLE at instance creation — switching later means recreating the instance${NC}\n `)
    orderRaw.identityCenterEnabled = idc
    if (idc) {
      console.log(`\n${YELLOW}Manual step required BEFORE deploy:${NC}\n`
        + '  1. IAM Identity Center console → Applications → Add application\n'
        + '  2. Download the SAML metadata file\n'
        + `  3. Save it as: ${join(workingDir, 'saml-metadata.xml')}\n`
        + 'Preflight will verify the file exists.\n')
    }
    return { orderRaw, prefs }
  }
}

export async function confirmOrder(
  orderRaw: Record<string, unknown>, prefs: Prefs, account: string | null, prompt: Prompt,
): Promise<boolean> {
  console.log(`\n${BOLD}Your order:${NC}`)
  console.log(JSON.stringify(orderRaw, null, 2))
  const reach = prefs.claimUkDid ? 'UK phone number'
    : orderRaw.frontendEnabled ? 'web-call frontend' : 'manual'
  console.log(`Reach: ${reach} | KB content: ${prefs.kbContent}`)
  if (account) {
    console.log(`Deploy to AWS account: ${account} (${orderRaw.region ?? 'us-east-1'})`)
  }
  const raw = (await prompt.ask(`${BOLD}Place this order? [Y/n]: ${NC}`)).trim().toLowerCase()
  return !raw || YES.includes(raw)
}
