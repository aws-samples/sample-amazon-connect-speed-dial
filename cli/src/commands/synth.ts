import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CliError } from '../lib/errors.js'
import { deployEnv, run, runQuiet } from '../lib/proc.js'

/** npm ci (fallback install) → tsc --noEmit → cdk synth --quiet, region-pinned. */
export function synthProject(projectDir: string, region: string): void {
  if (!existsSync(join(projectDir, 'package.json'))) {
    throw new CliError(`not a rendered project (no package.json): ${projectDir}`)
  }
  const env = deployEnv(region)
  if (runQuiet('npm', ['ci', '--silent'], { cwd: projectDir, env }).status !== 0) {
    run('npm', ['install', '--silent'], { cwd: projectDir, env })
  }
  run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], { cwd: projectDir, env })
  run('npx', ['cdk', 'synth', '--quiet'], { cwd: projectDir, env })
}
