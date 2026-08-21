import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CliError } from '../lib/errors.js'
import { SKILL_ROOT } from './shared.js'

/** Seed editable agent-prompt files into the working directory so users can
 *  customize the orchestration and self-service prompts. Copies the blueprint
 *  defaults only when a file does not already exist — so it is safe to re-run
 *  and never clobbers a user's edits.
 *  @param workingDir target directory for prompts/
 *  @param skillRoot repo root (defaults to SKILL_ROOT); testable alternative for testing error cases */
export function initPrompts(workingDir: string, skillRoot: string = SKILL_ROOT): void {
  const src = join(skillRoot, 'templates', 'cdk-app', 'prompts')
  const dest = join(workingDir, 'prompts')

  if (!existsSync(src)) {
    throw new CliError(`seed prompts not found: ${src}`)
  }

  mkdirSync(dest, { recursive: true })

  for (const name of ['orchestration', 'self-service']) {
    const destFile = join(dest, `${name}.md`)
    if (existsSync(destFile)) {
      console.log(`kept existing ${destFile}`)
    } else {
      copyFileSync(join(src, `${name}.md`), destFile)
      console.log(`seeded ${destFile}`)
    }
  }
}
