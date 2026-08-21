import { createInterface } from 'node:readline/promises'
import { run, runQuiet } from '../lib/proc.js'
import type { Clock, Prompt, Shell, Toolchain } from '../core/ports.js'

export const systemClock: Clock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

// The non-AWS collaborators. `run`/`runQuiet` stay in proc.ts, which also owns
// the container-runtime probe that `cdk deploy` needs; this adapter only exposes
// them through a port so commands can be tested without spawning.

export const spawnShell: Shell = { run, runQuiet }

export const stdinPrompt: Prompt = {
  async ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return await rl.question(question)
    } finally {
      rl.close()
    }
  },
}

/** Region-pinned env for the CDK CLI. Only the three region vars: bootstrap
 *  bundles no Lambda assets, so proc.ts's container-runtime probe is not wanted. */
const cdkEnv = (region: string): NodeJS.ProcessEnv => ({
  ...process.env,
  AWS_REGION: region,
  AWS_DEFAULT_REGION: region,
  CDK_DEFAULT_REGION: region,
})

export function cdkToolchain(region: string, shell: Shell = spawnShell): Toolchain {
  return {
    async cdkAvailable() {
      if (shell.runQuiet('cdk', ['--version']).status === 0) return true
      return shell.runQuiet('npx', ['--no-install', 'cdk', '--version']).status === 0
    },
    async bootstrap(account) {
      shell.run('npx', ['cdk', 'bootstrap', `aws://${account}/${region}`], { env: cdkEnv(region) })
    },
    deployStackExclusively(projectDir, stackName) {
      // --exclusively keeps the deploy to this stack alone. Without it CDK pulls
      // in the ConnectInstance dependency stack and tries to recreate the
      // (already existing) storage bucket.
      shell.run('npx', ['cdk', 'deploy', stackName, '--exclusively',
        '--require-approval', 'never', '--outputs-file', 'cdk-outputs.json'],
        { cwd: projectDir, env: cdkEnv(region) })
    },
    destroyAll(projectDir) {
      shell.run('npx', ['cdk', 'destroy', '--all', '--force'],
        { cwd: projectDir, env: cdkEnv(region) })
    },
  }
}
