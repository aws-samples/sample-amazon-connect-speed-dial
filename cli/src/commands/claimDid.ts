import { z } from 'zod'
import { CliError } from '../lib/errors.js'
import type { Identity, PhoneNumbers } from '../core/ports.js'

// Claim a UK phone number and point it at the contact flow. Idempotent: a UK
// number already claimed on the instance is reused rather than a second one
// bought. The command returns what it found or did; renderClaim() prints it.

/** What "a UK DID" means is this command's policy, not the adapter's. */
const UK = 'GB'
const DID = 'DID'
const SEARCH_LIMIT = 5

const InputSchema = z.object({
  instanceId: z.string().min(1),
  flowId: z.string().min(1),
  region: z.string().min(1),
})

export interface ClaimDidPorts {
  identity: Identity
  phoneNumbers: PhoneNumbers
}

export interface ClaimDidReport {
  phoneNumber: string
  phoneNumberId: string
  /** True when the number was already on the instance and nothing was bought. */
  alreadyClaimed: boolean
}

export async function claimDid(
  instanceId: string, flowId: string, region: string, aws: ClaimDidPorts,
): Promise<ClaimDidReport> {
  const parsed = InputSchema.safeParse({ instanceId, flowId, region })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new CliError(`invalid claim-did input: ${issue.path.join('.')} — ${issue.message}`)
  }

  const account = await aws.identity.accountId()
  const instanceArn = `arn:aws:connect:${region}:${account}:instance/${instanceId}`

  // A number's TargetArn is always the *instance* ARN, never a contact-flow ARN,
  // so the answerable question is "is a GB number already claimed here?" — the
  // number-to-flow binding is not visible in the summaries.
  const [existing] = await aws.phoneNumbers.listClaimed(instanceId, UK)
  if (existing) {
    return { ...existing, alreadyClaimed: true }
  }

  const [phoneNumber] = await aws.phoneNumbers.searchAvailable(instanceArn, UK, DID, SEARCH_LIMIT)
  if (!phoneNumber) throw new CliError('No UK DIDs available')

  const phoneNumberId = await aws.phoneNumbers.claim(instanceArn, phoneNumber)
  if (!phoneNumberId) throw new CliError('Failed to claim phone number')

  await aws.phoneNumbers.routeToFlow(phoneNumberId, instanceId, flowId)
  return { phoneNumber, phoneNumberId, alreadyClaimed: false }
}

/** PHONE_NUMBER= / PHONE_NUMBER_ID= are read off stdout by the assistant
 *  (SKILL.md). Keep both lines verbatim. */
export function renderClaim(r: ClaimDidReport): string[] {
  return [
    r.alreadyClaimed
      ? '✓ UK DID already claimed on this instance — reusing it'
      : '✓ UK DID claimed and routed to the contact flow',
    `PHONE_NUMBER=${r.phoneNumber}`,
    `PHONE_NUMBER_ID=${r.phoneNumberId}`,
  ]
}
