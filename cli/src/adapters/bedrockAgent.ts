import {
  BedrockAgentClient,
  GetKnowledgeBaseCommand,
  StartIngestionJobCommand,
  GetIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent'
import { CliError } from '../lib/errors.js'
import type { KnowledgeBases } from '../core/ports.js'

export function bedrockKnowledgeBases(region: string): KnowledgeBases {
  const bedrock = new BedrockAgentClient({ region })
  return {
    async startIngestion(knowledgeBaseId, dataSourceId) {
      const r = await bedrock.send(new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId }))
      const jobId = r.ingestionJob?.ingestionJobId
      if (!jobId) throw new CliError('StartIngestionJob returned no job id')
      return jobId
    },
    async getIngestion(knowledgeBaseId, dataSourceId, ingestionJobId) {
      const r = await bedrock.send(new GetIngestionJobCommand({
        knowledgeBaseId, dataSourceId, ingestionJobId }))
      const job = r.ingestionJob
      if (!job?.status) throw new CliError(`GetIngestionJob returned no status for ${ingestionJobId}`)
      return {
        status: job.status,
        failureReasons: job.failureReasons,
        statistics: job.statistics as unknown as Record<string, number> | undefined,
      }
    },
    async status(knowledgeBaseId) {
      const r = await bedrock.send(new GetKnowledgeBaseCommand({ knowledgeBaseId }))
      const status = r.knowledgeBase?.status
      if (!status) {
        throw new CliError(`GetKnowledgeBase returned no status for knowledge base ${knowledgeBaseId}`)
      }
      return status
    },
  }
}
