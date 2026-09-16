import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CliError } from '../lib/errors.js'
import { serializeJson } from './values.js'
import { readJsonObject } from '../lib/ui.js'
import { readCdkOutputs } from './cdkDeploy.js'
import { SKILL_ROOT } from './shared.js'
import { ok, info, GREEN, YELLOW, NC } from '../lib/ui.js'
import type { Secrets, Toolchain } from '../core/ports.js'
import { extractWidget, upsertWidget } from './widgetEmbed.js'

// Wire up an Amazon Connect
// communication widget for the web-call frontend, end to end:
//   1. Extract id/snippetId/scriptUrl from the pasted embed snippet and patch
//      lib/deployment-values.json (widgetEmbed.ts replaces extract-widget.js).
//      The CDK app reads this JSON at synth time via lib/config.ts.
//   2. Deploy the <prefix>-WebcallWidget stack so the widget config and an
//      (empty) Secrets Manager secret are created.
//   3. Write the security key into that secret so the token Lambda can sign JWTs.
//
// Idempotent: re-running replaces the widget entry and overwrites the secret.
// The security key must NEVER appear on stdout/stderr — no message may
// interpolate it.

export interface SetupWidgetPorts {
  toolchain: Pick<Toolchain, 'deployStackExclusively'>
  secrets: Secrets
}

export async function setupWidget(
  projectDir: string,
  embedFile: string,
  securityKey: string,
  region: string,
  aws: SetupWidgetPorts,
  /** Test seam: repo root for the legacy values-file fallback. */
  skillRoot: string = SKILL_ROOT,
): Promise<void> {
  const deployValuesPath = join(projectDir, 'lib', 'deployment-values.json')

  if (region !== 'us-east-1' && region !== 'eu-central-1') {
    throw new CliError(`unsupported region '${region}' (pass it as the 4th arg: us-east-1 or eu-central-1)`)
  }

  if (!existsSync(deployValuesPath)) {
    throw new CliError(`deployment-values.json not found at ${deployValuesPath} (is <project-dir> a rendered project?)`)
  }
  if (!existsSync(embedFile)) throw new CliError(`embed file not found: ${embedFile}`)
  if (!securityKey) throw new CliError('security key is empty')

  // --- 1. Extract + patch deployment-values.json ----------------------------
  info('Extracting widget fields and patching deployment-values.json...')
  const widget = extractWidget(readFileSync(embedFile, 'utf8'))
  const values = readJsonObject(deployValuesPath, 'deployment-values.json')
  const prefix = values.prefix
  if (typeof prefix !== 'string' || !prefix) {
    // A project without a prefix has not been rendered, so nothing can be deployed.
    throw new CliError('deployment-values.json has an empty prefix — render the project first')
  }
  writeFileSync(deployValuesPath, serializeJson(upsertWidget(values, widget)))
  ok(`Widget ${widget.id} extracted; deployment-values.json patched (prefix: ${prefix})`)

  // Persist the widget entry to .connect-skill-values.json so that future
  // renders restore the connectWidgets array automatically — a re-render
  // otherwise overwrites lib/deployment-values.json from the order.
  // Project-scoped values file first; repo-root is the legacy fallback.
  // NOTE: unlike the deployment-values upsert above, this REPLACES the whole
  // connectWidgets array — the values file tracks the current widget, not a set.
  const projectValues = join(projectDir, '.connect-skill-values.json')
  const persistPath = existsSync(projectValues)
    ? projectValues
    : join(skillRoot, '.connect-skill-values.json')
  if (existsSync(persistPath)) {
    const persisted = readJsonObject(persistPath, 'values file')
    persisted.connectWidgets = [widget]
    writeFileSync(persistPath, serializeJson(persisted))
    ok(`Widget persisted to ${basename(persistPath)} (survives re-render)`)
  } else {
    // Deliberately stderr: warn() writes to stdout, and losing the widget on the
    // next render is something the operator must see even when stdout is piped.
    console.error(`${YELLOW}⚠ Could not find .connect-skill-values.json to persist widget — re-render will lose it${NC}`)
  }

  // --- 2. Deploy the widget stack --------------------------------------------
  // This (re)creates config.js with the widget and the empty signing-key secret.
  const stackName = `${prefix}-WebcallWidget`
  info(`Deploying ${stackName} stack in ${region} (this can take a few minutes)...`)
  try {
    aws.toolchain.deployStackExclusively(projectDir, stackName)
  } catch {
    throw new CliError(`cdk deploy of ${stackName} failed`)
  }
  ok('Widget stack deployed')

  // --- 3. Write the security key into the widget's Secrets Manager secret ----
  const secretName = `${prefix}-widget-secret-${widget.id}`
  info(`Storing security key in Secrets Manager secret: ${secretName}`)
  try {
    await aws.secrets.put(secretName, securityKey)
  } catch {
    // deliberately no cause interpolation — nothing derived from the key may leak
    throw new CliError(`failed to write security key to secret ${secretName}`)
  }
  ok('Security key stored')

  // --- Report the live URL ---------------------------------------------------
  // Re-read the outputs file the deploy just refreshed; tolerate it missing or
  // unparsable — a missing URL must not fail a deploy that already succeeded.
  let cloudFrontUrl = ''
  try {
    const outputs = readCdkOutputs(join(projectDir, 'cdk-outputs.json'))
    cloudFrontUrl = outputs[stackName]?.CloudFrontUrl ?? ''
  } catch { /* no URL line */ }

  console.log('')
  console.log('==========================================')
  console.log('Web-call widget configured')
  console.log('==========================================')
  if (cloudFrontUrl) console.log(`Web-call site:  ${cloudFrontUrl}`)
  console.log(`Widget ID:      ${widget.id}`)
  console.log(`Secret:         ${secretName}`)
  console.log('')
  console.log(`${GREEN}✓ Done.${NC} Create a Cognito login for the user pool, then open the site and click to call.`)
  console.log(`${YELLOW}  (No login yet? Add one in the Cognito console for the ${prefix}-webcall-users pool.)${NC}`)
}
