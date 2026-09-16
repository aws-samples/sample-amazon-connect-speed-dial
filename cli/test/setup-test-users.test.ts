import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setupTestUsers,
  type SetupTestUsersArgs,
  type SetupTestUsersPorts,
  type TestUserProfile,
} from '../src/commands/setupTestUsers.js'
import { CliError } from '../src/lib/errors.js'

interface FakeOpts {
  /** UserPoolId served by the live-CFN fallback (outputs-file miss). */
  poolViaCfn?: string | null
  /** CustomerProfilesDomainName served by live CFN (never read from the outputs file — it may be stale). */
  domain?: string | null
  /** Pre-existing Cognito user (adminGetUser hit). */
  existingUser?: { status: string; sub: string } | null
  /** Pre-existing Customer Profile (searchProfiles hit). */
  existingProfileId?: string | null
}

interface FakeState {
  createUserCalls: Array<{ poolId: string; username: string; email: string; resend: boolean }>
  cfnCalls: Array<{ stackName: string; outputKey: string }>
  searchCalls: Array<{ domain: string; keyName: string; value: string }>
  createProfileCalls: Array<{ domain: string; p: TestUserProfile }>
  updateProfileCalls: Array<{ domain: string; profileId: string; p: TestUserProfile }>
}

let projectDir: string
let skillRoot: string // repo-root stand-in WITHOUT a values file (test seam)
let lines: string[]

function fakePorts(opts: FakeOpts = {}): SetupTestUsersPorts & FakeState {
  let user = opts.existingUser ?? null
  const state: FakeState = {
    createUserCalls: [], cfnCalls: [], searchCalls: [],
    createProfileCalls: [], updateProfileCalls: [],
  }
  return {
    ...state,
    userPool: {
      async getUser() {
        return user ? { exists: true, status: user.status, sub: user.sub } : { exists: false }
      },
      async createUser(poolId, username, email, resend) {
        state.createUserCalls.push({ poolId, username, email, resend })
        // Cognito creates the user (or re-invites); the sub becomes resolvable.
        if (!user) user = { status: 'FORCE_CHANGE_PASSWORD', sub: 'sub-abc-123' }
      },
    },
    stacks: {
      async output(stackName, outputKey) {
        state.cfnCalls.push({ stackName, outputKey })
        if (stackName.endsWith('-WebcallWidget') && outputKey === 'UserPoolId') {
          return opts.poolViaCfn ?? null
        }
        if (stackName.endsWith('-ConnectInstance') && outputKey === 'CustomerProfilesDomainName') {
          return opts.domain ?? null
        }
        return null
      },
    },
    profiles: {
      async findId(domain, keyName, value) {
        state.searchCalls.push({ domain, keyName, value })
        return opts.existingProfileId ?? null
      },
      async create(domain, profile) {
        state.createProfileCalls.push({ domain, p: profile })
        return 'prof-new-1'
      },
      async update(domain, profileId, profile) {
        state.updateProfileCalls.push({ domain, profileId, p: profile })
      },
    },
  }
}

// Outputs with a WebcallWidget stack (UserPoolId resolvable from the file).
const widgetOutputs = {
  'proj-ConnectInstance': { InstanceId: 'i-1' },
  'proj-WebcallWidget': { UserPoolId: 'pool-1', CloudFrontUrl: 'https://d123.cloudfront.net' },
}
const noWidgetOutputs = { 'proj-ConnectInstance': { InstanceId: 'i-1' } }

