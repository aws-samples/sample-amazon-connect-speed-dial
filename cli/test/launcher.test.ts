import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

// There is no launcher script — `csp` is an npm script — and two details of it
// are load-bearing and easy to "simplify" away:
//
//   1. `cd "$INIT_CWD"`. npm runs scripts with cwd set to the PACKAGE dir, but
//      every csp command takes relative path arguments that must resolve against
//      the *caller's* directory. Drop the cd and `csp values order.json out.json`
//      silently writes into cli/ instead of the user's working dir.
//   2. `$npm_config_local_prefix/src/main.ts`. After the cd, a relative path to
//      main.ts no longer resolves.
//
// The static checks below state the intent; the behavioural test proves it.

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('npm script launcher', () => {
  it('declares exactly the two entry points, and setup only installs', () => {
    expect(pkg.scripts.setup).toBe('npm ci')
    expect(pkg.scripts.csp).toBeTypeOf('string')
  })

  it('returns to the caller directory before exec, and resolves main.ts absolutely', () => {
    expect(pkg.scripts.csp).toContain('cd "$INIT_CWD"')
    expect(pkg.scripts.csp).toContain('$npm_config_local_prefix/src/main.ts')
  })

  it('the launcher itself is gone — nothing should reintroduce a bash shim', () => {
    expect(existsSync(join(CLI_DIR, 'csp'))).toBe(false)
  })

  // The regression that no other test would catch: run a real command from an
  // unrelated cwd with RELATIVE arguments, and require the output to land there
  // rather than inside cli/.
  it('resolves relative path arguments against the caller cwd', () => {
    const work = mkdtempSync(join(tmpdir(), 'csp-launcher-'))
    writeFileSync(join(work, 'order.json'), JSON.stringify({ projectName: 'launchertest' }))

    const stdout = execFileSync(
      'npm',
      ['--silent', '--prefix', CLI_DIR, 'run', 'csp', '--',
        'values', 'order.json', 'out.json', '--json'],
      { cwd: work, encoding: 'utf8' },
    )

    expect(existsSync(join(work, 'out.json'))).toBe(true)
    expect(existsSync(join(CLI_DIR, 'out.json'))).toBe(false)

    // --silent keeps npm's banner off stdout, so the last line stays parseable.
    const last = stdout.trim().split('\n').at(-1) as string
    expect(JSON.parse(last)).toMatchObject({ ok: true, valuesFile: 'out.json' })
  }, 60_000)
})
