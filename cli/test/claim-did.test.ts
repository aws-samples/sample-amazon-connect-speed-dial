import { describe, it, expect } from 'vitest'
import { claimDid, renderClaim, type ClaimDidPorts } from '../src/commands/claimDid.js'
import { CliError } from '../src/lib/errors.js'

type Numbers = ClaimDidPorts['phoneNumbers']

/** Records every call and its arguments, then delegates. Overrides replace the
 *  behaviour but never the recording — a fake that lets an override silence the
 *  call log makes "did not call X" assertions vacuously true. */
function ports(over: Partial<Numbers> = {}):
ClaimDidPorts & { calls: string[]; args: Record<string, unknown[]> } {
  const calls: string[] = []
  const args: Record<string, unknown[]> = {}
  const impl: Numbers = {
    listClaimed: async () => [],
    searchAvailable: async () => ['+441134960000'],
    claim: async () => 'pn-id-1',
    routeToFlow: async () => {},
    ...over,
  }
  const log = (name: string, a: unknown[]): void => { calls.push(name); args[name] = a }
  return {
    calls,
    args,
    identity: { accountId: async () => '123456789012', accountIdOrNull: async () => '123456789012' },
    phoneNumbers: {
      async listClaimed(i, c) { log('listClaimed', [i, c]); return impl.listClaimed(i, c) },
      async searchAvailable(a, c, t, l) {
        log('searchAvailable', [a, c, t, l]); return impl.searchAvailable(a, c, t, l) },
      async claim(a, n) { log('claim', [a, n]); return impl.claim(a, n) },
      async routeToFlow(p, i, f) { log('routeToFlow', [p, i, f]); return impl.routeToFlow(p, i, f) },
    },
  }
}

describe('claimDid', () => {
  it('reuses a UK number already claimed on the instance', async () => {
    const p = ports({
      listClaimed: async () => [{ phoneNumber: '+441134960001', phoneNumberId: 'pn-existing' }],
    })
    const r = await claimDid('inst-1', 'flow-1', 'us-east-1', p)
    expect(r).toEqual({
      phoneNumber: '+441134960001', phoneNumberId: 'pn-existing', alreadyClaimed: true,
    })
    expect(p.calls).toEqual(['listClaimed'])
  })

  it('searches, claims, then routes — in that order', async () => {
    const p = ports()
    const r = await claimDid('inst-1', 'flow-1', 'eu-central-1', p)
    expect(p.calls).toEqual(['listClaimed', 'searchAvailable', 'claim', 'routeToFlow'])
    expect(r).toEqual({
      phoneNumber: '+441134960000', phoneNumberId: 'pn-id-1', alreadyClaimed: false,
    })
  })

  it('asks for a GB DID against the instance ARN, five at a time', async () => {
    const p = ports()
    await claimDid('inst-1', 'flow-1', 'eu-central-1', p)
    expect(p.args.listClaimed).toEqual(['inst-1', 'GB'])
    expect(p.args.searchAvailable).toEqual([
      'arn:aws:connect:eu-central-1:123456789012:instance/inst-1', 'GB', 'DID', 5,
    ])
  })

  it('routes the claimed number to the flow on the same instance', async () => {
    const p = ports()
    await claimDid('inst-9', 'flow-9', 'us-east-1', p)
    expect(p.args.routeToFlow).toEqual(['pn-id-1', 'inst-9', 'flow-9'])
  })

  it('fails when the search finds nothing, without claiming', async () => {
    const p = ports({ searchAvailable: async () => [] })
    await expect(claimDid('inst-1', 'flow-1', 'us-east-1', p))
      .rejects.toThrow(new CliError('No UK DIDs available'))
    expect(p.calls).not.toContain('claim')
  })

  it('fails when the claim returns no id, without routing', async () => {
    const p = ports({ claim: async () => null })
    await expect(claimDid('inst-1', 'flow-1', 'us-east-1', p))
      .rejects.toThrow(new CliError('Failed to claim phone number'))
    expect(p.calls).not.toContain('routeToFlow')
  })

  it('rejects a blank instance id instead of building an ARN from it', async () => {
    const p = ports()
    await expect(claimDid('', 'flow-1', 'us-east-1', p)).rejects.toThrow(/instanceId/)
    expect(p.calls).toEqual([])
  })
})

describe('renderClaim', () => {
  // SKILL.md tells the assistant to read PHONE_NUMBER= off stdout, so these two
  // lines are a contract. Keep them verbatim.
  it('emits the machine-read PHONE_NUMBER lines for a fresh claim', () => {
    const text = renderClaim({
      phoneNumber: '+441134960000', phoneNumberId: 'pn-1', alreadyClaimed: false,
    }).join('\n')
    expect(text).toContain('PHONE_NUMBER=+441134960000')
    expect(text).toContain('PHONE_NUMBER_ID=pn-1')
  })

  it('emits the same lines when the number was already claimed, and says so', () => {
    const text = renderClaim({
      phoneNumber: '+441134960001', phoneNumberId: 'pn-existing', alreadyClaimed: true,
    }).join('\n')
    expect(text).toContain('PHONE_NUMBER=+441134960001')
    expect(text).toContain('PHONE_NUMBER_ID=pn-existing')
    expect(text.toLowerCase()).toContain('already')
  })
})
