import { SKILL_ROOT, resolveRegion } from './shared.js'
import { resolveTeardownProjectDir } from './teardown.js'

// Wiring for `csp teardown`. No top-level `@aws-sdk/*` or adapter import.

export async function teardownLive(arg: string, regionArg?: string): Promise<void> {
  // Region precedence: explicit arg → values file (build-values writes `region`)
  // → AWS_REGION/AWS_DEFAULT_REGION → us-east-1. Never default silently: an
  // eu-central-1 deployment's resources resolve as "does not exist" from
  // us-east-1 even though they are real, and teardown would report success.
  const projectDir = resolveTeardownProjectDir(arg, SKILL_ROOT)
  const region = resolveRegion(projectDir, regionArg, true)

  const [{ teardown }, sts, connect, qconnect, cfn, s3, ddb, kms, appint, system] =
    await Promise.all([
      import('./teardown.js'),
      import('../adapters/sts.js'),
      import('../adapters/connect.js'),
      import('../adapters/qconnect.js'),
      import('../adapters/cloudformation.js'),
      import('../adapters/s3.js'),
      import('../adapters/dynamodb.js'),
      import('../adapters/kms.js'),
      import('../adapters/appIntegrations.js'),
      import('../adapters/system.js'),
    ])

  await teardown(arg, region, {
    identity: sts.stsIdentity(region),
    prompt: system.stdinPrompt,
    toolchain: system.cdkToolchain(region),
    instances: connect.connectInstances(region),
    securityProfiles: connect.connectSecurityProfiles(region),
    agents: qconnect.qConnectAiAgents(region),
    stacks: cfn.cfnStacks(region),
    storage: s3.s3ObjectStore(region),
    tables: ddb.dynamoTables(region),
    keys: kms.kmsKeys(region),
    applications: appint.appIntegrationsApplications(region),
  })
}
