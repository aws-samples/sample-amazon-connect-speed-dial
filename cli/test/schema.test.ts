import { describe, it, expect } from 'vitest'
import { parseOrder, deriveValues, validateProjectName } from '../src/core/schema.js'
import { CliError } from '../src/lib/errors.js'

const minimal = { projectName: 'acme-support' }

describe('parseOrder defaults', () => {
  it('applies express defaults', () => {
    const o = parseOrder(minimal)
    expect(o.companyName).toBe('My Company')
    expect(o.region).toBe('us-east-1')
    expect(o.language).toBe('en')
    expect(o.voiceGender).toBe('feminine')
    expect(o.customerProfilesEnabled).toBe(true) // default-true
    expect(o.retainData).toBe(true) // default-true
    expect(o.frontendEnabled).toBe(false)
    expect(o.dataLakeEnabled).toBe(false)
    expect(o.contactEventsEnabled).toBe(false)
    expect(o.knowledgeBaseEnabled).toBe(false)
    expect(o.identityCenterEnabled).toBe(false)
  })
  it('preserves explicit false for default-true booleans (the jq // footgun)', () => {
    const o = parseOrder({ ...minimal, customerProfilesEnabled: false, retainData: false })
    expect(o.customerProfilesEnabled).toBe(false)
    expect(o.retainData).toBe(false)
  })
  it('ignores legacy/unknown keys (transferEnabled, greeting, claimUkDid...)', () => {
    const o = parseOrder({ ...minimal, transferEnabled: true, greeting: 'Hi!', claimUkDid: true })
    expect((o as unknown as Record<string, unknown>).greeting).toBeUndefined()
    expect((o as unknown as Record<string, unknown>).transferEnabled).toBeUndefined()
  })
})

describe('parseOrder rejections (error-message contract)', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, 'projectName is required'],
    [{ projectName: 'Bad-Name' }, "invalid projectName 'Bad-Name': use lowercase letters, digits, and single hyphens (no leading/trailing hyphen)"],
    [{ projectName: 'test--name' }, "invalid projectName 'test--name': use lowercase letters, digits, and single hyphens (no leading/trailing hyphen)"],
    [{ projectName: '-test' }, "invalid projectName '-test': use lowercase letters, digits, and single hyphens (no leading/trailing hyphen)"],
    [{ projectName: 'test-' }, "invalid projectName 'test-': use lowercase letters, digits, and single hyphens (no leading/trailing hyphen)"],
    [{ projectName: 'a'.repeat(33) }, `invalid projectName '${'a'.repeat(33)}': max 32 characters`],
    [{ ...minimal, region: 'eu-west-1' }, "invalid region 'eu-west-1': must be us-east-1 or eu-central-1"],
    [{ ...minimal, language: 'fr' }, "invalid language 'fr': must be en or de"],
    [{ ...minimal, voiceGender: 'robot' }, "invalid voiceGender 'robot': must be feminine or masculine"],
    [{ ...minimal, companyName: 'Say `hi` Co' }, 'invalid companyName: the characters ` " \\ ${ and line breaks are not supported'],
    [{ ...minimal, companyName: 'Cost: ${p}' }, 'invalid companyName: the characters ` " \\ ${ and line breaks are not supported'],
    [{ ...minimal, companyName: 'Back\\slash' }, 'invalid companyName: the characters ` " \\ ${ and line breaks are not supported'],
    [{ ...minimal, customerProfilesEnabled: 'yes' }, 'customerProfilesEnabled must be boolean'],
    [{ ...minimal, retainData: 1 }, 'retainData must be boolean'],
    [{ ...minimal, frontendEnabled: 'true' }, 'frontendEnabled must be boolean'],
  ]
  for (const [raw, msg] of cases) {
    it(`rejects ${JSON.stringify(raw).slice(0, 60)}`, () => {
      expect(() => parseOrder(raw)).toThrow(CliError)
      expect(() => parseOrder(raw)).toThrow(msg)
    })
  }
  // A double quote used to be ACCEPTED here, and this test pinned that as
  // correct. It is not: companyName is substituted verbatim into generated JSON
  // (flows/prompt-texts-seed.json), which the contact-flow stack JSON.parses at
  // synth — so `Say "hello" Co` rendered fine and then failed deep inside the
  // CDK app with a SyntaxError that named neither companyName nor the order file.
  it('rejects double quotes in companyName (they break generated JSON)', () => {
    expect(() => parseOrder({ ...minimal, companyName: 'Say "hello" Co' })).toThrow(CliError)
    expect(() => parseOrder({ ...minimal, companyName: 'Say "hello" Co' }))
      .toThrow('invalid companyName: the characters ` " \\ ${ and line breaks are not supported')
  })

  it('rejects line breaks in companyName', () => {
    expect(() => parseOrder({ ...minimal, companyName: 'Acme\nCorp' })).toThrow(CliError)
  })
})

