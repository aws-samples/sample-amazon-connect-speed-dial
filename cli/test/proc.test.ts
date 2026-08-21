import { describe, it, expect } from 'vitest'
import { run, runQuiet, deployEnv } from '../src/lib/proc.js'
import { CliError } from '../src/lib/errors.js'

describe('run', () => {
  it('succeeds silently for exit 0', () => {
    expect(() => run('true', [], {})).not.toThrow()
  })
  it('throws CliError with the exit code for non-zero', () => {
    expect(() => run('false', [], {})).toThrow(CliError)
    expect(() => run('false', [], {})).toThrow('command failed (exit 1): false')
  })
})

describe('runQuiet', () => {
  it('captures stdout and status', () => {
    const r = runQuiet('echo', ['hello'])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('hello')
  })
  it('does not throw on failure', () => {
    expect(runQuiet('false', []).status).toBe(1)
  })
})

describe('deployEnv', () => {
  it('pins all three region vars', () => {
    process.env.CDK_DOCKER = '/usr/local/bin/docker' // skip runtime probing in tests
    const env = deployEnv('eu-central-1')
    expect(env.AWS_REGION).toBe('eu-central-1')
    expect(env.AWS_DEFAULT_REGION).toBe('eu-central-1')
    expect(env.CDK_DEFAULT_REGION).toBe('eu-central-1')
    delete process.env.CDK_DOCKER
  })
})
