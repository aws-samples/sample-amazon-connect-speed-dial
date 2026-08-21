import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CliError } from '../../lib/errors.js'

/** A user may freely rewrite the persona, but
 *  dropping a required runtime variable or the message-formatting structure
 *  breaks the deployed agent — fail loudly before render/deploy. */
export function validatePromptsDir(promptsDir: string): void {
  const orch = join(promptsDir, 'orchestration.md')
  const self = join(promptsDir, 'self-service.md')
  if (!existsSync(orch)) throw new CliError(`orchestration prompt not found: ${orch}`)
  if (!existsSync(self)) throw new CliError(`self-service prompt not found: ${self}`)

  const require = (file: string, needle: string, desc: string): void => {
    if (!readFileSync(file, 'utf8').includes(needle)) {
      throw new CliError(`${basename(file)} is missing ${desc} ('${needle}')`)
    }
  }
  require(orch, 'system:', 'the system block')
  require(orch, '{{$.conversationHistory}}', 'the conversation-history variable')
  require(orch, '<message>', 'the <message> formatting tag')
  require(self, '{{$.contentExcerpt}}', 'the content-excerpt variable')
}
