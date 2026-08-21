import { SKILL_ROOT, resolveRegionFrom } from './shared.js'
import type { SetupTestUsersArgs } from './setupTestUsers.js'

// Wiring for `csp setup-test-users`. No top-level `@aws-sdk/*` or adapter import.

export async function setupTestUsersLive(
  args: Omit<SetupTestUsersArgs, 'region'>,
): Promise<void> {
  const skillRoot = args.skillRoot ?? SKILL_ROOT
  const region = resolveRegionFrom(args.projectDir, skillRoot)
  const [{ setupTestUsers }, cognito, profiles, cfn] = await Promise.all([
    import('./setupTestUsers.js'),
    import('../adapters/cognito.js'),
    import('../adapters/customerProfiles.js'),
    import('../adapters/cloudformation.js'),
  ])
  await setupTestUsers({ ...args, region }, {
    userPool: cognito.cognitoUserPool(region),
    profiles: profiles.customerProfilesDirectory(region),
    stacks: cfn.cfnStacks(region),
  })
}
