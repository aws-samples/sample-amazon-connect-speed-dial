import type { PreflightOptions, PreflightResult } from './preflight.js'

// Wiring for `csp preflight`. No top-level `@aws-sdk/*` or adapter import —
// main.ts imports this statically.

export async function preflightLive(opts: PreflightOptions): Promise<PreflightResult> {
  const { region } = opts
  const [{ runPreflight }, sts, cfn, bedrock, ssoAdmin, system] = await Promise.all([
    import('./preflight.js'),
    import('../adapters/sts.js'),
    import('../adapters/cloudformation.js'),
    import('../adapters/bedrock.js'),
    import('../adapters/ssoAdmin.js'),
    import('../adapters/system.js'),
  ])
  return runPreflight(opts, {
    identity: sts.stsIdentity(region),
    stacks: cfn.cfnStacks(region),
    models: bedrock.bedrockModels(region),
    sso: ssoAdmin.ssoAdminInstances(region),
    toolchain: system.cdkToolchain(region),
  })
}

/** The account this run is using, or null. The order-confirmation gate's only
 *  AWS need, kept here so deploy.ts imports no adapter. */
export async function callerAccountLive(region: string): Promise<string | null> {
  const { stsIdentity } = await import('../adapters/sts.js')
  return stsIdentity(region).accountIdOrNull()
}
