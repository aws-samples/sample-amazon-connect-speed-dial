import { describe, it, expect, beforeEach } from 'vitest'
import { mockClient } from 'aws-sdk-client-mock'
import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackResourcesCommand,
  DeleteStackCommand,
  ListStacksCommand,
} from '@aws-sdk/client-cloudformation'
import { cfnStacks } from '../../src/adapters/cloudformation.js'

const cfn = mockClient(CloudFormationClient)
beforeEach(() => { cfn.reset() })

const stacks = () => cfnStacks('us-east-1')

describe('exists', () => {
  it('is true when the stack is there', async () => {
    cfn.on(DescribeStacksCommand).resolves({ Stacks: [{ StackName: 'CDKToolkit' }] } as never)
    expect(await stacks().exists('CDKToolkit')).toBe(true)
  })

  it('is false only for a genuine "does not exist"', async () => {
    cfn.on(DescribeStacksCommand).rejects(new Error('Stack with id CDKToolkit does not exist'))
    expect(await stacks().exists('CDKToolkit')).toBe(false)
  })

  it('propagates any other failure — a denied read is not an absent stack', async () => {
    // Swallowing this reported CDKToolkit as missing and invited a pointless
    // bootstrap, and made teardown believe stacks were already gone.
    cfn.on(DescribeStacksCommand).rejects(new Error('AccessDenied: not authorized'))
    await expect(stacks().exists('CDKToolkit')).rejects.toThrow('AccessDenied')
  })
})

describe('output', () => {
  it('returns the value for the requested key', async () => {
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [{ Outputs: [{ OutputKey: 'UserPoolId', OutputValue: 'pool-1' }] }],
    } as never)
    expect(await stacks().output('proj-WebcallWidget', 'UserPoolId')).toBe('pool-1')
  })

  it('is null for a key the stack does not publish', async () => {
    cfn.on(DescribeStacksCommand).resolves({ Stacks: [{ Outputs: [] }] } as never)
    expect(await stacks().output('proj-WebcallWidget', 'UserPoolId')).toBeNull()
  })

  it('is null for a stack that was never deployed (capability absent)', async () => {
    cfn.on(DescribeStacksCommand).rejects(new Error('Stack with id x does not exist'))
    expect(await stacks().output('x', 'UserPoolId')).toBeNull()
  })

  it('propagates an unrelated failure', async () => {
    cfn.on(DescribeStacksCommand).rejects(new Error('ThrottlingException'))
    await expect(stacks().output('x', 'k')).rejects.toThrow('ThrottlingException')
  })
})

describe('list', () => {
  it('collects prefix matches ACROSS PAGES', async () => {
    // Reading one page under-reported the stacks still standing, which made
    // teardown report success while resources remained.
    cfn.on(ListStacksCommand)
      .resolvesOnce({
        StackSummaries: [
          { StackName: 'proj-ConnectInstance', StackStatus: 'DELETE_FAILED' },
          { StackName: 'other-Thing', StackStatus: 'CREATE_COMPLETE' },
        ],
        NextToken: 't',
      } as never)
      .resolvesOnce({
        StackSummaries: [{ StackName: 'proj-Wisdom', StackStatus: 'DELETE_COMPLETE' }],
      } as never)
    expect(await stacks().list('proj-')).toEqual([
      { name: 'proj-ConnectInstance', status: 'DELETE_FAILED' },
      { name: 'proj-Wisdom', status: 'DELETE_COMPLETE' },
    ])
  })

  it('reports an empty status rather than dropping the stack', async () => {
    cfn.on(ListStacksCommand).resolves({ StackSummaries: [{ StackName: 'proj-X' }] } as never)
    expect(await stacks().list('proj-')).toEqual([{ name: 'proj-X', status: '' }])
  })
})

describe('deleteFailedResourceIds', () => {
  it('returns only DELETE_FAILED logical ids', async () => {
    cfn.on(DescribeStackResourcesCommand).resolves({
      StackResources: [
        { LogicalResourceId: 'Bucket', ResourceStatus: 'DELETE_FAILED' },
        { LogicalResourceId: 'Table', ResourceStatus: 'DELETE_COMPLETE' },
        { ResourceStatus: 'DELETE_FAILED' },
      ],
    } as never)
    expect(await stacks().deleteFailedResourceIds('proj-X')).toEqual(['Bucket'])
  })
})

describe('delete', () => {
  it('omits RetainResources entirely when nothing is retained', async () => {
    // An empty RetainResources array is not the same request as none at all.
    cfn.on(DeleteStackCommand).resolves({})
    await stacks().delete('proj-X', [])
    expect(cfn.commandCalls(DeleteStackCommand)[0]!.args[0]!.input)
      .toEqual({ StackName: 'proj-X' })
  })

  it('passes the retain list when there is one', async () => {
    cfn.on(DeleteStackCommand).resolves({})
    await stacks().delete('proj-X', ['Bucket'])
    expect(cfn.commandCalls(DeleteStackCommand)[0]!.args[0]!.input)
      .toEqual({ StackName: 'proj-X', RetainResources: ['Bucket'] })
  })
})
