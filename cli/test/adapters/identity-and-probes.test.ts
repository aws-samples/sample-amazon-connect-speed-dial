import { describe, it, expect, beforeEach } from 'vitest'
import { mockClient } from 'aws-sdk-client-mock'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { BedrockClient, GetFoundationModelCommand } from '@aws-sdk/client-bedrock'
import { SSOAdminClient, ListInstancesCommand } from '@aws-sdk/client-sso-admin'
import { EventBridgeClient, DescribeRuleCommand } from '@aws-sdk/client-eventbridge'
import { stsIdentity } from '../../src/adapters/sts.js'
import { bedrockModels } from '../../src/adapters/bedrock.js'
import { ssoAdminInstances } from '../../src/adapters/ssoAdmin.js'
import { eventBridgeRules } from '../../src/adapters/eventbridge.js'
import { CliError } from '../../src/lib/errors.js'

const sts = mockClient(STSClient)
const bedrock = mockClient(BedrockClient)
const sso = mockClient(SSOAdminClient)
const events = mockClient(EventBridgeClient)
beforeEach(() => { sts.reset(); bedrock.reset(); sso.reset(); events.reset() })

describe('stsIdentity', () => {
  it('returns the account', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' })
    expect(await stsIdentity('us-east-1').accountId()).toBe('123456789012')
  })

  it('accountId throws when STS answers without an account', async () => {
    sts.on(GetCallerIdentityCommand).resolves({})
    await expect(stsIdentity('us-east-1').accountId())
      .rejects.toThrow(new CliError('could not resolve the AWS account id from STS'))
  })

  it('accountId propagates a call failure', async () => {
    sts.on(GetCallerIdentityCommand).rejects(new Error('ExpiredToken'))
    await expect(stsIdentity('us-east-1').accountId()).rejects.toThrow('ExpiredToken')
  })

  it('accountIdOrNull returns null instead of throwing — preflight reports it', async () => {
    sts.on(GetCallerIdentityCommand).rejects(new Error('ExpiredToken'))
    expect(await stsIdentity('us-east-1').accountIdOrNull()).toBeNull()
  })
})

describe('bedrockModels', () => {
  it('is true when the model is readable', async () => {
    bedrock.on(GetFoundationModelCommand).resolves({})
    expect(await bedrockModels('us-east-1').accessible('amazon.nova-pro-v1:0')).toBe(true)
  })

  it.each(['AccessDeniedException', 'ResourceNotFoundException', 'ValidationException'])(
    'is false for %s, which really does mean "not enabled"', async (name) => {
      bedrock.on(GetFoundationModelCommand).rejects(Object.assign(new Error('nope'), { name }))
      expect(await bedrockModels('us-east-1').accessible('m')).toBe(false)
    })

  it.each(['ThrottlingException', 'ExpiredTokenException'])(
    'propagates %s — reporting it as "enable model access" sends the user to fix the wrong thing',
    async (name) => {
      bedrock.on(GetFoundationModelCommand).rejects(Object.assign(new Error('nope'), { name }))
      await expect(bedrockModels('us-east-1').accessible('m')).rejects.toThrow('nope')
    })
})

describe('ssoAdminInstances', () => {
  it('is true when an instance ARN comes back', async () => {
    sso.on(ListInstancesCommand).resolves({ Instances: [{ InstanceArn: 'arn:aws:sso:::instance/1' }] })
    expect(await ssoAdminInstances('us-east-1').visible()).toBe(true)
  })

  it('is false for an account with no Identity Center — an empty list, not an error', async () => {
    sso.on(ListInstancesCommand).resolves({ Instances: [] })
    expect(await ssoAdminInstances('us-east-1').visible()).toBe(false)
  })

  it('propagates a denied read rather than reporting "not visible"', async () => {
    sso.on(ListInstancesCommand).rejects(new Error('AccessDenied'))
    await expect(ssoAdminInstances('us-east-1').visible()).rejects.toThrow('AccessDenied')
  })
})

describe('eventBridgeRules', () => {
  it('returns the rule state', async () => {
    events.on(DescribeRuleCommand).resolves({ State: 'ENABLED' })
    expect(await eventBridgeRules('us-east-1').state('proj-contact-events')).toBe('ENABLED')
  })

  it('throws when the response carries no state', async () => {
    events.on(DescribeRuleCommand).resolves({})
    await expect(eventBridgeRules('us-east-1').state('r'))
      .rejects.toThrow(new CliError('DescribeRule returned no state for rule r'))
  })
})
