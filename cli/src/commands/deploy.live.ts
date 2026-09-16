import { renderTemplates } from './render/render.js'
import { synthProject } from './synth.js'
import { cdkDeployAll } from './cdkDeploy.js'
import type { DeployPorts } from './deploy.js'

// Production wiring for the one-shot pipeline. render/synth/deployAll are
// synchronous, so they are imported statically — none of them touches
// `@aws-sdk/*` (they shell out to the CDK CLI), so `csp --help` is unaffected
// and startup-cost.test.ts keeps that honest. Everything AWS-facing is a
// dynamic import.
export function realDeployPorts(): DeployPorts {
  return {
    render: renderTemplates,
    synth: synthProject,
    deployAll: cdkDeployAll,
    async interview(opts) {
      const [{ interview }, { stdinPrompt }] = await Promise.all([
        import('./interview.js'),
        import('../adapters/system.js'),
      ])
      return interview(opts, stdinPrompt)
    },
    async confirmOrder(orderRaw, prefs, account) {
      const [{ confirmOrder }, { stdinPrompt }] = await Promise.all([
        import('./interview.js'),
        import('../adapters/system.js'),
      ])
      return confirmOrder(orderRaw, prefs, account, stdinPrompt)
    },
    async callerAccount(region) {
      const { callerAccountLive } = await import('./preflight.live.js')
      return callerAccountLive(region)
    },
    async preflight(opts) {
      const { preflightLive } = await import('./preflight.live.js')
      return preflightLive(opts)
    },
    async claimDid(instanceId, flowId, region) {
      const { claimDidLive } = await import('./claimDid.live.js')
      return claimDidLive(instanceId, flowId, region)
    },
    async syncKb(projectDir, contentPath, region) {
      const { syncKbLive } = await import('./syncKb.live.js')
      return syncKbLive(projectDir, contentPath, region)
    },
    async smokeTest(input) {
      const { smokeTestLive } = await import('./smokeTest.live.js')
      return smokeTestLive(input)
    },
  }
}
