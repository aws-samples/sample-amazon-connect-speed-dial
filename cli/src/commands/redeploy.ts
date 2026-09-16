import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError } from '../lib/errors.js'
import { buildValues } from './values.js'
import { renderTemplates } from './render/render.js'
import { synthProject } from './synth.js'
import { deployEnv, run } from '../lib/proc.js'

const SKILL_DIR = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const TEMPLATES = join(SKILL_DIR, 'templates', 'cdk-app')

export function findOrderForProject(projectDir: string): { orderPath: string; project: string } {
  const dir = resolve(projectDir)
  const name = basename(dir)
  const project = name.startsWith('csp-') ? name.slice(4) : name
  const orderPath = join(dirname(dir), `.connect-skill-order.${project}.json`)
  if (!existsSync(orderPath)) {
    throw new CliError(`order file not found for project '${project}': expected ${orderPath}`)
  }
  return { orderPath, project }
}

/** Re-render from the skill templates and redeploy. The referenced-but-missing
 *  values → render (wipes and regenerates the
 *  project dir; order/values/prompts survive) → synth → cdk deploy. */
export function redeploy(projectDir: string, opts: { stack?: string }): void {
  const dir = resolve(projectDir)
  if (!existsSync(dir)) throw new CliError(`project dir not found: ${dir}`)
  const { orderPath, project } = findOrderForProject(dir)
  const valuesPath = join(dir, '.connect-skill-values.json')
  const values = buildValues(orderPath, valuesPath)
  const region = values.region
  renderTemplates(valuesPath, TEMPLATES, dir)
  synthProject(dir, region)
  const target = opts.stack ? [`${project}-${opts.stack}`] : ['--all']
  run('npx', ['cdk', 'deploy', ...target, '--require-approval', 'never',
    '--outputs-file', 'cdk-outputs.json'], { cwd: dir, env: deployEnv(region) })
}
