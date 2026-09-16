import { describe, it, expect, vi } from 'vitest'
import { cdkToolchain, systemClock, spawnShell } from '../../src/adapters/system.js'
import type { Shell } from '../../src/core/ports.js'

// cdkToolchain takes a Shell, so the exact CDK argv is assertable without ever
// spawning a process. These flags are load-bearing and easy to break silently.
interface Call { cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }

function fakeShell(quietStatus: (cmd: string, args: string[]) => number = () => 0):
Shell & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    run(cmd, args, opts) { calls.push({ cmd, args, cwd: opts.cwd, env: opts.env }) },
    runQuiet(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts?.cwd })
      return { status: quietStatus(cmd, args), stdout: '' }
    },
  }
}

describe('cdkToolchain.cdkAvailable', () => {
  it('accepts a global cdk without falling back', async () => {
    const shell = fakeShell()
    expect(await cdkToolchain('us-east-1', shell).cdkAvailable()).toBe(true)
    expect(shell.calls).toEqual([{ cmd: 'cdk', args: ['--version'], cwd: undefined }])
  })

  it('falls back to a locally installed cdk via npx --no-install', async () => {
    // --no-install matters: without it npx would DOWNLOAD a cdk mid-preflight.
    const shell = fakeShell((cmd) => (cmd === 'cdk' ? 1 : 0))
    expect(await cdkToolchain('us-east-1', shell).cdkAvailable()).toBe(true)
    expect(shell.calls[1]).toMatchObject({ cmd: 'npx', args: ['--no-install', 'cdk', '--version'] })
  })

  it('is false when neither is present', async () => {
    const shell = fakeShell(() => 1)
    expect(await cdkToolchain('us-east-1', shell).cdkAvailable()).toBe(false)
  })
})

describe('cdkToolchain.bootstrap', () => {
  it('targets the account/region pair explicitly', async () => {
    const shell = fakeShell()
    await cdkToolchain('eu-central-1', shell).bootstrap('123456789012')
    expect(shell.calls[0]!.args)
      .toEqual(['cdk', 'bootstrap', 'aws://123456789012/eu-central-1'])
  })

  it('pins all three region vars in the child env', async () => {
    const shell = fakeShell()
    await cdkToolchain('eu-central-1', shell).bootstrap('123456789012')
    expect(shell.calls[0]!.env).toMatchObject({
      AWS_REGION: 'eu-central-1',
      AWS_DEFAULT_REGION: 'eu-central-1',
      CDK_DEFAULT_REGION: 'eu-central-1',
    })
  })
})

describe('cdkToolchain.deployStackExclusively', () => {
  it('deploys the named stack with --exclusively and writes the outputs file', () => {
    // Without --exclusively, CDK pulls in the ConnectInstance dependency stack and
    // tries to recreate the already-existing storage bucket.
    const shell = fakeShell()
    cdkToolchain('us-east-1', shell).deployStackExclusively('/p', 'proj-WebcallWidget')
    expect(shell.calls[0]).toMatchObject({
      cmd: 'npx',
      args: ['cdk', 'deploy', 'proj-WebcallWidget', '--exclusively',
        '--require-approval', 'never', '--outputs-file', 'cdk-outputs.json'],
      cwd: '/p',
    })
  })
})

describe('cdkToolchain.destroyAll', () => {
  it('destroys every stack without prompting', () => {
    const shell = fakeShell()
    cdkToolchain('us-east-1', shell).destroyAll('/p')
    expect(shell.calls[0]).toMatchObject({
      cmd: 'npx', args: ['cdk', 'destroy', '--all', '--force'], cwd: '/p',
    })
  })
})

describe('systemClock', () => {
  it('waits the requested time', async () => {
    vi.useFakeTimers()
    let done = false
    const p = systemClock.sleep(10_000).then(() => { done = true })
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    await p
    expect(done).toBe(true)
    vi.useRealTimers()
  })
})

describe('spawnShell', () => {
  it('reports a non-zero exit as a CliError naming the code', () => {
    expect(() => spawnShell.run(process.execPath, ['-e', 'process.exit(3)'], {}))
      .toThrow(/command failed \(exit 3\)/)
  })

  it('returns the status from runQuiet instead of throwing', () => {
    expect(spawnShell.runQuiet(process.execPath, ['-e', 'process.exit(4)']).status).toBe(4)
  })
})
