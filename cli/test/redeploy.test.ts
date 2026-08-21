import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findOrderForProject } from '../src/commands/redeploy.js'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'csp-redeploy-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('findOrderForProject', () => {
  it('resolves csp-<name> dirs to the sibling order file', () => {
    const projectDir = join(tmp, 'csp-myproj')
    mkdirSync(projectDir)
    writeFileSync(join(tmp, '.connect-skill-order.myproj.json'), '{"projectName":"myproj"}')
    expect(findOrderForProject(projectDir)).toEqual({
      orderPath: join(tmp, '.connect-skill-order.myproj.json'), project: 'myproj',
    })
  })
  it('falls back to the bare dir name (legacy layout)', () => {
    const projectDir = join(tmp, 'finalreview')
    mkdirSync(projectDir)
    writeFileSync(join(tmp, '.connect-skill-order.finalreview.json'), '{"projectName":"finalreview"}')
    expect(findOrderForProject(projectDir).project).toBe('finalreview')
  })
  it('throws a helpful error when no order file exists', () => {
    const projectDir = join(tmp, 'csp-ghost')
    mkdirSync(projectDir)
    expect(() => findOrderForProject(projectDir))
      .toThrow(`order file not found for project 'ghost': expected ${join(tmp, '.connect-skill-order.ghost.json')}`)
  })
})
