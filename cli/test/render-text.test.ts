import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { substitutePlaceholders, findLeftoverPlaceholders, injectSnippetBeforeMessages } from '../src/commands/render/text.js'
import { validatePromptsDir } from '../src/commands/render/prompts.js'

describe('substitutePlaceholders', () => {
  it('replaces all occurrences of every key', () => {
    const out = substitutePlaceholders('a {{projectName}} b {{projectName}} c {{companyName}}',
      { projectName: 'p1', companyName: 'Acme' })
    expect(out).toBe('a p1 b p1 c Acme')
  })
  it('stringifies booleans like the sed pass did', () => {
    expect(substitutePlaceholders('x={{frontendEnabled}}', { frontendEnabled: false })).toBe('x=false')
  })
  it('leaves Q Connect runtime vars ({{$.x}}) untouched', () => {
    const s = 'history: {{$.conversationHistory}}'
    expect(substitutePlaceholders(s, { conversationHistory: 'NO' })).toBe(s)
  })
  it('handles replacement values containing $& and $1 literally (regex-injection guard)', () => {
    expect(substitutePlaceholders('n={{companyName}}', { companyName: 'A $& $1 Co' })).toBe('n=A $& $1 Co')
  })
})

describe('findLeftoverPlaceholders', () => {
  it('flags {{identifier}} but not {{$.runtime}} vars', () => {
    expect(findLeftoverPlaceholders('ok {{$.contentExcerpt}} ok').length).toBe(0)
    expect(findLeftoverPlaceholders('bad {{unreplacedKey}} here').length).toBe(1)
  })
})

describe('injectSnippetBeforeMessages', () => {
  it('inserts snippet lines before the messages: line, preserving both', () => {
    const prompt = 'system: |\n  You are helpful.\nmessages:\n  - hi\n'
    const out = injectSnippetBeforeMessages(prompt, 'SNIP-1\nSNIP-2\n')
    expect(out).toBe('system: |\n  You are helpful.\nSNIP-1\nSNIP-2\nmessages:\n  - hi\n')
  })
  it('is a no-op when no messages: line exists', () => {
    expect(injectSnippetBeforeMessages('just text\n', 'SNIP\n')).toBe('just text\n')
  })
})

describe('validatePromptsDir', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'csp-prompts-')); mkdirSync(tmp, { recursive: true }) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  const goodOrch = 'system: |\n  Persona {{$.conversationHistory}}\n  reply in <message> tags\nmessages:\n'
  const goodSelf = 'Use {{$.contentExcerpt}} to answer.\n'

  it('passes valid prompts', () => {
    writeFileSync(join(tmp, 'orchestration.md'), goodOrch)
    writeFileSync(join(tmp, 'self-service.md'), goodSelf)
    expect(() => validatePromptsDir(tmp)).not.toThrow()
  })
  it('fails with the verbatim message when a scaffolding needle is missing', () => {
    writeFileSync(join(tmp, 'orchestration.md'), goodOrch.replace('<message>', ''))
    writeFileSync(join(tmp, 'self-service.md'), goodSelf)
    expect(() => validatePromptsDir(tmp))
      .toThrow("orchestration.md is missing the <message> formatting tag ('<message>')")
  })
  it('fails when a prompt file is missing', () => {
    writeFileSync(join(tmp, 'orchestration.md'), goodOrch)
    expect(() => validatePromptsDir(tmp)).toThrow(`self-service prompt not found: ${join(tmp, 'self-service.md')}`)
  })
})
