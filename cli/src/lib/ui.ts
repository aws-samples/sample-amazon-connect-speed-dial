import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { CliError } from './errors.js'

// Canonical ANSI palette + log helpers for the whole CLI. No module defines its
// own copies.
export const GREEN = '\x1b[0;32m'
export const RED = '\x1b[0;31m'
export const YELLOW = '\x1b[1;33m'
export const BOLD = '\x1b[1m'
export const NC = '\x1b[0m'

export const ok = (m: string): void => console.log(`${GREEN}✓ ${m}${NC}`)
export const info = (m: string): void => console.log(`→ ${m}`)
export const warn = (m: string): void => console.log(`${YELLOW}⚠ ${m}${NC}`)
// fail === throw CliError (main.ts prints ✗ red to stderr + exit 1)

/** Read + parse a JSON file. On parse failure throws
 *  CliError(`<what> is not valid JSON: <path>`). Existence is NOT handled
 *  here — callers keep their own not-found checks (and messages). */
export function readJsonFile(path: string, what: string): unknown {
  const text = readFileSync(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new CliError(`${what} is not valid JSON: ${path}`)
  }
}

/** A JSON object whose values are not yet known. */
const JsonObject = z.record(z.string(), z.unknown())

/** Read a JSON file that must contain an OBJECT. Every file the CLI reads is a
 *  map of keys — an array or a bare scalar means the file is not what the caller
 *  thinks it is, and saying so here beats a confusing failure three frames
 *  later. Existence is still the caller's check. */
export function readJsonObject(path: string, what: string): Record<string, unknown> {
  const parsed = JsonObject.safeParse(readJsonFile(path, what))
  if (!parsed.success) throw new CliError(`${what} is not a JSON object: ${path}`)
  return parsed.data
}
