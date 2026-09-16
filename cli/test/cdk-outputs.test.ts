import { describe, it, expect } from 'vitest'
import { parseCdkOutputs, stackOutput } from '../src/commands/cdkDeploy.js'
import { CliError } from '../src/lib/errors.js'

// cdk-outputs.json is read by four call sites (cdk-deploy, smoke-test,
// setup-widget, teardown) and every id the post-deploy steps use comes from it.
// It used to be an unchecked `as CdkOutputs` cast, so a truncated or hand-edited
// file surfaced as an undefined id much further downstream.
describe('parseCdkOutputs', () => {
  const path = '/p/cdk-outputs.json'

  it('accepts the shape cdk --outputs-file writes', () => {
    const raw = {
      'proj-ConnectInstance': { InstanceId: 'i-1', IdentityManagementType: 'SAML' },
      'proj-Wisdom': { AssistantId: 'as-1' },
    }
    expect(parseCdkOutputs(raw, path)).toEqual(raw)
  })

  it('accepts a stack with no outputs at all', () => {
    expect(parseCdkOutputs({ 'proj-Empty': {} }, path)).toEqual({ 'proj-Empty': {} })
  })

  it('accepts an empty file (nothing deployed yet)', () => {
    expect(parseCdkOutputs({}, path)).toEqual({})
  })

  it.each([
    ['a top-level array', [{ InstanceId: 'i-1' }]],
    ['a scalar', 'nope'],
    ['null', null],
    ['a non-object stack entry', { 'proj-X': 'not-an-object' }],
    ['a non-string output value', { 'proj-X': { InstanceId: 42 } }],
    ['a null output value', { 'proj-X': { InstanceId: null } }],
  ])('rejects %s with a message naming the file', (_label, raw) => {
    expect(() => parseCdkOutputs(raw, path)).toThrow(CliError)
    expect(() => parseCdkOutputs(raw, path)).toThrow(
      `cdk-outputs.json is not a map of stack name → outputs (strings only): ${path}`)
  })
})

describe('stackOutput', () => {
  const outputs = {
    'proj-ConnectInstance': { InstanceId: 'i-1' },
    'proj-ContactEvents': { RuleArn: 'arn:r' },
  }

  it('matches on the -<suffix> boundary', () => {
    expect(stackOutput(outputs, '-ConnectInstance', 'InstanceId')).toBe('i-1')
  })

  it('is null for a missing stack or key', () => {
    expect(stackOutput(outputs, '-Wisdom', 'AssistantId')).toBeNull()
    expect(stackOutput(outputs, '-ConnectInstance', 'Nope')).toBeNull()
  })
})
