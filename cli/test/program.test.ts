import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, reportError } from '../src/program.js'
import { CliError } from '../src/lib/errors.js'

// The CLI surface, driven IN-PROCESS. buildProgram() is a side-effect-free
// factory, so these run in ~1ms each instead of the ~250ms a subprocess costs.
// exitOverride() makes commander throw instead of calling process.exit.
//
// Only commands that touch neither AWS nor a subprocess are invoked here.

interface Run {
  out: string
  err: string
  error?: unknown
}

async function run(args: string[]): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const program = buildProgram()
  // exitOverride() and configureOutput() are per-command, not inherited, so a
  // missing required option on a SUBcommand would still call process.exit.
  for (const cmd of [program, ...program.commands]) {
    cmd.exitOverride()
    cmd.configureOutput({
      writeOut: (text) => { out.push(text) },
      writeErr: (text) => { err.push(text) },
    })
  }
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(`${a.join(' ')}\n`)
  })
  const errLog = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(`${a.join(' ')}\n`)
  })
  try {
    await program.parseAsync(['node', 'csp', ...args])
    return { out: out.join(''), err: err.join('') }
  } catch (error) {
    // exitOverride() makes commander throw instead of writing + exiting, so the
    // message lives on the error. Fold it in so every case asserts one way.
    const message = error instanceof Error ? error.message : String(error)
    return { out: out.join(''), err: `${err.join('')}${message}\n`, error }
  } finally {
    log.mockRestore()
    errLog.mockRestore()
  }
}

const lastLine = (s: string): string => s.trimEnd().split('\n').at(-1) ?? ''

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'csp-program-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('command surface', () => {
  it('registers every command the skill drives', async () => {
    const names = buildProgram().commands.map((c) => c.name()).sort()
    expect(names).toEqual([
      'cdk-deploy', 'claim-did', 'deploy', 'init-prompts', 'preflight', 'redeploy',
      'render', 'setup-test-users', 'setup-widget', 'smoke-test', 'sync-kb', 'synth',
      'teardown', 'validate-prompts', 'values',
    ])
  })

  it('offers --json on exactly the pipeline step commands', async () => {
    // SKILL.md tells the assistant --json is available on the step commands and
    // NOT on the post-deploy ones; that split is the documented contract.
    const withJson = buildProgram().commands
      .filter((c) => c.options.some((o) => o.long === '--json'))
      .map((c) => c.name()).sort()
    expect(withJson).toEqual([
      'cdk-deploy', 'preflight', 'render', 'synth', 'validate-prompts', 'values',
    ])
  })
})

describe('setup-test-users required options', () => {
  // --locale is load-bearing: it becomes the contact LanguageCode the flow hands
  // to Lex. The CLI must never silently default it.
  const base = [
    'setup-test-users', join('/nonexistent'), '--user', 'jordan', '--first', 'Jordan',
    '--last', 'Lee', '--email', 'jordan@example.com',
  ]

  it.each([
    ['--locale', base],
    ['--user', base.filter((a) => a !== '--user' && a !== 'jordan').concat(['--locale', 'en-US'])],
  ])('refuses to run without %s', async (flag, args) => {
    const r = await run(args)
    expect(r.error).toBeDefined()
    expect(r.err).toContain(`required option '${flag}`)
  })

  it('rejects an empty --locale as an invalid locale, not as a default', async () => {
    const r = await run([...base, '--locale', ''])
    expect((r.error as Error).message).toContain('is not a valid locale')
  })
})

describe('--json contract', () => {
  // Human output is unchanged; with --json the LAST stdout line is one JSON
  // object. SKILL.md tells the assistant to parse that line.
  it('values --json emits the result object as the last line', async () => {
    const order = join(tmp, 'order.json')
    writeFileSync(order, JSON.stringify({ projectName: 'demo', companyName: 'Acme' }))
    const outPath = join(tmp, 'values.json')
    const r = await run(['values', order, outPath, '--json'])
    expect(r.error).toBeUndefined()
    const parsed = JSON.parse(lastLine(r.out))
    expect(parsed).toMatchObject({ ok: true, valuesFile: outPath })
    expect(parsed.values.projectName).toBe('demo')
  })

  it('omits the JSON line without the flag', async () => {
    const order = join(tmp, 'order.json')
    writeFileSync(order, JSON.stringify({ projectName: 'demo' }))
    const r = await run(['values', order, join(tmp, 'values.json')])
    expect(() => JSON.parse(lastLine(r.out))).toThrow()
  })

  it('validate-prompts --json emits ok:true', async () => {
    const prompts = join(tmp, 'prompts')
    mkdirSync(prompts)
    // Satisfies validatePromptsDir's contract: system block, history variable,
    // <message> tag, content-excerpt variable.
    writeFileSync(join(prompts, 'orchestration.md'),
      'system: you are helpful\n{{$.conversationHistory}}\n<message>hi</message>\n')
    writeFileSync(join(prompts, 'self-service.md'), '{{$.contentExcerpt}}\n')
    const r = await run(['validate-prompts', prompts, '--json'])
    expect(r.error).toBeUndefined()
    expect(JSON.parse(lastLine(r.out))).toMatchObject({ ok: true, promptsDir: prompts })
  })
})

describe('reportError', () => {
  let errors: string[]
  beforeEach(() => {
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('prints a CliError as a single red ✗ line and exits 1', () => {
    expect(reportError(new CliError('order file not found: /x'))).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('✗ order file not found: /x')
  })

  it('names an unexpected error and points at credentials when it looks credential-shaped', () => {
    const err = Object.assign(new Error('The security token included in the request is expired'), {
      name: 'ExpiredTokenException',
    })
    expect(reportError(err)).toBe(1)
    const text = errors.join('\n')
    expect(text).toContain('ExpiredTokenException:')
    expect(text).toContain('aws sso login')
  })

  it('does not offer the credential hint for an unrelated failure', () => {
    reportError(new Error('ENOSPC: no space left on device'))
    expect(errors.join('\n')).not.toContain('aws sso login')
  })

  it('points at CSP_DEBUG instead of dumping a stack by default', () => {
    reportError(new Error('boom'))
    expect(errors.join('\n')).toContain('CSP_DEBUG=1')
  })

  it('dumps the error when CSP_DEBUG is set', () => {
    vi.stubEnv('CSP_DEBUG', '1')
    reportError(new Error('boom'))
    expect(errors.join('\n')).not.toContain('CSP_DEBUG=1 for the full stack trace')
    vi.unstubAllEnvs()
  })
})