function args(over: Partial<SetupTestUsersArgs> = {}): SetupTestUsersArgs {
  return {
    projectDir, username: 'jordan', first: 'Jordan', last: 'Lee',
    email: 'jordan@example.com', phone: '+15555550100',
    customerNumber: '0000100042', locale: 'en-US', skillRoot, region: 'us-east-1', ...over,
  }
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'csp-testusers-proj-'))
  skillRoot = mkdtempSync(join(tmpdir(), 'csp-testusers-root-'))
  writeFileSync(join(projectDir, '.connect-skill-values.json'), JSON.stringify({ region: 'us-east-1' }))
  writeFileSync(join(projectDir, 'cdk-outputs.json'), JSON.stringify(widgetOutputs))
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
})
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(skillRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const stripped = () => lines.map(strip)

describe('locale handling', () => {
  it('normalizes the underscore form (de_DE → de-DE) and stores it on the profile', async () => {
    const deps = fakePorts({ domain: 'dom-1' })
    await setupTestUsers(args({ locale: 'de_DE' }), deps)
    expect(stripped()).toContain('→ Locale: de-DE')
    expect(deps.createProfileCalls[0]?.p.attributes).toEqual(
      { customerNumber: '0000100042', locale: 'de-DE' })
    expect(stripped()).toContain('Locale:          de-DE')
  })

  it('rejects a region masquerading as a locale, verbatim', async () => {
    await expect(setupTestUsers(args({ locale: 'eu-central-1' }), fakePorts()))
      .rejects.toThrow(new CliError(
        "locale 'eu-central-1' is not a valid locale — expected the hyphenated form like de-DE or en-US (a region such as eu-central-1 is NOT a locale)"))
  })

  it('validates the locale before region resolution', async () => {
    rmSync(join(projectDir, '.connect-skill-values.json'))
    await expect(setupTestUsers(args({ locale: 'nope' }), fakePorts()))
      .rejects.toThrow(/is not a valid locale/)
  })
})

describe('region', () => {
  // Region PRECEDENCE is resolveRegionFrom's, covered by 11 cases in
  // shared.test.ts. What is specific to this command is that it
  // REFUSES to guess: Cognito and Customer Profiles calls must hit the deploy
  // region, so a missing values file is fatal rather than a us-east-1 default.
  it('hard-fails verbatim when no values file exists anywhere', async () => {
    rmSync(join(projectDir, '.connect-skill-values.json'))
    await expect(setupTestUsers(args(), fakePorts()))
      .rejects.toThrow(new CliError(
        `Cannot determine region: no .connect-skill-values.json found in ${projectDir} or ${skillRoot}`))
  })

  it('accepts a repo-root values file as the legacy location', async () => {
    rmSync(join(projectDir, '.connect-skill-values.json'))
    writeFileSync(join(skillRoot, '.connect-skill-values.json'),
      JSON.stringify({ region: 'eu-central-1' }))
    await setupTestUsers(args({ region: 'eu-central-1' }), fakePorts())
    expect(stripped()).toContain('→ Region: eu-central-1')
  })

  it('reports the region it was given', async () => {
    await setupTestUsers(args({ region: 'eu-central-1' }), fakePorts())
    expect(stripped()).toContain('→ Region: eu-central-1')
  })
})

describe('input validation', () => {
  it('rejects an invalid email verbatim', async () => {
    await expect(setupTestUsers(args({ email: 'not-an-email' }), fakePorts()))
      .rejects.toThrow(new CliError("email 'not-an-email' doesn't look valid"))
  })

  it('fails verbatim when cdk-outputs.json is missing', async () => {
    rmSync(join(projectDir, 'cdk-outputs.json'))
    await expect(setupTestUsers(args(), fakePorts()))
      .rejects.toThrow(
        `cdk-outputs.json not found at ${join(projectDir, 'cdk-outputs.json')} (deploy the project first)`)
  })
})

describe('profiles-mode argument gating', () => {
  it('requires phone-e164 when Customer Profiles is enabled, verbatim', async () => {
    await expect(setupTestUsers(args({ phone: undefined }), fakePorts({ domain: 'dom-1' })))
      .rejects.toThrow(new CliError('phone-e164 argument is required when Customer Profiles is enabled'))
  })

  it('requires customer-number when Customer Profiles is enabled, verbatim', async () => {
    await expect(setupTestUsers(args({ customerNumber: undefined }), fakePorts({ domain: 'dom-1' })))
      .rejects.toThrow(new CliError('customer-number argument is required when Customer Profiles is enabled'))
  })

  it('rejects a non-E.164 phone verbatim', async () => {
    await expect(setupTestUsers(args({ phone: '15555550100' }), fakePorts({ domain: 'dom-1' })))
      .rejects.toThrow(new CliError("phone '15555550100' is not in E.164 format (e.g. +15555550100)"))
  })

  it('does NOT gate phone/customer-number when Customer Profiles is disabled', async () => {
    const deps = fakePorts({ domain: null })
    await setupTestUsers(args({ phone: undefined, customerNumber: undefined }), deps)
    expect(deps.searchCalls).toEqual([])
    // conditional summary lines omitted when empty
    expect(stripped().some((l) => l.startsWith('Phone:'))).toBe(false)
    expect(stripped().some((l) => l.startsWith('Customer number:'))).toBe(false)
  })
})

describe('mode: both (Cognito + Profiles) — full transcript', () => {
  it('prints the full transcript in order (output contract)', async () => {
    const deps = fakePorts({ domain: 'dom-1' })
    await setupTestUsers(args(), deps)
    expect(stripped()).toEqual([
      '→ Region: us-east-1',
      '→ Locale: en-US',
      '→ User pool: pool-1',
      '→ Customer Profiles domain: dom-1',
      "→ Creating user 'jordan'...",
      '✓ Temporary password emailed to jordan@example.com',
      '✓ Cognito sub: sub-abc-123 (used as the profile AccountNumber → web-call lookup key)',
      "→ Creating profile (account=sub-abc-123) in domain 'dom-1'",
      '✓ Created profile prof-new-1',
      '',
      '==========================================',
      'Test user ready',
      '==========================================',
      'Sign in at:      https://d123.cloudfront.net',
      'Username:        jordan',
      'Email:           jordan@example.com',
      'Phone:           +15555550100',
      'Customer number: 0000100042',
      'Locale:          en-US',
      'Cognito sub:     sub-abc-123',
      '',
      '→ Temporary password was emailed to jordan@example.com (not shown here). The user must set a new password on first sign-in.',
      '✓ Done. Sign in and call — the agent will greet Jordan with this profile\'s context.',
    ])
    // colors are part of the contract: yellow advisory, green "✓ Done." prefix
    expect(lines.at(-2)).toBe('\x1b[1;33m→ Temporary password was emailed to jordan@example.com (not shown here). The user must set a new password on first sign-in.\x1b[0m')
    expect(lines.at(-1)).toBe("\x1b[0;32m✓ Done.\x1b[0m Sign in and call — the agent will greet Jordan with this profile's context.")
  })

  it('links the profile to Cognito: search by _account=sub, AccountNumber=sub', async () => {
    const deps = fakePorts({ domain: 'dom-1' })
    await setupTestUsers(args(), deps)
    expect(deps.searchCalls).toEqual([{ domain: 'dom-1', keyName: '_account', value: 'sub-abc-123' }])
    expect(deps.createProfileCalls).toEqual([{
      domain: 'dom-1',
      p: {
        accountNumber: 'sub-abc-123', firstName: 'Jordan', lastName: 'Lee',
        phone: '+15555550100', email: 'jordan@example.com',
        attributes: { customerNumber: '0000100042', locale: 'en-US' },
      },
    }])
  })
})

describe('mode: cognito-only (no Profiles domain)', () => {
  it('skips profile creation and prints the cognito-only closing block', async () => {
    const deps = fakePorts({ domain: null })
    await setupTestUsers(args(), deps)
    expect(stripped()).toContain(
      '→ No Customer Profiles domain found — skipping profile creation (Cognito-only mode)')
    expect(deps.searchCalls).toEqual([])
    expect(deps.createProfileCalls).toEqual([])
    expect(deps.updateProfileCalls).toEqual([])
    expect(stripped().slice(-3)).toEqual([
      '→ Temporary password was emailed to jordan@example.com (not shown here). The user must set a new password on first sign-in.',
      '→ Customer Profiles is not enabled — no profile was created. The agent will not have caller context unless you provide your own data source.',
      '✓ Done. Cognito user ready — sign in at the web-call widget to place a call.',
    ])
  })
})

describe('mode: profiles-only (no WebcallWidget)', () => {
  it('skips Cognito, keys the profile by _phone, AccountNumber=customer-number', async () => {
    writeFileSync(join(projectDir, 'cdk-outputs.json'), JSON.stringify(noWidgetOutputs))
    const deps = fakePorts({ domain: 'dom-1' })
    await setupTestUsers(args(), deps)
    expect(stripped()).toContain(
      '→ No WebcallWidget stack found — skipping Cognito user creation (profile-only mode)')
    expect(deps.createUserCalls).toEqual([])
    expect(deps.searchCalls).toEqual([{ domain: 'dom-1', keyName: '_phone', value: '+15555550100' }])
    expect(deps.createProfileCalls[0]?.p.accountNumber).toBe('0000100042')
    // no CloudFront URL / Cognito sub lines in the summary
    expect(stripped().some((l) => l.startsWith('Sign in at:'))).toBe(false)
    expect(stripped().some((l) => l.startsWith('Cognito sub:'))).toBe(false)
    expect(stripped().slice(-2)).toEqual([
      '→ No web-call frontend — call from +15555550100 to reach the agent (profile resolves by ANI).',
      '✓ Done. Customer Profile ready — the agent will greet Jordan with this profile\'s context.',
    ])
  })
})

describe('mode: neither', () => {
  // Provisioning nothing is a failure, not a success: this used to print a
  // warning and exit 0, which made the command a silent no-op in scripts and in
  // the next-steps checklist that tells users to run it.
  it('provisions nothing and fails with the capabilities to enable', async () => {
    writeFileSync(join(projectDir, 'cdk-outputs.json'), JSON.stringify(noWidgetOutputs))
    const deps = fakePorts({ domain: null })
    await expect(setupTestUsers(args({ phone: undefined, customerNumber: undefined }), deps))
      .rejects.toThrow(/nothing to provision/)
    await expect(setupTestUsers(args({ phone: undefined, customerNumber: undefined }), deps))
      .rejects.toThrow(/frontendEnabled and\/or customerProfilesEnabled/)
    expect(deps.createUserCalls).toEqual([])
    expect(deps.createProfileCalls).toEqual([])
    expect(deps.updateProfileCalls).toEqual([])
  })
})

describe('Cognito branches', () => {
  it('absent user → adminCreateUser without RESEND', async () => {
    const deps = fakePorts({ domain: null })
    await setupTestUsers(args(), deps)
    expect(stripped()).toContain("→ Creating user 'jordan'...")
    expect(deps.createUserCalls).toEqual([
      { poolId: 'pool-1', username: 'jordan', email: 'jordan@example.com', resend: false }])
    expect(stripped()).toContain('✓ Temporary password emailed to jordan@example.com')
  })

  it('FORCE_CHANGE_PASSWORD → adminCreateUser with RESEND (new temp password re-sent)', async () => {
    const deps = fakePorts({ domain: null, existingUser: { status: 'FORCE_CHANGE_PASSWORD', sub: 'sub-old-9' } })
    await setupTestUsers(args(), deps)
    expect(stripped()).toContain(
      "→ User 'jordan' already exists (pending first sign-in) — resending a new temporary password by email")
    expect(deps.createUserCalls).toEqual([
      { poolId: 'pool-1', username: 'jordan', email: 'jordan@example.com', resend: true }])
    expect(stripped()).toContain('✓ Cognito sub: sub-old-9 (used as the profile AccountNumber → web-call lookup key)')
  })

  it('CONFIRMED → left untouched, prints the admin-reset-user-password command', async () => {
    const deps = fakePorts({ domain: null, existingUser: { status: 'CONFIRMED', sub: 'sub-old-9' } })
    await setupTestUsers(args(), deps)
    expect(stripped()).toContain(
      "→ User 'jordan' already exists (status: CONFIRMED) — keeping their existing password")
    expect(stripped()).toContain(
      '  (To reset it, use: aws cognito-idp admin-reset-user-password --user-pool-id pool-1 --username jordan --region us-east-1)')
    expect(deps.createUserCalls).toEqual([])
    // No email goes out in this branch — the output must not claim one did.
    expect(stripped().some((l) => /emailed/i.test(l))).toBe(false)
    expect(stripped()).toContain(
      '→ The existing password was kept — no email was sent (reset with the admin-reset-user-password command above if needed).')
  })

  it('CONFIRMED with Profiles → summary still makes no emailed claim', async () => {
    const deps = fakePorts({ domain: 'dom-1', existingUser: { status: 'CONFIRMED', sub: 'sub-old-9' } })
    await setupTestUsers(args(), deps)
    expect(stripped().some((l) => /emailed/i.test(l))).toBe(false)
    expect(stripped()).toContain(
      '→ The existing password was kept — no email was sent (reset with the admin-reset-user-password command above if needed).')
  })

  it('RESEND branch confirms the email after the re-invite succeeds', async () => {
    const deps = fakePorts({ domain: null, existingUser: { status: 'FORCE_CHANGE_PASSWORD', sub: 'sub-old-9' } })
    await setupTestUsers(args(), deps)
    expect(stripped()).toContain('✓ Temporary password emailed to jordan@example.com')
    expect(stripped()).toContain(
      '→ Temporary password was emailed to jordan@example.com (not shown here). The user must set a new password on first sign-in.')
  })

  it('fails verbatim when the created user has no sub', async () => {
    const deps = fakePorts({ domain: null, existingUser: { status: 'CONFIRMED', sub: '' } })
    await expect(setupTestUsers(args(), deps))
      .rejects.toThrow(new CliError("no sub found for Cognito user 'jordan'"))
  })

  it('resolves the user pool from live CFN when cdk-outputs.json lacks it', async () => {
    writeFileSync(join(projectDir, 'cdk-outputs.json'), JSON.stringify(noWidgetOutputs))
    const deps = fakePorts({ poolViaCfn: 'pool-live', domain: null })
    await setupTestUsers(args(), deps)
    expect(deps.cfnCalls[0]).toEqual({ stackName: 'proj-WebcallWidget', outputKey: 'UserPoolId' })
    expect(stripped()).toContain('→ User pool: pool-live')
    expect(deps.createUserCalls[0]?.poolId).toBe('pool-live')
  })
})

describe('profile update-vs-create', () => {
  it('updates (not duplicates) an existing profile', async () => {
    const deps = fakePorts({ domain: 'dom-1', existingProfileId: 'prof-9' })
    await setupTestUsers(args(), deps)
    expect(stripped()).toContain("→ Profile for '_account=sub-abc-123' exists (prof-9) — updating")
    expect(stripped()).toContain('✓ Updated profile prof-9')
    expect(deps.createProfileCalls).toEqual([])
    expect(deps.updateProfileCalls).toEqual([{
      domain: 'dom-1', profileId: 'prof-9',
      p: {
        accountNumber: 'sub-abc-123', firstName: 'Jordan', lastName: 'Lee',
        phone: '+15555550100', email: 'jordan@example.com',
        attributes: { customerNumber: '0000100042', locale: 'en-US' },
      },
    }])
  })

  it('creates when no profile matches the search key', async () => {
    const deps = fakePorts({ domain: 'dom-1', existingProfileId: null })
    await setupTestUsers(args(), deps)
    expect(deps.updateProfileCalls).toEqual([])
    expect(stripped()).toContain('✓ Created profile prof-new-1')
  })
})

describe('AWS error causes are surfaced (cause on stderr, then the terse ✗ error)', () => {
  let errLines: string[]
  beforeEach(() => {
    errLines = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errLines.push(a.join(' ')) })
  })

  it('create branch: prints the cause, then throws the verbatim error', async () => {
    const deps = fakePorts({ domain: null })
    deps.userPool.createUser = async () => { throw new Error('User pool pool-1 does not exist.') }
    await expect(setupTestUsers(args(), deps))
      .rejects.toThrow(new CliError('admin-create-user failed'))
    expect(errLines).toEqual(['User pool pool-1 does not exist.'])
  })

  it('RESEND branch: prints the cause, then throws the verbatim error', async () => {
    const deps = fakePorts({ domain: null, existingUser: { status: 'FORCE_CHANGE_PASSWORD', sub: 'sub-old-9' } })
    deps.userPool.createUser = async () => { throw new Error('AccessDeniedException: not authorized') }
    await expect(setupTestUsers(args(), deps))
      .rejects.toThrow(new CliError('admin-create-user (RESEND) failed'))
    expect(errLines).toEqual(['AccessDeniedException: not authorized'])
  })

  it('create-profile: prints the cause, then throws the verbatim error', async () => {
    const deps = fakePorts({ domain: 'dom-1' })
    deps.profiles.create = async () => { throw new Error('BadRequestException: invalid attributes') }
    await expect(setupTestUsers(args(), deps))
      .rejects.toThrow(new CliError('create-profile failed'))
    expect(errLines).toEqual(['BadRequestException: invalid attributes'])
  })

  it('update-profile: prints the cause, then throws the verbatim error', async () => {
    const deps = fakePorts({ domain: 'dom-1', existingProfileId: 'prof-9' })
    deps.profiles.update = async () => { throw new Error('ThrottlingException: rate exceeded') }
    await expect(setupTestUsers(args(), deps))
      .rejects.toThrow(new CliError('update-profile failed'))
    expect(errLines).toEqual(['ThrottlingException: rate exceeded'])
  })

  it('non-Error throw is stringified, not dropped', async () => {
    const deps = fakePorts({ domain: null })
    deps.userPool.createUser = async () => { throw 'plain string failure' } // eslint-disable-line no-throw-literal
    await expect(setupTestUsers(args(), deps))
      .rejects.toThrow(new CliError('admin-create-user failed'))
    expect(errLines).toEqual(['plain string failure'])
  })
})

