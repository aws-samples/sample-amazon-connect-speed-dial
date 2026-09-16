import { resolveRegion } from './shared.js'

// Wiring for `csp setup-widget`. No top-level `@aws-sdk/*` or adapter import.

export async function setupWidgetLive(
  projectDir: string, embedFile: string, securityKey: string, regionArg?: string,
): Promise<void> {
  // Region precedence: explicit arg → values file (project, then repo-root
  // legacy) → us-east-1. setupWidget validates whatever it is handed.
  const region = resolveRegion(projectDir, regionArg)
  const [{ setupWidget }, secretsManager, system] = await Promise.all([
    import('./setupWidget.js'),
    import('../adapters/secretsManager.js'),
    import('../adapters/system.js'),
  ])
  await setupWidget(projectDir, embedFile, securityKey, region, {
    toolchain: system.cdkToolchain(region),
    secrets: secretsManager.secretsManagerSecrets(region),
  })
}
