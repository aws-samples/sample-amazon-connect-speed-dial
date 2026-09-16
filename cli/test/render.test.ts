import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderTemplates } from '../src/commands/render/render.js'

let tmp: string, src: string, work: string, dest: string, valuesFile: string

const goodOrch =
  'system: |\n  You work for {{companyName}}. {{$.conversationHistory}}\n  Use <message> tags.\nmessages:\n  - hi\n'
const goodSelf = 'Answer from {{$.contentExcerpt}}.\n'
const snippet = 'CONTEXT-SNIPPET-LINE\n'

const baseValues = {
  projectName: 'p1', companyName: 'Acme', region: 'us-east-1',
  customerProfilesEnabled: true, frontendEnabled: false, dataLakeEnabled: false,
  contactEventsEnabled: false, retainData: true, identityCenterEnabled: false,
  knowledgeBaseEnabled: false, kbParsingModelId: 'us.amazon.nova-pro-v1:0',
  lexLocaleId: 'en_US', ttsLanguageCode: 'en-US', voiceGender: 'feminine',
  promptLanguage: 'English', selfServiceFallback: "I don't have an answer.",
  orchestrationModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  answerGenModelId: 'us.amazon.nova-pro-v1:0',
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'csp-render-'))
  src = join(tmp, 'template'); work = join(tmp, 'work'); dest = join(work, 'csp-p1')
  mkdirSync(join(src, 'prompts'), { recursive: true })
  mkdirSync(join(src, 'lib'), { recursive: true })
  writeFileSync(join(src, 'prompts', 'orchestration.md'), goodOrch)
  writeFileSync(join(src, 'prompts', 'self-service.md'), goodSelf)
  writeFileSync(join(src, 'prompts', 'context-injection.snippet.md'), snippet)
  writeFileSync(join(src, 'app.ts'), "const name = '{{projectName}}'\n")
  writeFileSync(join(src, 'lib', 'deployment-values.json'), '{\n  "prefix": ""\n}\n')
  writeFileSync(join(src, 'notes.txt'), 'not-a-substituted-type {{projectName}}\n')
  mkdirSync(work, { recursive: true })
  valuesFile = join(work, 'values.json')
  writeFileSync(valuesFile, JSON.stringify(baseValues))
})
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('renderTemplates', () => {
  it('substitutes {{key}} in .ts files and leaves other extensions alone', () => {
    renderTemplates(valuesFile, src, dest)
    expect(readFileSync(join(dest, 'app.ts'), 'utf8')).toBe("const name = 'p1'\n")
    expect(readFileSync(join(dest, 'notes.txt'), 'utf8')).toContain('{{projectName}}')
  })
  it('emits lib/deployment-values.json with the config subset and jq formatting', () => {
    renderTemplates(valuesFile, src, dest)
    const dv = JSON.parse(readFileSync(join(dest, 'lib', 'deployment-values.json'), 'utf8'))
    expect(dv).toEqual({
      prefix: 'p1', customerProfilesEnabled: true, retainData: true,
      frontendEnabled: false, dataLakeEnabled: false, contactEventsEnabled: false,
      knowledgeBaseEnabled: false, identityCenterEnabled: false,
      promptLanguage: 'English', connectWidgets: [],
    })
  })
  it('appends the context snippet before messages: when profiles on, and drops the fragment', () => {
    renderTemplates(valuesFile, src, dest)
    const orch = readFileSync(join(dest, 'prompts', 'orchestration.md'), 'utf8')
    expect(orch).toContain('CONTEXT-SNIPPET-LINE\nmessages:')
    expect(existsSync(join(dest, 'prompts', 'context-injection.snippet.md'))).toBe(false)
  })
  it('skips the snippet when profiles AND context injection are off', () => {
    writeFileSync(valuesFile, JSON.stringify({ ...baseValues, customerProfilesEnabled: false }))
    renderTemplates(valuesFile, src, dest)
    expect(readFileSync(join(dest, 'prompts', 'orchestration.md'), 'utf8')).not.toContain('CONTEXT-SNIPPET-LINE')
  })
  it('overlays working-dir prompts and carries saml-metadata.xml', () => {
    mkdirSync(join(work, 'prompts'), { recursive: true })
    writeFileSync(join(work, 'prompts', 'orchestration.md'),
      'system: | CUSTOM {{$.conversationHistory}} <message>\nmessages:\n')
    writeFileSync(join(work, 'saml-metadata.xml'), '<EntityDescriptor/>')
    renderTemplates(valuesFile, src, dest)
    expect(readFileSync(join(dest, 'prompts', 'orchestration.md'), 'utf8')).toContain('CUSTOM')
    expect(readFileSync(join(dest, 'saml-metadata.xml'), 'utf8')).toBe('<EntityDescriptor/>')
  })
  it('cleans dest but preserves node_modules, cdk.out, cdk-outputs.json, dotfiles', () => {
    mkdirSync(join(dest, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(dest, 'cdk.out'), { recursive: true })
    writeFileSync(join(dest, 'cdk-outputs.json'), '{}')
    writeFileSync(join(dest, '.connect-skill-values.json'), '{}')
    writeFileSync(join(dest, 'stale-file.ts'), 'stale')
    renderTemplates(valuesFile, src, dest)
    expect(existsSync(join(dest, 'node_modules', 'x'))).toBe(true)
    expect(existsSync(join(dest, 'cdk.out'))).toBe(true)
    expect(existsSync(join(dest, 'cdk-outputs.json'))).toBe(true)
    expect(existsSync(join(dest, '.connect-skill-values.json'))).toBe(true)
    // The stale file is removed by the clean and the template does not restore it.
    expect(existsSync(join(dest, 'stale-file.ts'))).toBe(false)
  })
  it('hard-fails when a placeholder has no value', () => {
    writeFileSync(join(src, 'app.ts'), "const x = '{{unknownKey}}'\n")
    expect(() => renderTemplates(valuesFile, src, dest))
      .toThrow('unsubstituted placeholders remain in rendered output')
  })
})
