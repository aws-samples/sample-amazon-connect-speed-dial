import { describe, it, expect } from 'vitest'
import { stackOutput, type CdkOutputs } from '../src/commands/cdkDeploy.js'

const outputs: CdkOutputs = {
  'myproj-ConnectInstance': { InstanceId: 'inst-123', SamlProviderArn: 'arn:x' },
  'myproj-Wisdom': { AssistantId: 'asst-1', OrchestrationAgentId: 'agent-1' },
  'myproj-ContactFlow': { ContactFlowId: 'flow-9' },
}

describe('stackOutput', () => {
  it('finds a value by stack suffix + key', () => {
    expect(stackOutput(outputs, '-ConnectInstance', 'InstanceId')).toBe('inst-123')
    expect(stackOutput(outputs, '-Wisdom', 'OrchestrationAgentId')).toBe('agent-1')
  })
  it('returns null for missing stacks or keys', () => {
    expect(stackOutput(outputs, '-WebcallWidget', 'CloudFrontUrl')).toBeNull()
    expect(stackOutput(outputs, '-Wisdom', 'Nope')).toBeNull()
  })
  it('skips empty values (deploy.py truthiness)', () => {
    expect(stackOutput({ 'p-Wisdom': { AssistantId: '' } }, '-Wisdom', 'AssistantId')).toBeNull()
  })
})
