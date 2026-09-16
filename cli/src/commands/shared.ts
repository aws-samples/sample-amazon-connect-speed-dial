import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError } from '../lib/errors.js'
import { readJsonObject } from '../lib/ui.js'
import { readCdkOutputs, stackOutput, type CdkOutputs } from './cdkDeploy.js'

/** Repo root (= skill dir), resolved from this module's location
 *  (cli/src/commands/shared.ts → three levels up). */
export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** `region` from a values file, or null when the file/key is absent. */
function valuesFileRegion(valuesPath: string): string | null {
  if (!existsSync(valuesPath)) return null
  const region = readJsonObject(valuesPath, 'values file').region
  return typeof region === 'string' && region !== '' ? region : null
}

/** Region precedence used by sync-kb/setup-widget/teardown/setup-test-users:
 *  explicit arg → values file `region` key (project-scoped, repo-root legacy
 *  fallback) → env (teardown only) → 'us-east-1'. */
export function resolveRegion(projectDir: string, regionArg?: string, useEnv?: boolean): string {
  return resolveRegionFrom(projectDir, SKILL_ROOT, regionArg, useEnv)
}

/** Testable core of resolveRegion with an explicit repo root. */
export function resolveRegionFrom(
  projectDir: string, skillRoot: string, regionArg?: string, useEnv?: boolean,
): string {
  if (regionArg) return regionArg
  const projectValues = join(projectDir, '.connect-skill-values.json')
  const valuesPath = existsSync(projectValues)
    ? projectValues
    : join(skillRoot, '.connect-skill-values.json')
  const fromValues = valuesFileRegion(valuesPath)
  if (fromValues) return fromValues
  if (useEnv) {
    const fromEnv = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
    if (fromEnv) return fromEnv
  }
  return 'us-east-1'
}

/** Read <projectDir>/cdk-outputs.json; CliError with a deploy-first hint
 *  when missing. */
export function readOutputs(projectDir: string): CdkOutputs {
  const path = join(projectDir, 'cdk-outputs.json')
  if (!existsSync(path)) {
    throw new CliError(`cdk-outputs.json not found at ${path} (deploy the project first)`)
  }
  return readCdkOutputs(path)
}

/** First value of key from the stack whose name ends with `-<suffix>` (empty → null). */
export function outputBySuffix(outputs: CdkOutputs, suffix: string, key: string): string | null {
  return stackOutput(outputs, `-${suffix}`, key)
}
