import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildValues, serializeJson } from '../src/commands/values.js'
import { CliError } from '../src/lib/errors.js'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'csp-values-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('buildValues', () => {
  it('writes the derived values file with trailing newline and creates parent dirs', () => {
    const orderPath = join(tmp, 'order.json')
    writeFileSync(orderPath, JSON.stringify({ projectName: 'acme-support' }))
    const outPath = join(tmp, 'csp-acme-support', '.connect-skill-values.json')
    buildValues(orderPath, outPath)
    expect(existsSync(outPath)).toBe(true)
    const raw = readFileSync(outPath, 'utf8')
    expect(raw.endsWith('}\n')).toBe(true)
    const v = JSON.parse(raw)
    expect(v.projectName).toBe('acme-support')
    expect(v.orchestrationModelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0')
  })
  // Regression (critical): setup-widget persists connectWidgets into this same
  // file specifically so a re-render keeps the widget. buildValues used to
  // rewrite the file from the order alone, so `csp redeploy` dropped the widget
  // — which un-configures the live web-call site AND deletes the Secrets
  // Manager secret holding the widget signing key (the widget stack creates one
  // secret per entry, so an empty array removes the resource).
  it('carries connectWidgets over from an existing values file', () => {
    const orderPath = join(tmp, 'order.json')
    writeFileSync(orderPath, JSON.stringify({ projectName: 'acme-support', frontendEnabled: true }))
    const outPath = join(tmp, '.connect-skill-values.json')
    const widget = { id: 'WID-123', snippetId: 'QVlCQyE9PQ==', scriptUrl: 'https://x/widget.js' }

    buildValues(orderPath, outPath)                        // first deploy
    const first = JSON.parse(readFileSync(outPath, 'utf8'))
    first.connectWidgets = [widget]
    writeFileSync(outPath, serializeJson(first))            // csp setup-widget
    buildValues(orderPath, outPath)                        // csp redeploy

    const after = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(after.connectWidgets).toEqual([widget])
    // Derived keys still come from the order file, not the stale copy.
    expect(after.projectName).toBe('acme-support')
    expect(after.frontendEnabled).toBe(true)
  })

  it('emits no connectWidgets key when there is no prior values file', () => {
    const orderPath = join(tmp, 'order.json')
    writeFileSync(orderPath, JSON.stringify({ projectName: 'acme-support' }))
    const outPath = join(tmp, '.connect-skill-values.json')
    buildValues(orderPath, outPath)
    expect('connectWidgets' in JSON.parse(readFileSync(outPath, 'utf8'))).toBe(false)
  })

  it('regenerates (with a warning) when the prior values file is not JSON', () => {
    const orderPath = join(tmp, 'order.json')
    writeFileSync(orderPath, JSON.stringify({ projectName: 'acme-support' }))
    const outPath = join(tmp, '.connect-skill-values.json')
    writeFileSync(outPath, '{ this is not json')
    const errs: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)) })
    try {
      expect(buildValues(orderPath, outPath).projectName).toBe('acme-support')
      expect(errs.join('\n')).toContain('csp setup-widget')
    } finally { spy.mockRestore() }
  })

  it('throws the verbatim not-found message', () => {
    expect(() => buildValues(join(tmp, 'nope.json'), join(tmp, 'out.json')))
      .toThrow(new CliError(`order file not found: ${join(tmp, 'nope.json')}`).message)
  })
})

describe('serializeJson (stable file format)', () => {
  it('formats with 2-space indent and a trailing newline', () => {
    expect(serializeJson({ a: 'x', b: true })).toBe('{\n  "a": "x",\n  "b": true\n}\n')
  })
})
