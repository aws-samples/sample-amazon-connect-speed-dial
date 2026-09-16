import {
  QConnectClient,
  GetAIAgentCommand,
  paginateListAssistants,
  paginateListAIAgents,
  paginateListAIAgentVersions,
} from '@aws-sdk/client-qconnect'
import { CliError } from '../lib/errors.js'
import type { AiAgents } from '../core/ports.js'

export function qConnectAiAgents(region: string): AiAgents {
  const qconnect = new QConnectClient({ region })
  return {
    async status(assistantId, agentId) {
      const r = await qconnect.send(new GetAIAgentCommand({ assistantId, aiAgentId: agentId }))
      const status = r.aiAgent?.status
      if (!status) throw new CliError(`GetAIAgent returned no status for agent ${agentId}`)
      return status
    },
    async findAssistantIdByName(name) {
      for await (const page of paginateListAssistants({ client: qconnect }, {})) {
        const hit = page.assistantSummaries?.find((a) => a.name === name)
        if (hit?.assistantId) return hit.assistantId
      }
      return null
    },
    async findAgentIdByName(assistantId, name) {
      for await (const page of paginateListAIAgents({ client: qconnect }, { assistantId })) {
        const hit = page.aiAgentSummaries?.find((a) => a.name === name)
        if (hit?.aiAgentId) return hit.aiAgentId
      }
      return null
    },
    async versionNumbers(assistantId, aiAgentId) {
      const versions: number[] = []
      for await (const page of paginateListAIAgentVersions({ client: qconnect },
        { assistantId, aiAgentId })) {
        for (const v of page.aiAgentVersionSummaries ?? []) {
          if (typeof v.versionNumber === 'number') versions.push(v.versionNumber)
        }
      }
      return versions
    },
  }
}
