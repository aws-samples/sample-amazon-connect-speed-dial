import { describe, it, expect, beforeEach } from 'vitest'
import { mockClient } from 'aws-sdk-client-mock'
import {
  ConnectClient,
  ListPhoneNumbersV2Command,
  SearchAvailablePhoneNumbersCommand,
  ClaimPhoneNumberCommand,
  AssociatePhoneNumberContactFlowCommand,
  DescribeInstanceCommand,
  DescribeContactFlowCommand,
  DeleteInstanceCommand,
  DisassociateSecurityProfilesCommand,
  ListInstancesCommand,
  ListSecurityProfilesCommand,
} from '@aws-sdk/client-connect'
import {
  connectPhoneNumbers, connectInstances, connectContactFlows, connectSecurityProfiles,
} from '../../src/adapters/connect.js'
import { CliError } from '../../src/lib/errors.js'

// Adapters are where the request SHAPE lives — the layer the port-level tests
// deliberately cannot see. mockClient patches ConnectClient.prototype.send, so
// clients constructed inside the factories are intercepted.
const connect = mockClient(ConnectClient)
beforeEach(() => { connect.reset() })

const inputOf = (cmd: Parameters<typeof connect.commandCalls>[0], i = 0): Record<string, unknown> =>
  connect.commandCalls(cmd)[i]!.args[0]!.input as Record<string, unknown>

describe('connectPhoneNumbers', () => {
  it('passes the caller policy straight through to SearchAvailablePhoneNumbers', async () => {
    connect.on(SearchAvailablePhoneNumbersCommand).resolves({ AvailableNumbersList: [] })
    await connectPhoneNumbers('eu-central-1').searchAvailable(
      'arn:aws:connect:eu-central-1:123456789012:instance/i-1', 'GB', 'DID', 5)
    expect(inputOf(SearchAvailablePhoneNumbersCommand)).toEqual({
      TargetArn: 'arn:aws:connect:eu-central-1:123456789012:instance/i-1',
      PhoneNumberCountryCode: 'GB',
      PhoneNumberType: 'DID',
      MaxResults: 5,
    })
  })

  it('drops numbers from other countries and entries missing an id', async () => {
    connect.on(ListPhoneNumbersV2Command).resolves({
      ListPhoneNumbersSummaryList: [
        { PhoneNumber: '+12025550100', PhoneNumberId: 'us-1', PhoneNumberCountryCode: 'US' },
        { PhoneNumber: '+441134960001', PhoneNumberId: 'gb-1', PhoneNumberCountryCode: 'GB' },
        { PhoneNumber: '+441134960002', PhoneNumberCountryCode: 'GB' },
        { PhoneNumberId: 'gb-3', PhoneNumberCountryCode: 'GB' },
      ],
    })
    expect(await connectPhoneNumbers('us-east-1').listClaimed('i-1', 'GB'))
      .toEqual([{ phoneNumber: '+441134960001', phoneNumberId: 'gb-1' }])
  })

  it('does NOT swallow a list failure — a denied read must not read as "no DID"', async () => {
    connect.on(ListPhoneNumbersV2Command).rejects(new Error('AccessDeniedException'))
    await expect(connectPhoneNumbers('us-east-1').listClaimed('i-1', 'GB'))
      .rejects.toThrow('AccessDeniedException')
  })

  it('returns null when the claim response carries no id', async () => {
    connect.on(ClaimPhoneNumberCommand).resolves({})
    expect(await connectPhoneNumbers('us-east-1').claim('arn:x', '+441134960000')).toBeNull()
  })

  it('routes a number to a flow with all three ids', async () => {
    connect.on(AssociatePhoneNumberContactFlowCommand).resolves({})
    await connectPhoneNumbers('us-east-1').routeToFlow('pn-1', 'i-1', 'f-1')
    expect(inputOf(AssociatePhoneNumberContactFlowCommand))
      .toEqual({ PhoneNumberId: 'pn-1', InstanceId: 'i-1', ContactFlowId: 'f-1' })
  })
})

