import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// `csp --help` must not pay for the AWS SDK. Measured: the two SDKs claim-did
// alone needs cost ~99ms to import, against a ~200ms total for `--help`. The
// discipline that keeps it fast is structural — adapters hold the static SDK
// imports, and only *.live.ts reaches them, dynamically. This test is what stops
// that from silently regressing.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

const staticImportsOf = (relPath: string): string[] => {
  const src = readFileSync(join(SRC, relPath), 'utf8')
  return [...src.matchAll(/^\s*import\s(?!type\s)[^;\n]*?from\s+'([^']+)'/gm)].map((m) => m[1])
}

/** Every *.live.ts under src/, wherever it lives — walked rather than listed, so
 *  moving or adding a command directory cannot silently drop it from the check. */
const liveFiles = (): string[] => {
  const found: string[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(SRC, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(next)
      else if (entry.name.endsWith('.live.ts')) found.push(next)
    }
  }
  walk('')
  return found
}

describe('startup cost', () => {
  it.each(['main.ts', 'program.ts'])(
    '%s statically imports no AWS SDK and no adapter', (entry) => {
      const imports = staticImportsOf(entry)
      expect(imports.filter((s) => s.startsWith('@aws-sdk/'))).toEqual([])
      expect(imports.filter((s) => s.includes('/adapters/'))).toEqual([])
    })

  it('every *.live.ts statically imports no AWS SDK and no adapter', () => {
    const found = liveFiles()
    expect(found.length).toBeGreaterThan(0)
    for (const f of found) {
      const imports = staticImportsOf(f)
      expect(imports.filter((s) => s.startsWith('@aws-sdk/')), f).toEqual([])
      expect(imports.filter((s) => s.includes('/adapters/')), f).toEqual([])
    }
  })

  it('the AWS SDK is imported only by adapters', () => {
    const offenders: string[] = []
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(SRC, rel), { withFileTypes: true })) {
        const next = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(next)
        else if (entry.name.endsWith('.ts') && !next.startsWith('adapters/')) {
          if (staticImportsOf(next).some((s) => s.startsWith('@aws-sdk/'))) offenders.push(next)
        }
      }
    }
    walk('')
    expect(offenders).toEqual([])
  })
})
