import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { CliError } from '../../lib/errors.js'
import { readJsonObject } from '../../lib/ui.js'
import { serializeJson } from '../values.js'
import { findLeftoverPlaceholders, injectSnippetBeforeMessages, substitutePlaceholders } from './text.js'
import { validatePromptsDir } from './prompts.js'

const PRESERVE_ON_CLEAN = new Set(['node_modules', 'cdk.out', 'cdk-outputs.json'])
const SUBSTITUTED_EXTENSIONS = ['.ts', '.json', '.md', '.sh']
const LEFTOVER_CHECK_EXTENSIONS = ['.ts', '.json', '.md'] // text targets that must carry no leftover placeholders
const EXCLUDED_DIRS = new Set(['node_modules', 'cdk.out'])

function hasExt(name: string, exts: string[]): boolean {
  return exts.some((e) => name.endsWith(e))
}

/** Recursively collect files under dir with one of the given extensions,
 *  skipping node_modules/cdk.out. */
function collectFiles(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) out.push(...collectFiles(p, exts))
    } else if (hasExt(entry.name, exts) && basename(entry.name) !== '.placeholder') {
      out.push(p)
    }
  }
  return out
}

export function renderTemplates(valuesFile: string, srcDir: string, destDir: string): void {
  if (!existsSync(valuesFile)) throw new CliError(`values file not found: ${valuesFile}`)
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new CliError(`source dir not found: ${srcDir}`)
  }
  const values = readJsonObject(valuesFile, 'values file')

  // Clean the destination before copying so stale files from previous template
  // versions don't linger. Preserve runtime artifacts that are expensive to
  // recreate or hold deploy state (and dotfiles, e.g. project-scoped values).
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(destDir)) {
    if (PRESERVE_ON_CLEAN.has(entry) || entry.startsWith('.')) continue
    rmSync(join(destDir, entry), { recursive: true, force: true })
  }
  cpSync(srcDir, destDir, { recursive: true })

  // User-asset dir (custom prompts, saml-metadata.xml): the PARENT of the
  // rendered project dir — survives re-renders in both the legacy layout
  // (values at repo root) and the project-scoped layout.
  const workDir = dirname(resolve(destDir))
  for (const name of ['orchestration', 'self-service']) {
    const userPrompt = join(workDir, 'prompts', `${name}.md`)
    if (existsSync(userPrompt)) cpSync(userPrompt, join(destDir, 'prompts', `${name}.md`))
  }
  const saml = join(workDir, 'saml-metadata.xml')
  if (existsSync(saml)) cpSync(saml, join(destDir, 'saml-metadata.xml'))

  // Context-usage instruction: appended before `messages:` when Customer
  // Profiles is enabled (it is what populates {{$.Custom.*}}). Absent key →
  // enabled, matching the schema default.
  // (A `contextInjectionEnabled` flag used to be OR-ed in here; nothing emits
  // or consumes it any more, so the condition was dead weight.)
  const orchPath = join(destDir, 'prompts', 'orchestration.md')
  const snippetPath = join(destDir, 'prompts', 'context-injection.snippet.md')
  const profilesOn = values.customerProfilesEnabled == null ? true : values.customerProfilesEnabled === true
  if (profilesOn && existsSync(orchPath) && existsSync(snippetPath)) {
    writeFileSync(orchPath, injectSnippetBeforeMessages(
      readFileSync(orchPath, 'utf8'), readFileSync(snippetPath, 'utf8')))
  }
  // The snippet is a build-time fragment, not a deployable prompt.
  rmSync(snippetPath, { force: true })

  validatePromptsDir(join(destDir, 'prompts'))

  // lib/deployment-values.json: the subset lib/config.ts imports directly —
  // no {{...}} placeholders in TypeScript source. Excluded from substitution.
  // `?? null` is deliberate: emit `"key": null` for absent keys (which
  // JSON.stringify would silently drop) so lib/config.ts always sees every
  // key explicitly.
  const deployValuesPath = join(destDir, 'lib', 'deployment-values.json')
  mkdirSync(dirname(deployValuesPath), { recursive: true })
  writeFileSync(deployValuesPath, serializeJson({
    prefix: values.projectName ?? null,
    customerProfilesEnabled: values.customerProfilesEnabled ?? null,
    retainData: values.retainData ?? null,
    frontendEnabled: values.frontendEnabled ?? null,
    dataLakeEnabled: values.dataLakeEnabled ?? null,
    contactEventsEnabled: values.contactEventsEnabled ?? null,
    knowledgeBaseEnabled: values.knowledgeBaseEnabled ?? null,
    identityCenterEnabled: values.identityCenterEnabled ?? null,
    promptLanguage: values.promptLanguage ?? null,
    connectWidgets: values.connectWidgets ?? [],
  }))

  // {{key}} substitution across the tree (same extension set as the sed pass).
  for (const file of collectFiles(destDir, SUBSTITUTED_EXTENSIONS)) {
    if (resolve(file) === resolve(deployValuesPath)) continue
    const content = readFileSync(file, 'utf8')
    const substituted = substitutePlaceholders(content, values)
    if (substituted !== content) writeFileSync(file, substituted)
  }

  // Hard error on leftover placeholders in the checked text targets.
  const offenders: string[] = []
  for (const file of collectFiles(destDir, LEFTOVER_CHECK_EXTENSIONS)) {
    for (const line of findLeftoverPlaceholders(readFileSync(file, 'utf8'))) {
      offenders.push(`${relative(destDir, file)}: ${line.trim()}`)
    }
  }
  if (offenders.length > 0) {
    throw new CliError(
      `unsubstituted placeholders remain in rendered output\n${offenders.join('\n')}`)
  }

  console.log(`rendered ${srcDir} -> ${destDir}`)
}
