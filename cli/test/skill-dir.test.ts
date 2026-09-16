import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { SKILL_ROOT } from '../src/commands/shared.js'

// Several modules locate the repo root (= skill dir) by counting levels up from
// their own file, then use it to find templates/cdk-app and sample-data. The
// level count is invisible to both tsc and the unit suite: move a file one
// directory deeper and SKILL_DIR silently points at cli/ instead of the repo
// root, so `csp deploy` renders from a directory that does not exist. This
// happened during the src/ restructure. These checks make the arithmetic real.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

const isSkillRoot = (dir: string): boolean =>
  existsSync(join(dir, 'templates', 'cdk-app')) && existsSync(join(dir, 'sample-data'))

const tsFiles = (rel: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(join(SRC, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) tsFiles(next, out)
    else if (entry.name.endsWith('.ts')) out.push(next)
  }
  return out
}

describe('skill-dir resolution', () => {
  it("shared.ts's SKILL_ROOT is the repo root", () => {
    expect(isSkillRoot(SKILL_ROOT)).toBe(true)
  })

  // Every `new URL('<levels>', import.meta.url)` in src/ is a repo-root walk.
  // Resolve each one from its own file's real location and require it to land on
  // the repo root — the same computation the module performs at runtime.
  it('every new URL(..., import.meta.url) walk lands on the repo root', () => {
    const walks: string[] = []
    for (const rel of tsFiles('')) {
      const source = readFileSync(join(SRC, rel), 'utf8')
      for (const [, literal] of source.matchAll(/new URL\('([^']+)',\s*import\.meta\.url\)/g)) {
        const resolved = resolve(fileURLToPath(new URL(literal, pathToFileURL(join(SRC, rel)))))
        walks.push(rel)
        expect(isSkillRoot(resolved), `${rel}: '${literal}' resolved to ${resolved}`).toBe(true)
      }
    }
    // Guard the guard: if the pattern stops appearing, this test is asserting
    // nothing and the next move breaks silently again.
    expect(walks.length).toBeGreaterThan(0)
  })
})
