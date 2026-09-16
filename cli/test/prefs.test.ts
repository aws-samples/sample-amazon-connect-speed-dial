import { describe, it, expect } from 'vitest'
import { prefsFromOrder, foldFlagsIntoOrder } from '../src/core/prefs.js'

describe('prefsFromOrder', () => {
  it('reads prefs from the order (kbContent path form)', () => {
    expect(prefsFromOrder({ claimUkDid: true, kbContent: '/data/docs' }, {}))
      .toEqual({ claimUkDid: true, kbContent: 'path', kbContentPath: '/data/docs' })
  })
  it('maps kbContent "sample" and absent → sample / skip', () => {
    expect(prefsFromOrder({ kbContent: 'sample' }, {}).kbContent).toBe('sample')
    expect(prefsFromOrder({}, {}).kbContent).toBe('skip')
    expect(prefsFromOrder({}, {}).claimUkDid).toBe(false)
  })
  it('CLI flags act as one-off overrides', () => {
    expect(prefsFromOrder({}, { claimUkDid: true }).claimUkDid).toBe(true)
    expect(prefsFromOrder({ kbContent: 'sample' }, { kbContent: '/x' }))
      .toEqual({ claimUkDid: false, kbContent: 'path', kbContentPath: '/x' })
  })
})

describe('foldFlagsIntoOrder', () => {
  it('returns null when nothing changes', () => {
    expect(foldFlagsIntoOrder({ claimUkDid: true }, { claimUkDid: true })).toBeNull()
    expect(foldFlagsIntoOrder({}, {})).toBeNull()
  })
  it('folds new overrides into the order object', () => {
    expect(foldFlagsIntoOrder({ projectName: 'p' }, { claimUkDid: true, kbContent: 'sample' }))
      .toEqual({ projectName: 'p', claimUkDid: true, kbContent: 'sample' })
  })
})
