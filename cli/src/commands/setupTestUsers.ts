import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CliError } from '../lib/errors.js'
import type { Profiles, ProfileRecord, Stacks, UserPool } from '../core/ports.js'
export type { ProfileRecord as TestUserProfile } from '../core/ports.js'
import {readOutputs, outputBySuffix, SKILL_ROOT} from './shared.js'
import {ok, info, GREEN, YELLOW, NC} from '../lib/ui.js'

// Provision a test user end to
// end: a Cognito login for the web-call frontend (temporary password delivered
// by EMAIL, never printed) and/or a matching Amazon Connect Customer Profile.
//
// Both capabilities are independently optional:
//   - WebcallWidget deployed (Cognito pool exists) → creates the Cognito user.
//   - customerProfilesEnabled (Profiles domain exists) → creates the profile.
//   - Both → creates both, linked via the Cognito sub (profile AccountNumber).
//   - Neither → prints a warning and exits without provisioning.
//
// Idempotent:
//   - Cognito: FORCE_CHANGE_PASSWORD user → MessageAction RESEND re-sends a
//     NEW temporary password by email; CONFIRMED user is left untouched (the
//     admin-reset-user-password command is printed instead).
//   - Profile: existing profile for the same search key is updated, not
//     duplicated.



export interface SetupTestUsersPorts {
  userPool: UserPool
  profiles: Profiles
  stacks: Pick<Stacks, 'output'>
}

export interface SetupTestUsersArgs {
  projectDir: string
  username: string
  first: string
  last: string
  email: string
  /** Required only when Customer Profiles is enabled (E.164, ANI lookup). */
  phone?: string
  /** Required only when Customer Profiles is enabled (custom attribute). */
  customerNumber?: string
  /** Contact locale, hyphenated (de-DE); underscore form is normalized. */
  locale: string
  /** Test seam: repo root for the legacy values-file fallback (default: SKILL_ROOT). */
  skillRoot?: string
  /** Deploy region, resolved by the caller. */
  region: string
}

