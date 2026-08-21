import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initPrompts } from '../src/commands/initPrompts.js'
import { SKILL_ROOT } from '../src/commands/shared.js'
import { CliError } from '../src/lib/errors.js'

let workingDir: string

beforeEach(() => {
  workingDir = mkdtempSync(join(tmpdir(), 'csp-init-prompts-'))
})

afterEach(() => {
  rmSync(workingDir, { recursive: true, force: true })
})

describe('initPrompts', () => {
  it('seeds both prompt files when they are absent', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    initPrompts(workingDir)

    const orchestrationPath = join(workingDir, 'prompts', 'orchestration.md')
    const selfServicePath = join(workingDir, 'prompts', 'self-service.md')

    expect(existsSync(orchestrationPath)).toBe(true)
    expect(existsSync(selfServicePath)).toBe(true)

    expect(log).toHaveBeenCalledWith(`seeded ${orchestrationPath}`)
    expect(log).toHaveBeenCalledWith(`seeded ${selfServicePath}`)

    log.mockRestore()
  })

  it('keeps existing files without clobbering', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    // First run: seed the files
    initPrompts(workingDir)
    const orchestrationPath = join(workingDir, 'prompts', 'orchestration.md')
    const selfServicePath = join(workingDir, 'prompts', 'self-service.md')

    // Modify the files
    const customOrchestration = 'custom orchestration content'
    const customSelfService = 'custom self-service content'
    writeFileSync(orchestrationPath, customOrchestration)
    writeFileSync(selfServicePath, customSelfService)

    // Clear previous calls
    log.mockClear()

    // Second run: should keep the modified files
    initPrompts(workingDir)

    expect(log).toHaveBeenCalledWith(`kept existing ${orchestrationPath}`)
    expect(log).toHaveBeenCalledWith(`kept existing ${selfServicePath}`)

    // Verify files are unchanged
    expect(readFileSync(orchestrationPath, 'utf8')).toBe(customOrchestration)
    expect(readFileSync(selfServicePath, 'utf8')).toBe(customSelfService)

    log.mockRestore()
  })

  it('throws CliError when template prompts directory is missing', () => {
    const badSkillRoot = mkdtempSync(join(tmpdir(), 'csp-init-prompts-bad-root-'))
    const expectedSrc = join(badSkillRoot, 'templates', 'cdk-app', 'prompts')
    try {
      expect(() => initPrompts(workingDir, badSkillRoot))
        .toThrow(CliError)
      expect(() => initPrompts(workingDir, badSkillRoot))
        .toThrow(`seed prompts not found: ${expectedSrc}`)
    } finally {
      rmSync(badSkillRoot, { recursive: true, force: true })
    }
  })

  it('seeds prompts that satisfy the prompt contract', () => {
    initPrompts(workingDir)

    const orchestration = readFileSync(join(workingDir, 'prompts', 'orchestration.md'), 'utf8')
    const selfService = readFileSync(join(workingDir, 'prompts', 'self-service.md'), 'utf8')

    // Asserting non-emptiness passed for a single space or the wrong file. What
    // actually matters is that the seeds carry the scaffolding
    // validatePromptsDir requires — otherwise the user edits them and the next
    // `csp render` hard-fails on files the CLI itself produced.
    expect(orchestration).toContain('system:')
    expect(orchestration).toContain('{{$.conversationHistory}}')
    expect(orchestration).toContain('<message>')
    expect(selfService).toContain('{{$.contentExcerpt}}')
    // And they are byte-identical copies of the templates, not transformed.
    const seedDir = join(SKILL_ROOT, 'templates', 'cdk-app', 'prompts')
    expect(orchestration).toBe(readFileSync(join(seedDir, 'orchestration.md'), 'utf8'))
    expect(selfService).toBe(readFileSync(join(seedDir, 'self-service.md'), 'utf8'))
  })

  it('creates prompts directory if it does not exist', () => {
    const promptsDir = join(workingDir, 'prompts')
    expect(existsSync(promptsDir)).toBe(false)

    initPrompts(workingDir)

    expect(existsSync(promptsDir)).toBe(true)
  })
})
