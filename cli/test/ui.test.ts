import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFile, readJsonObject, GREEN, RED, YELLOW, NC, ok, info, warn } from '../src/lib/ui.js'
import { CliError } from '../src/lib/errors.js'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'csp-ui-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('readJsonFile', () => {
  it('parses a valid JSON file', () => {
    const p = join(tmp, 'ok.json')
    writeFileSync(p, '{"a": 1}')
    expect(readJsonFile(p, 'values file')).toEqual({ a: 1 })
  })
  it('throws CliError("<what> is not valid JSON: <path>") on parse failure', () => {
    const p = join(tmp, 'bad.json')
    writeFileSync(p, '{not json')
    expect(() => readJsonFile(p, 'order file')).toThrow(CliError)
    expect(() => readJsonFile(p, 'order file')).toThrow(`order file is not valid JSON: ${p}`)
  })
  it('does NOT wrap missing-file errors (callers own their not-found checks)', () => {
    const p = join(tmp, 'missing.json')
    expect(() => readJsonFile(p, 'cdk-outputs.json')).not.toThrow(CliError)
    expect(() => readJsonFile(p, 'cdk-outputs.json')).toThrow(/ENOENT/)
  })
})

describe('readJsonObject', () => {
  // Every file the CLI reads is a map of keys. Rejecting a non-object here beats
  // an "undefined is not an object" three frames downstream.
  const write = (name: string, text: string): string => {
    const p = join(tmp, name)
    writeFileSync(p, text)
    return p
  }

  it('returns the parsed object', () => {
    expect(readJsonObject(write('ok.json', '{"region":"eu-central-1"}'), 'values file'))
      .toEqual({ region: 'eu-central-1' })
  })

  it.each([
    ['an array', '[1,2]'],
    ['a string', '"hello"'],
    ['a number', '42'],
    ['null', 'null'],
  ])('rejects %s, naming what the file was meant to be', (_label, text) => {
    const p = write('bad.json', text)
    expect(() => readJsonObject(p, 'values file'))
      .toThrow(new CliError(`values file is not a JSON object: ${p}`))
  })

  it('still reports invalid JSON with the parse message, not the shape message', () => {
    const p = write('broken.json', '{not json')
    expect(() => readJsonObject(p, 'order file'))
      .toThrow(`order file is not valid JSON: ${p}`)
  })
})

describe('output palette', () => {
  // These four escapes and the ✓/→/⚠ prefixes are the CLI's output contract.
  it('is the fixed set of colors', () => {
    expect(GREEN).toBe('\x1b[0;32m')
    expect(RED).toBe('\x1b[0;31m')
    expect(YELLOW).toBe('\x1b[1;33m')
    expect(NC).toBe('\x1b[0m')
  })

  it('ok/info/warn print the ✓/→/⚠ contract lines', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    ok('done'); info('step'); warn('careful')
    expect(log).toHaveBeenNthCalledWith(1, `${GREEN}✓ done${NC}`)
    expect(log).toHaveBeenNthCalledWith(2, '→ step')
    expect(log).toHaveBeenNthCalledWith(3, `${YELLOW}⚠ careful${NC}`)
    log.mockRestore()
  })
})
