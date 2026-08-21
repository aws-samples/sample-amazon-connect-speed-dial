import { join } from 'node:path'
import { readOutputs, resolveRegion } from './shared.js'

// Wiring and I/O for `csp sync-kb`. No top-level `@aws-sdk/*` or adapter import.

/** Sync content into the knowledge base a rendered project owns. */
export async function syncKbLive(
  projectDir: string, contentPath: string, regionArg?: string,
): Promise<void> {
  const region = resolveRegion(projectDir, regionArg)
  const outputs = readOutputs(projectDir)

  const [{ syncKb, renderSync, kbTargetFrom }, s3, bedrockAgent, system] = await Promise.all([
    import('./syncKb.js'),
    import('../adapters/s3.js'),
    import('../adapters/bedrockAgent.js'),
    import('../adapters/system.js'),
  ])

  const target = kbTargetFrom(outputs, join(projectDir, 'cdk-outputs.json'))
  const report = await syncKb(contentPath, target, {
    storage: s3.s3ObjectStore(region),
    knowledgeBases: bedrockAgent.bedrockKnowledgeBases(region),
    clock: system.systemClock,
  })
  for (const line of renderSync(report)) console.log(line)
}
