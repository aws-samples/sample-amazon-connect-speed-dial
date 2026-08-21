import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CliError } from '../lib/errors.js'
import { ok, info, warn, readJsonFile, readJsonObject } from '../lib/ui.js'
import { parseOrder, deriveValues } from '../core/schema.js'
import type { Identity, Models, SsoInstances, Stacks, Toolchain } from '../core/ports.js'

/** The bootstrap stack CDK creates; its presence is the bootstrap check. */
const CDK_TOOLKIT_STACK = 'CDKToolkit'

export interface PreflightOptions {
  region: string
  orderFile?: string
  bootstrap: boolean
}
export interface PreflightPorts {
  identity: Identity
  /** Only the bootstrap-stack probe. */
  stacks: Pick<Stacks, 'exists'>
  models: Models
  sso: SsoInstances
  /** preflight only probes and bootstraps; it deploys nothing. */
  toolchain: Pick<Toolchain, 'cdkAvailable' | 'bootstrap'>
}
export interface PreflightResult { account: string; region: string; warnings: string[] }

export async function runPreflight(opts: PreflightOptions, aws: PreflightPorts): Promise<PreflightResult> {
  const { region } = opts
  const warnings: string[] = []
  if (region !== 'us-east-1' && region !== 'eu-central-1') {
    throw new CliError(`unsupported region '${region}' (use us-east-1 or eu-central-1)`)
  }

  info('Checking AWS credentials...')
  const account = await aws.identity.accountIdOrNull()
  if (!account) throw new CliError("AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE.")
  ok(`AWS credentials valid (Account: ${account})`)

  info('Checking CDK installation...')
  if (!(await aws.toolchain.cdkAvailable())) {
    throw new CliError("CDK not installed. Run 'npm install -g aws-cdk@2.1135.0' or 'npm install'.")
  }
  ok('CDK available')

  info(`Checking CDK bootstrap state in ${region}...`)
  if (await aws.stacks.exists(CDK_TOOLKIT_STACK)) {
    ok(`CDK bootstrap verified in ${region}`)
  } else if (opts.bootstrap) {
    warn(`CDKToolkit stack not found in ${region}. Bootstrapping...`)
    await aws.toolchain.bootstrap(account)
    ok('CDK bootstrap completed')
  } else {
    // Bootstrapping mutates the account, so it never happens implicitly inside
    // a command whose job is to *check*. --bootstrap is the opt-in.
    throw new CliError(`CDKToolkit stack not found in ${region} — rerun with --bootstrap to bootstrap it`)
  }

  // The model ids this order will actually deploy, so the check covers every
  // enablement the deployment needs rather than just the historical Nova probe.
  let orderModelIds: string[] | undefined
  if (opts.orderFile && existsSync(opts.orderFile)) {
    try {
      const v = deriveValues(parseOrder(readJsonFile(opts.orderFile, 'order file')))
      orderModelIds = [v.orchestrationModelId, v.answerGenModelId, v.kbParsingModelId]
    } catch { /* unreadable/invalid order → fall back to the Nova probe alone */ }
  }

  // BOTH models the deployment derives, not just Nova Pro: the orchestration
  // agent runs on Claude Haiku (schema.ts deriveValues), so an account with only
  // Nova Pro enabled used to pass preflight and then fail at conversation time,
  // which is a far more expensive place to find out. Inference-profile ids carry
  // a regional prefix (us./eu.) that GetFoundationModel does not accept — strip
  // it back to the base model id for the check.
  const models = [
    process.env.NOVA_MODEL_ID || 'amazon.nova-pro-v1:0',
    ...(orderModelIds ?? []),
  ].map((id) => id.replace(/^(us|eu)\./, ''))
  for (const model of [...new Set(models)]) {
    info(`Checking Bedrock model access for ${model} in ${region}...`)
    if (await aws.models.accessible(model)) {
      ok(`Bedrock model ${model} accessible`)
    } else {
      throw new CliError(
        `Bedrock model ${model} not accessible\n\nPlease enable model access in the Bedrock console:\n` +
        `  https://console.aws.amazon.com/bedrock/home?region=${region}#/modelaccess`)
    }
  }

  // Identity Center prerequisites (only when the order enables it). The
  // identity management type is IMMUTABLE after instance creation, and synth
  // requires saml-metadata.xml — both must be settled BEFORE render/deploy.
  if (opts.orderFile && existsSync(opts.orderFile)) {
    let idcEnabled = false
    try {
      idcEnabled = readJsonObject(opts.orderFile, 'order file').identityCenterEnabled === true
    } catch { /* an unreadable order leaves the Identity Center gate off */ }
    if (idcEnabled) {
      info('Identity Center is enabled — checking prerequisites...')
      const workDir = dirname(resolve(opts.orderFile))
      const saml = join(workDir, 'saml-metadata.xml')
      if (!existsSync(saml)) {
        throw new CliError(
          `saml-metadata.xml not found at ${saml} — complete the manual Identity Center step first ` +
          '(the identity type cannot be changed after the instance is created)\n' +
          'Identity Center SSO requires a MANUAL step before deployment:\n' +
          '  1. IAM Identity Center console → Applications → Add application\n' +
          "     → 'Add custom SAML 2.0 application' (or the Amazon Connect catalog app)\n" +
          "  2. Download the 'IAM Identity Center SAML metadata file'\n" +
          `  3. Save it as: ${saml}`)
      }
      if (!readFileSync(saml, 'utf8').includes('EntityDescriptor')) {
        throw new CliError(
          'saml-metadata.xml exists but does not look like SAML metadata (no EntityDescriptor element). ' +
          'Re-download it from: IAM Identity Center → Applications → your Connect app → IAM Identity Center metadata')
      }
      ok('saml-metadata.xml found and looks like SAML metadata')
      if (await aws.sso.visible()) {
        ok('IAM Identity Center instance visible from this account')
      } else {
        const w = "No Identity Center instance visible from this account/region — fine if Identity Center lives in your organization's management account (the SAML flow is browser-based and needs no cross-account trust)"
        warn(w); warnings.push(w)
      }
    }
  }

  console.log()
  ok('All preflight checks passed!')
  return { account, region, warnings }
}
