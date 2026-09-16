import { spawnSync } from 'node:child_process'
import { CliError } from './errors.js'
import { GREEN, NC } from './ui.js'

export function run(cmd: string, args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv }): void {
  console.log(`→ ${[cmd, ...args].join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd, env: opts.env ?? process.env })
  if (r.error) throw new CliError(`failed to start ${cmd}: ${r.error.message}`)
  if (r.status !== 0) throw new CliError(`command failed (exit ${r.status}): ${cmd}`)
}

export function runQuiet(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}):
  { status: number; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, env: opts.env ?? process.env })
  return { status: r.status ?? 1, stdout: r.stdout ?? '' }
}

/** CDK bundles Lambda assets (e.g. the boto3 layer) inside a container.
 *  Respect an explicit CDK_DOCKER; otherwise use docker when its daemon is
 *  up, else fall back to Finch (starting its VM if needed). */
export function containerRuntimeEnv(): Record<string, string> {
  if (process.env.CDK_DOCKER) return {}
  if (runQuiet('docker', ['info']).status === 0) return {}
  const finch = runQuiet('which', ['finch'])
  if (finch.status !== 0) {
    throw new CliError(
      'no container runtime for CDK asset bundling — start Docker Desktop, ' +
      'or install Finch (brew install finch), then rerun')
  }
  const finchPath = finch.stdout.trim()
  const status = runQuiet(finchPath, ['vm', 'status']).stdout.trim()
  if (status !== 'Running') {
    console.log(`→ Finch VM is ${status || 'unknown'} — starting it for CDK asset bundling...`)
    run(finchPath, ['vm', status === 'Nonexistent' ? 'init' : 'start'], {})
  }
  console.log(`${GREEN}✓ using Finch as the container runtime (CDK_DOCKER=finch)${NC}`)
  return { CDK_DOCKER: finchPath }
}

/** Region-pinned env for every npm/cdk invocation. Spread-merge, so a
 *  shell-exported AWS_DEFAULT_REGION is overridden rather than colliding. */
export function deployEnv(region: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    CDK_DEFAULT_REGION: region,
    ...containerRuntimeEnv(),
  }
}
