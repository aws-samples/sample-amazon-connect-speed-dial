import { describe, it, expect, beforeEach } from 'vitest'
import { mockClient } from 'aws-sdk-client-mock'
import {
  QConnectClient, GetAIAgentCommand, ListAssistantsCommand, ListAIAgentsCommand,
  ListAIAgentVersionsCommand,
} from '@aws-sdk/client-qconnect'
import {
  BedrockAgentClient, GetKnowledgeBaseCommand, StartIngestionJobCommand, GetIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent'
import { qConnectAiAgents } from '../../src/adapters/qconnect.js'
import { bedrockKnowledgeBases } from '../../src/adapters/bedrockAgent.js'
import { CliError } from '../../src/lib/errors.js'

const qconnect = mockClient(QConnectClient)
const bedrockAgent = mockClient(BedrockAgentClient)
beforeEach(() => { qconnect.reset(); bedrockAgent.reset() })

describe('qConnectAiAgents', () => {
  it('returns the agent status', async () => {
    qconnect.on(GetAIAgentCommand).resolves({ aiAgent: { status: 'ACTIVE' } } as never)
    expect(await qConnectAiAgents('us-east-1').status('as-1', 'ag-1')).toBe('ACTIVE')
  })

  it('throws when the response carries no status', async () => {
    qconnect.on(GetAIAgentCommand).resolves({ aiAgent: {} } as never)
    await expect(qConnectAiAgents('us-east-1').status('as-1', 'ag-1'))
      .rejects.toThrow(new CliError('GetAIAgent returned no status for agent ag-1'))
  })

  it('finds an assistant by name across pages', async () => {
    qconnect.on(ListAssistantsCommand)
      .resolvesOnce({ assistantSummaries: [{ assistantId: 'a', name: 'other' }], nextToken: 't' } as never)
      .resolvesOnce({ assistantSummaries: [{ assistantId: 'as-9', name: 'proj-assistant' }] } as never)
    expect(await qConnectAiAgents('us-east-1').findAssistantIdByName('proj-assistant'))
      .toBe('as-9')
  })

  it('finds an agent by name across pages', async () => {
    qconnect.on(ListAIAgentsCommand)
      .resolvesOnce({ aiAgentSummaries: [{ aiAgentId: 'x', name: 'other' }], nextToken: 't' } as never)
      .resolvesOnce({ aiAgentSummaries: [{ aiAgentId: 'ag-9', name: 'proj-orchestrator' }] } as never)
    expect(await qConnectAiAgents('us-east-1').findAgentIdByName('as-1', 'proj-orchestrator'))
      .toBe('ag-9')
  })

  it('accumulates version numbers ACROSS PAGES and ignores non-numeric ones', async () => {
    // Missing a page here left agent versions attached, which blocks the
    // security-profile detach and then the instance delete.
    qconnect.on(ListAIAgentVersionsCommand)
      .resolvesOnce({ aiAgentVersionSummaries: [{ versionNumber: 1 }], nextToken: 't' } as never)
      .resolvesOnce({ aiAgentVersionSummaries: [{ versionNumber: 2 }, {}] } as never)
    expect(await qConnectAiAgents('us-east-1').versionNumbers('as-1', 'ag-1')).toEqual([1, 2])
  })
})

describe('bedrockKnowledgeBases', () => {
  it('returns the knowledge-base status', async () => {
    bedrockAgent.on(GetKnowledgeBaseCommand).resolves({ knowledgeBase: { status: 'ACTIVE' } } as never)
    expect(await bedrockKnowledgeBases('us-east-1').status('kb-1')).toBe('ACTIVE')
  })

  it('starts an ingestion job and returns its id', async () => {
    bedrockAgent.on(StartIngestionJobCommand)
      .resolves({ ingestionJob: { ingestionJobId: 'job-1' } } as never)
    expect(await bedrockKnowledgeBases('us-east-1').startIngestion('kb-1', 'ds-1')).toBe('job-1')
    expect(bedrockAgent.commandCalls(StartIngestionJobCommand)[0]!.args[0]!.input)
      .toEqual({ knowledgeBaseId: 'kb-1', dataSourceId: 'ds-1' })
  })

  it('throws when the job comes back without an id', async () => {
    bedrockAgent.on(StartIngestionJobCommand).resolves({ ingestionJob: {} } as never)
    await expect(bedrockKnowledgeBases('us-east-1').startIngestion('kb-1', 'ds-1'))
      .rejects.toThrow(new CliError('StartIngestionJob returned no job id'))
  })

  it('carries status, failure reasons and statistics off a poll', async () => {
    bedrockAgent.on(GetIngestionJobCommand).resolves({
      ingestionJob: {
        status: 'FAILED',
        failureReasons: ['bad format'],
        statistics: { numberOfDocumentsScanned: 3 },
      },
    } as never)
    expect(await bedrockKnowledgeBases('us-east-1').getIngestion('kb-1', 'ds-1', 'job-1'))
      .toEqual({
        status: 'FAILED',
        failureReasons: ['bad format'],
        statistics: { numberOfDocumentsScanned: 3 },
      })
  })

  it('throws when a poll returns no status', async () => {
    bedrockAgent.on(GetIngestionJobCommand).resolves({ ingestionJob: {} } as never)
    await expect(bedrockKnowledgeBases('us-east-1').getIngestion('kb-1', 'ds-1', 'job-1'))
      .rejects.toThrow(new CliError('GetIngestionJob returned no status for job-1'))
  })
})