describe('deriveValues', () => {
  it('emits exactly the 18 keys in the contract order', () => {
    const v = deriveValues(parseOrder(minimal))
    expect(Object.keys(v)).toEqual([
      'projectName',
      'companyName',
      'region',
      'customerProfilesEnabled',
      'frontendEnabled',
      'dataLakeEnabled',
      'contactEventsEnabled',
      'retainData',
      'identityCenterEnabled',
      'knowledgeBaseEnabled',
      'kbParsingModelId',
      'lexLocaleId',
      'ttsLanguageCode',
      'voiceGender',
      'promptLanguage',
      'selfServiceFallback',
      'orchestrationModelId',
      'answerGenModelId',
    ])
  })
  it('us-east-1 → us.* model profiles', () => {
    const v = deriveValues(parseOrder(minimal))
    expect(v.orchestrationModelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0')
    expect(v.answerGenModelId).toBe('us.amazon.nova-pro-v1:0')
    expect(v.kbParsingModelId).toBe('us.amazon.nova-pro-v1:0')
  })
  it('eu-central-1 → eu.* model profiles', () => {
    const v = deriveValues(parseOrder({ ...minimal, region: 'eu-central-1' }))
    expect(v.orchestrationModelId).toBe('eu.anthropic.claude-haiku-4-5-20251001-v1:0')
    expect(v.answerGenModelId).toBe('eu.amazon.nova-pro-v1:0')
    expect(v.kbParsingModelId).toBe('eu.amazon.nova-pro-v1:0')
  })
  it('en → en_US/en-US/English + English fallback', () => {
    const v = deriveValues(parseOrder(minimal))
    expect(v.lexLocaleId).toBe('en_US')
    expect(v.ttsLanguageCode).toBe('en-US')
    expect(v.promptLanguage).toBe('English')
    expect(v.selfServiceFallback).toBe("I don't have an answer.")
  })
  it('de → de_DE/de-DE/German + German fallback', () => {
    const v = deriveValues(parseOrder({ ...minimal, language: 'de' }))
    expect(v.lexLocaleId).toBe('de_DE')
    expect(v.ttsLanguageCode).toBe('de-DE')
    expect(v.promptLanguage).toBe('German')
    expect(v.selfServiceFallback).toBe('Ich habe darauf leider keine Antwort.')
  })
  it('voiceGender passes through verbatim', () => {
    expect(deriveValues(parseOrder({ ...minimal, voiceGender: 'masculine' })).voiceGender).toBe('masculine')
  })
})

describe('validateProjectName', () => {
  it('returns null for valid names', () => expect(validateProjectName('my-proj-1')).toBeNull())
  it('returns the message for invalid names', () =>
    expect(validateProjectName('Bad')).toBe('use lowercase letters, digits, and single hyphens (no leading/trailing hyphen)'))
  it('returns the length message for >32 chars', () =>
    expect(validateProjectName('a'.repeat(33))).toBe('max 32 characters'))
})
