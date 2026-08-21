import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveRegion, resolveRegionFrom, readOutputs, outputBySuffix, SKILL_ROOT,
} from '../src/commands/shared.js'
import { CliError } from '../src/lib/errors.js'
import type { CdkOutputs } from '../src/commands/cdkDeploy.js'

let projectDir: string
let skillRoot: string
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'csp-shared-proj-'))
  skillRoot = mkdtempSync(join(tmpdir(), 'csp-shared-root-'))
  vi.stubEnv('AWS_REGION', '')
  vi.stubEnv('AWS_DEFAULT_REGION', '')
})
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(skillRoot, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const writeValues = (dir: string, region?: string) =>
  writeFileSync(join(dir, '.connect-skill-values.json'),
    JSON.stringify(region === undefined ? { projectName: 'p' } : { projectName: 'p', region }))

describe('resolveRegion precedence', () => {
  it('explicit arg wins over everything', () => {
    writeValues(projectDir, 'eu-central-1')
    writeValues(skillRoot, 'eu-west-1')
    vi.stubEnv('AWS_REGION', 'ap-southeast-2')
    expect(resolveRegionFrom(projectDir, skillRoot, 'us-west-2', true)).toBe('us-west-2')
  })
  it('project values file beats repo-root values file', () => {
    writeValues(projectDir, 'eu-central-1')
    writeValues(skillRoot, 'eu-west-1')
    expect(resolveRegionFrom(projectDir, skillRoot)).toBe('eu-central-1')
  })
  it('falls back to the repo-root legacy values file when the project file is missing', () => {
    writeValues(skillRoot, 'eu-west-1')
    expect(resolveRegionFrom(projectDir, skillRoot)).toBe('eu-west-1')
  })
  it('uses AWS_REGION when useEnv is set and no values file has a region', () => {
    vi.stubEnv('AWS_REGION', 'ap-southeast-2')
    expect(resolveRegionFrom(projectDir, skillRoot, undefined, true)).toBe('ap-southeast-2')
  })
  it('uses AWS_DEFAULT_REGION when useEnv is set and AWS_REGION is empty', () => {
    vi.stubEnv('AWS_DEFAULT_REGION', 'ca-central-1')
    expect(resolveRegionFrom(projectDir, skillRoot, undefined, true)).toBe('ca-central-1')
  })
  it('values-file region beats env even with useEnv', () => {
    writeValues(projectDir, 'eu-central-1')
    vi.stubEnv('AWS_REGION', 'ap-southeast-2')
    expect(resolveRegionFrom(projectDir, skillRoot, undefined, true)).toBe('eu-central-1')
  })
  it('ignores env when useEnv is not set', () => {
    vi.stubEnv('AWS_REGION', 'ap-southeast-2')
    expect(resolveRegionFrom(projectDir, skillRoot)).toBe('us-east-1')
  })
  it('defaults to us-east-1 when nothing else provides a region', () => {
    expect(resolveRegionFrom(projectDir, skillRoot, undefined, true)).toBe('us-east-1')
  })
  it('treats a values file without a region key as no region', () => {
    writeValues(projectDir)
    expect(resolveRegionFrom(projectDir, skillRoot)).toBe('us-east-1')
  })
  it('resolveRegion delegates with SKILL_ROOT (arg path)', () => {
    expect(resolveRegion(projectDir, 'us-west-2')).toBe('us-west-2')
  })
})

describe('readOutputs', () => {
  it('parses <projectDir>/cdk-outputs.json', () => {
    const outputs: CdkOutputs = { 'csp-p-Widget': { WidgetId: 'w-1' } }
    writeFileSync(join(projectDir, 'cdk-outputs.json'), JSON.stringify(outputs))
    expect(readOutputs(projectDir)).toEqual(outputs)
  })
  it('throws the deploy-first message when the file is missing', () => {
    const path = join(projectDir, 'cdk-outputs.json')
    expect(() => readOutputs(projectDir)).toThrow(CliError)
    expect(() => readOutputs(projectDir))
      .toThrow(`cdk-outputs.json not found at ${path} (deploy the project first)`)
  })
})

describe('outputBySuffix', () => {
  const outputs: CdkOutputs = {
    'csp-p-ConnectInstance': { InstanceId: 'i-123', Empty: '' },
    'csp-p-Wisdom': { AssistantId: 'a-456' },
  }
  it('returns the value from the stack ending in -<suffix>', () => {
    expect(outputBySuffix(outputs, 'Wisdom', 'AssistantId')).toBe('a-456')
    expect(outputBySuffix(outputs, 'ConnectInstance', 'InstanceId')).toBe('i-123')
  })
  it('returns null for a missing stack, missing key, or empty value', () => {
    expect(outputBySuffix(outputs, 'Nope', 'InstanceId')).toBeNull()
    expect(outputBySuffix(outputs, 'Wisdom', 'Nope')).toBeNull()
    expect(outputBySuffix(outputs, 'ConnectInstance', 'Empty')).toBeNull()
  })
  it('requires the -<suffix> boundary (no bare-substring match)', () => {
    expect(outputBySuffix({ 'csp-pWisdom': { AssistantId: 'x' } }, 'Wisdom', 'AssistantId'))
      .toBeNull()
  })
})

describe('SKILL_ROOT', () => {
  it('points at the repo root', () => {
    expect(existsSync(join(SKILL_ROOT, 'cli', 'package.json'))).toBe(true)
    expect(existsSync(join(SKILL_ROOT, 'scripts'))).toBe(true)
  })
})