export async function setupTestUsers(
  args: SetupTestUsersArgs,
  aws: SetupTestUsersPorts,
): Promise<void> {
  const { projectDir, username, first, last, email } = args
  const phone = args.phone ?? ''
  const customerNumber = args.customerNumber ?? ''
  const skillRoot = args.skillRoot ?? SKILL_ROOT

  // --- Normalize + validate the locale --------------------------------------
  // It becomes the contact LanguageCode the flow passes to the Lex bot, so it
  // MUST be a real xx-XX locale, not a region. de_DE is accepted → de-DE.
  const locale = args.locale.replaceAll('_', '-')
  if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale)) {
    throw new CliError(`locale '${locale}' is not a valid locale — expected the hyphenated form like de-DE or en-US (a region such as eu-central-1 is NOT a locale)`)
  }

  // A values file MUST exist. Unlike the other commands this hard-fails rather
  // than defaulting: Cognito and Customer Profiles calls have to hit the deploy
  // region, never a guessed one.
  const projectValues = join(projectDir, '.connect-skill-values.json')
  const valuesPath = existsSync(projectValues)
    ? projectValues
    : join(skillRoot, '.connect-skill-values.json')
  if (!existsSync(valuesPath)) {
    throw new CliError(`Cannot determine region: no .connect-skill-values.json found in ${projectDir} or ${skillRoot}`)
  }
  const { region } = args
  info(`Region: ${region}`)
  info(`Locale: ${locale}`)

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CliError(`email '${email}' doesn't look valid`)
  }

  const outputs = readOutputs(projectDir) // clear deploy-first error when cdk-outputs.json is missing

  // cdk-outputs.json only reflects the most recent `--outputs-file` deploy,
  // which may be a subset of stacks. Read it first, then fall back to live
  // CloudFormation outputs by stack name. (Sorted for a deterministic pick.)
  const stackPrefix = (Object.keys(outputs).sort()[0] ?? '').replace(/-[^-]+$/, '')

  // --- Resolve the Cognito User Pool ID (optional — no WebcallWidget = skip) -
  let userPoolId = outputBySuffix(outputs, 'WebcallWidget', 'UserPoolId')
  if (!userPoolId) userPoolId = await aws.stacks.output(`${stackPrefix}-WebcallWidget`, 'UserPoolId')
  const hasWebcall = Boolean(userPoolId)
  if (userPoolId) info(`User pool: ${userPoolId}`)
  else info('No WebcallWidget stack found — skipping Cognito user creation (profile-only mode)')

  // --- Resolve the Customer Profiles domain (optional) ----------------------
  // Live CloudFormation only: cdk-outputs.json reflects the most recent
  // --outputs-file deploy, which may cover a subset of the stacks.
  const domain = await aws.stacks.output(`${stackPrefix}-ConnectInstance`, 'CustomerProfilesDomainName')
  const hasProfiles = Boolean(domain)
  if (domain) {
    info(`Customer Profiles domain: ${domain}`)
    // Phone and customer-number are required for profile creation.
    if (!phone) throw new CliError('phone-e164 argument is required when Customer Profiles is enabled')
    if (!customerNumber) throw new CliError('customer-number argument is required when Customer Profiles is enabled')
    if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) {
      throw new CliError(`phone '${phone}' is not in E.164 format (e.g. +15555550100)`)
    }
  } else {
    info('No Customer Profiles domain found — skipping profile creation (Cognito-only mode)')
  }

  // --- Create (or re-invite) the Cognito user, temp password sent by email --
  let sub = ''
  // True only when Cognito actually sent an invitation email (create/RESEND);
  // a CONFIRMED user keeps their password and gets NO email.
  let emailSent = false
  if (userPoolId) {
    // A lookup failure is treated as "user absent" so the create path runs;
    // the adapter already distinguishes UserNotFound from a real error.
    let existing: { exists: boolean; status?: string }
    try {
      existing = await aws.userPool.getUser(userPoolId, username)
    } catch {
      existing = { exists: false }
    }
    if (existing.exists) {
      if (existing.status === 'FORCE_CHANGE_PASSWORD') {
        // RESEND is only valid while first sign-in is pending: Cognito
        // generates a NEW temporary password and re-sends the invite email.
        info(`User '${username}' already exists (pending first sign-in) — resending a new temporary password by email`)
        try {
          await aws.userPool.createUser(userPoolId, username, email, true)
        } catch (err) {
          // Surface the AWS error cause on stderr first, then the terse error.
          console.error(err instanceof Error ? err.message : String(err))
          throw new CliError('admin-create-user (RESEND) failed')
        }
        ok(`Temporary password emailed to ${email}`)
        emailSent = true
      } else {
        // CONFIRMED (or other): RESEND is invalid — leave the password alone.
        info(`User '${username}' already exists (status: ${existing.status ?? ''}) — keeping their existing password`)
        console.log(`  (To reset it, use: aws cognito-idp admin-reset-user-password --user-pool-id ${userPoolId} --username ${username} --region ${region})`)
      }
    } else {
      info(`Creating user '${username}'...`)
      try {
        await aws.userPool.createUser(userPoolId, username, email, false)
      } catch (err) {
        // Surface the AWS error cause on stderr first, then the terse error.
        console.error(err instanceof Error ? err.message : String(err))
        throw new CliError('admin-create-user failed')
      }
      ok(`Temporary password emailed to ${email}`)
      emailSent = true
    }

    // --- Look up the sub (used as the Customer Profile AccountNumber) -------
    let lookedUp: { exists: boolean; sub?: string }
    try {
      lookedUp = await aws.userPool.getUser(userPoolId, username)
    } catch {
      throw new CliError(`could not look up Cognito user '${username}'`)
    }
    if (!lookedUp.exists) throw new CliError(`could not look up Cognito user '${username}'`)
    sub = lookedUp.sub ?? ''
    if (!sub) throw new CliError(`no sub found for Cognito user '${username}'`)
    ok(`Cognito sub: ${sub} (used as the profile AccountNumber → web-call lookup key)`)
  }

  // --- Create (or update) the matching Customer Profile ---------------------
  if (domain) {
    // Web-call: AccountNumber = sub, found via _account. Phone-only (no
    // Cognito): AccountNumber = customer_number, found via _phone (ANI match).
    const accountNumber = sub || customerNumber
    const searchKey = sub ? '_account' : '_phone'
    const searchValue = sub || phone
    const p: ProfileRecord = {
      accountNumber, firstName: first, lastName: last, phone, email,
      attributes: { customerNumber, locale },
    }

    let existingId: string | null
    try {
      existingId = await aws.profiles.findId(domain, searchKey, searchValue)
    } catch {
      existingId = null // a failed search falls through to the create path
    }

    if (existingId && existingId !== 'None') {
      info(`Profile for '${searchKey}=${searchValue}' exists (${existingId}) — updating`)
      try {
        await aws.profiles.update(domain, existingId, p)
      } catch (err) {
        // Surface the AWS error cause on stderr first, then the terse error.
        console.error(err instanceof Error ? err.message : String(err))
        throw new CliError('update-profile failed')
      }
      ok(`Updated profile ${existingId}`)
    } else {
      info(`Creating profile (account=${accountNumber}) in domain '${domain}'`)
      let pid: string
      try {
        pid = await aws.profiles.create(domain, p)
      } catch (err) {
        // Surface the AWS error cause on stderr first, then the terse error.
        console.error(err instanceof Error ? err.message : String(err))
        throw new CliError('create-profile failed')
      }
      ok(`Created profile ${pid}`)
    }
  }

  // --- Summary ---------------------------------------------------------------
  const cloudFrontUrl = outputBySuffix(outputs, 'WebcallWidget', 'CloudFrontUrl') ?? ''
  console.log('')
  console.log('==========================================')
  console.log('Test user ready')
  console.log('==========================================')
  if (cloudFrontUrl) console.log(`Sign in at:      ${cloudFrontUrl}`)
  console.log(`Username:        ${username}`)
  console.log(`Email:           ${email}`)
  if (phone) console.log(`Phone:           ${phone}`)
  if (customerNumber) console.log(`Customer number: ${customerNumber}`)
  console.log(`Locale:          ${locale}`)
  if (sub) console.log(`Cognito sub:     ${sub}`)
  console.log('')
  // Only claim an email went out when one actually did (create/RESEND). A
  // CONFIRMED user kept their password — no email was sent.
  const passwordAdvisory = emailSent
    ? `${YELLOW}→ Temporary password was emailed to ${email} (not shown here). The user must set a new password on first sign-in.${NC}`
    : `${YELLOW}→ The existing password was kept — no email was sent (reset with the admin-reset-user-password command above if needed).${NC}`
  if (hasWebcall && hasProfiles) {
    console.log(passwordAdvisory)
    console.log(`${GREEN}✓ Done.${NC} Sign in and call — the agent will greet ${first} with this profile's context.`)
  } else if (hasWebcall) {
    console.log(passwordAdvisory)
    console.log(`${YELLOW}→ Customer Profiles is not enabled — no profile was created. The agent will not have caller context unless you provide your own data source.${NC}`)
    // "ready", not "created" — this branch is also reached when the user
    // already existed (RESEND or CONFIRMED) and nothing new was created.
    console.log(`${GREEN}✓ Done.${NC} Cognito user ready — sign in at the web-call widget to place a call.`)
  } else if (hasProfiles) {
    console.log(`${YELLOW}→ No web-call frontend — call from ${phone} to reach the agent (profile resolves by ANI).${NC}`)
    // "ready" — an existing profile is updated, not created.
    console.log(`${GREEN}✓ Done.${NC} Customer Profile ready — the agent will greet ${first} with this profile's context.`)
  } else {
    // Neither capability present: nothing was created, so this must not look
    // like success. Exiting 0 after provisioning nothing made the command a
    // silent no-op in scripts (and in the printed next-steps checklist).
    throw new CliError(
      'nothing to provision: this deployment has neither the web-call frontend '
      + '(Cognito sign-in) nor Customer Profiles enabled.\n'
      + '  Enable frontendEnabled and/or customerProfilesEnabled in the order file, '
      + 'redeploy, then re-run setup-test-users.')
  }
}
