import { describe, it, expect } from 'vitest'
import { nextStepsText } from '../src/commands/nextSteps.js'

const base = {
  orderRaw: { projectName: 'myproj' } as Record<string, unknown>,
  prefs: { claimUkDid: true, kbContent: 'skip' as const, kbContentPath: '' },
  outputs: { 'myproj-WebcallWidget': { CloudFrontUrl: 'https://dxxx.cloudfront.net' } },
  project: 'myproj', region: 'us-east-1', cwd: '/work',
  projectDir: '/work/csp-myproj',
  cspPath: 'npm --silent --prefix /skill/cli run csp --', locale: 'en-US',
}

describe('nextStepsText', () => {
  it('always includes the REQUIRED agent-publish console step', () => {
    const t = nextStepsText(base)
    expect(t).toContain("find the row for 'myproj-orchestrator'")
    expect(t).toContain('Save and Publish')
  })
  // The console has no 'Select in Agent Builder' control, and clicking the
  // agent's name opens a read-only view with no publish button — this checklist
  // is the only place the user is told about the one REQUIRED manual step, so
  // keep it matching what the console actually requires: select the row's radio
  // button, then 'Edit' in the list toolbar.
  it('describes the real console controls for publishing', () => {
    const t = nextStepsText(base)
    expect(t).not.toContain('Select in Agent Builder')
    expect(t).toContain('radio button')
    expect(t).toContain("Press 'Edit' in the list toolbar")
  })
  it('includes widget steps only when frontendEnabled', () => {
    expect(nextStepsText(base)).not.toContain('Communication widgets')
    const t = nextStepsText({ ...base, orderRaw: { projectName: 'myproj', frontendEnabled: true } })
    expect(t).toContain('Communication widgets')
    expect(t).toContain('https://dxxx.cloudfront.net')
  })
  it('offers manual phone claim when neither UK DID nor frontend', () => {
    const t = nextStepsText({ ...base, prefs: { ...base.prefs, claimUkDid: false } })
    expect(t).toContain('Claim a number')
  })
  it('prints the option-form setup-test-users invocation in the frontend block', () => {
    const t = nextStepsText({ ...base, orderRaw: { projectName: 'myproj', frontendEnabled: true } })
    expect(t).toContain(
      'npm --silent --prefix /skill/cli run csp -- setup-test-users /work/csp-myproj '
      + '--user <user> --first <First> --last <Last> \\')
    expect(t).toContain('--email <email> --phone <+E164> --customer-number 0000100042 --locale en-US')
  })
  it('prints the option-form setup-test-users invocation in the profiles-only block', () => {
    const t = nextStepsText(base) // customerProfilesEnabled not false, frontend off
    expect(t).toContain('Customer Profiles: create a profile for a real caller')
    expect(t).toContain(
      'npm --silent --prefix /skill/cli run csp -- setup-test-users /work/csp-myproj '
      + '--user <user> --first <First> --last <Last> \\')
    expect(t).toContain('--email <email> --phone <+E164> --customer-number 0000100042 --locale en-US')
  })
  it('mentions the empty KB only when KB enabled and content skipped', () => {
    expect(nextStepsText(base)).not.toContain('Knowledge base is EMPTY')
    const t = nextStepsText({ ...base, orderRaw: { projectName: 'myproj', knowledgeBaseEnabled: true } })
    expect(t).toContain('Knowledge base is EMPTY')
  })
})