describe('connectInstances', () => {
  it('returns status and identity type from one DescribeInstance', async () => {
    connect.on(DescribeInstanceCommand).resolves({
      Instance: { InstanceStatus: 'ACTIVE', IdentityManagementType: 'SAML' },
    })
    expect(await connectInstances('us-east-1').describe('i-1'))
      .toEqual({ status: 'ACTIVE', identityManagementType: 'SAML' })
  })

  it('reports UNKNOWN rather than guessing when the identity type is absent', async () => {
    connect.on(DescribeInstanceCommand).resolves({ Instance: { InstanceStatus: 'ACTIVE' } })
    expect((await connectInstances('us-east-1').describe('i-1')).identityManagementType)
      .toBe('UNKNOWN')
  })

  it('throws a named CliError when the response carries no status', async () => {
    connect.on(DescribeInstanceCommand).resolves({ Instance: {} })
    await expect(connectInstances('us-east-1').describe('i-1'))
      .rejects.toThrow(new CliError('DescribeInstance returned no status for instance i-1'))
  })

  it('finds an instance by alias ACROSS PAGES', async () => {
    connect.on(ListInstancesCommand)
      .resolvesOnce({ InstanceSummaryList: [{ Id: 'other', InstanceAlias: 'nope' }], NextToken: 't' })
      .resolvesOnce({ InstanceSummaryList: [{ Id: 'i-9', InstanceAlias: 'wanted' }] })
    expect(await connectInstances('us-east-1').findIdByAlias('wanted')).toBe('i-9')
  })

  it('returns null when no page holds the alias', async () => {
    connect.on(ListInstancesCommand).resolves({ InstanceSummaryList: [] })
    expect(await connectInstances('us-east-1').findIdByAlias('missing')).toBeNull()
  })

  it('deletes by id', async () => {
    connect.on(DeleteInstanceCommand).resolves({})
    await connectInstances('us-east-1').delete('i-1')
    expect(inputOf(DeleteInstanceCommand)).toEqual({ InstanceId: 'i-1' })
  })
})

describe('connectContactFlows', () => {
  it('returns the flow status', async () => {
    connect.on(DescribeContactFlowCommand).resolves({ ContactFlow: { Status: 'PUBLISHED' } })
    expect(await connectContactFlows('us-east-1').status('i-1', 'f-1')).toBe('PUBLISHED')
  })

  it('throws when the response carries no status', async () => {
    connect.on(DescribeContactFlowCommand).resolves({ ContactFlow: {} })
    await expect(connectContactFlows('us-east-1').status('i-1', 'f-1'))
      .rejects.toThrow(new CliError('DescribeContactFlow returned no status for flow f-1'))
  })
})

describe('connectSecurityProfiles', () => {
  it('finds a profile by name across pages', async () => {
    connect.on(ListSecurityProfilesCommand)
      .resolvesOnce({ SecurityProfileSummaryList: [{ Id: 'a', Name: 'other' }], NextToken: 't' })
      .resolvesOnce({ SecurityProfileSummaryList: [{ Id: 'sp-9', Name: 'proj-ai-agent' }] })
    expect(await connectSecurityProfiles('us-east-1').findIdByName('i-1', 'proj-ai-agent'))
      .toBe('sp-9')
  })

  it('detaches from an AI_AGENT entity specifically', async () => {
    connect.on(DisassociateSecurityProfilesCommand).resolves({})
    await connectSecurityProfiles('us-east-1').disassociateAiAgent('i-1', 'arn:agent', 'sp-1')
    expect(inputOf(DisassociateSecurityProfilesCommand)).toEqual({
      InstanceId: 'i-1',
      EntityType: 'AI_AGENT',
      EntityArn: 'arn:agent',
      SecurityProfiles: [{ Id: 'sp-1' }],
    })
  })
})