describe('no password ever appears in output', () => {
  // The temp password is generated by Cognito and delivered by email only —
  // every output line mentioning "password" must be one of these fixed strings.
  const allowed = [
    '✓ Temporary password emailed to jordan@example.com',
    '→ Temporary password was emailed to jordan@example.com (not shown here). The user must set a new password on first sign-in.',
    "→ User 'jordan' already exists (pending first sign-in) — resending a new temporary password by email",
    "→ User 'jordan' already exists (status: CONFIRMED) — keeping their existing password",
    '  (To reset it, use: aws cognito-idp admin-reset-user-password --user-pool-id pool-1 --username jordan --region us-east-1)',
    '→ The existing password was kept — no email was sent (reset with the admin-reset-user-password command above if needed).',
  ]

  it.each([
    ['create', undefined],
    ['RESEND', { status: 'FORCE_CHANGE_PASSWORD', sub: 'sub-old-9' }],
    ['CONFIRMED', { status: 'CONFIRMED', sub: 'sub-old-9' }],
  ] as const)('%s branch: password-mentioning lines are the fixed set only', async (_name, existingUser) => {
    const deps = fakePorts({ domain: 'dom-1', existingUser: existingUser ?? null })
    await setupTestUsers(args(), deps)
    const passwordLines = stripped().filter((l) => /password/i.test(l))
    expect(passwordLines.length).toBeGreaterThan(0)
    for (const l of passwordLines) expect(allowed).toContain(l)
  })
})
