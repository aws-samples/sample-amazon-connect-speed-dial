import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CliError } from '../lib/errors.js'
import { readJsonFile, readJsonObject, YELLOW, NC } from '../lib/ui.js'
import { parseOrder, deriveValues, type Values } from '../core/schema.js'

/** Stable pretty print: 2-space indent + trailing newline. Keeps values and
 *  order files deterministic and human-diffable across runs. */
export function serializeJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n'
}

export function readOrderFile(orderPath: string): ReturnType<typeof parseOrder> {
  if (!existsSync(orderPath)) throw new CliError(`order file not found: ${orderPath}`)
  return parseOrder(readJsonFile(orderPath, 'order file'))
}

/** Keys in an existing values file that are NOT derived from the order file:
 *  post-deploy state written back by other commands. The order file is
 *  authoritative for everything else, so only these survive regeneration.
 *
 *  connectWidgets is written by `csp setup-widget` specifically so the widget
 *  survives a re-render (render.ts feeds it into lib/deployment-values.json,
 *  and the widget stack creates one signing-key secret per entry). Dropping it
 *  here made `csp redeploy` synthesize the widget stack with zero widgets,
 *  which un-configures the live web-call site AND deletes the Secrets Manager
 *  secret holding the widget signing key. */
const CARRIED_OVER_KEYS = ['connectWidgets'] as const

export function buildValues(orderPath: string, outPath: string): Values {
  const values = deriveValues(readOrderFile(orderPath))

  // Best-effort carry-over: a values file that is missing or unreadable must
  // not block a deploy, but losing post-deploy state silently would.
  const carried: Record<string, unknown> = {}
  if (existsSync(outPath)) {
    try {
      const prior = readJsonObject(outPath, 'values file')
      for (const key of CARRIED_OVER_KEYS) {
        if (prior[key] !== undefined) carried[key] = prior[key]
      }
    } catch {
      console.error(
        `${YELLOW}⚠ ${outPath} could not be read as JSON — regenerating it from the order file. `
        + `If a web-call widget was configured, re-run csp setup-widget afterwards.${NC}`)
    }
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, serializeJson({ ...values, ...carried }))
  console.log(`wrote ${outPath}`)
  return values
}
