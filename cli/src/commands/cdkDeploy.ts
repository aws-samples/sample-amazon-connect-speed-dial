import { join } from 'node:path'
import { z } from 'zod'
import { CliError } from '../lib/errors.js'
import { deployEnv, run } from '../lib/proc.js'
import { readJsonFile } from '../lib/ui.js'

/** cdk --outputs-file writes a map of stack name → output key → string value.
 *  Validated rather than cast: four call sites read this file, and a truncated or
 *  hand-edited one used to surface as an undefined id much further downstream. */
const CdkOutputsSchema = z.record(z.string(), z.record(z.string(), z.string()))

export type CdkOutputs = z.infer<typeof CdkOutputsSchema>

/** Parse an already-read cdk-outputs.json payload. `path` only makes the error
 *  actionable. */
export function parseCdkOutputs(raw: unknown, path: string): CdkOutputs {
  const parsed = CdkOutputsSchema.safeParse(raw)
  if (!parsed.success) {
    throw new CliError(
      `cdk-outputs.json is not a map of stack name → outputs (strings only): ${path}`)
  }
  return parsed.data
}

/** Read and validate a rendered project's cdk-outputs.json. */
export function readCdkOutputs(path: string): CdkOutputs {
  return parseCdkOutputs(readJsonFile(path, 'cdk-outputs.json'), path)
}

export function cdkDeployAll(projectDir: string, region: string): CdkOutputs {
  run('npx', ['cdk', 'deploy', '--all', '--require-approval', 'never',
    '--outputs-file', 'cdk-outputs.json'], { cwd: projectDir, env: deployEnv(region) })
  return readCdkOutputs(join(projectDir, 'cdk-outputs.json'))
}

export function stackOutput(outputs: CdkOutputs, stackSuffix: string, key: string): string | null {
  for (const [stack, values] of Object.entries(outputs)) {
    if (stack.endsWith(stackSuffix) && values[key]) return values[key]
  }
  return null
}
