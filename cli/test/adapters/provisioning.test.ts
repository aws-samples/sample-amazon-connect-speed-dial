import { describe, it, expect, beforeEach } from 'vitest'
import { mockClient } from 'aws-sdk-client-mock'
import {
  CognitoIdentityProviderClient, AdminGetUserCommand, AdminCreateUserCommand,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  CustomerProfilesClient, SearchProfilesCommand, CreateProfileCommand, UpdateProfileCommand,
} from '@aws-sdk/client-customer-profiles'
import {
  AppIntegrationsClient, ListApplicationsCommand, DeleteApplicationCommand,
} from '@aws-sdk/client-appintegrations'
import { DynamoDBClient, DeleteTableCommand } from '@aws-sdk/client-dynamodb'
import { KMSClient, ScheduleKeyDeletionCommand } from '@aws-sdk/client-kms'
import { cognitoUserPool } from '../../src/adapters/cognito.js'
import { customerProfilesDirectory } from '../../src/adapters/customerProfiles.js'
import { appIntegrationsApplications } from '../../src/adapters/appIntegrations.js'
import { dynamoTables } from '../../src/adapters/dynamodb.js'
import { kmsKeys } from '../../src/adapters/kms.js'
import { CliError } from '../../src/lib/errors.js'

const cognito = mockClient(CognitoIdentityProviderClient)
const profiles = mockClient(CustomerProfilesClient)
const appint = mockClient(AppIntegrationsClient)
const dynamo = mockClient(DynamoDBClient)
const kms = mockClient(KMSClient)
beforeEach(() => { cognito.reset(); profiles.reset(); appint.reset(); dynamo.reset(); kms.reset() })

const PROFILE = {
  accountNumber: '0000100042',
  firstName: 'Jordan',
  lastName: 'Lee',
  phone: '+15555550100',
  email: 'jordan@example.com',
  attributes: { customer_number: '0000100042' },
}

describe('cognitoUserPool.getUser', () => {
  it('reports an existing user with its status and sub', async () => {
    cognito.on(AdminGetUserCommand).resolves({
      UserStatus: 'CONFIRMED',
      UserAttributes: [{ Name: 'sub', Value: 'sub-1' }, { Name: 'email', Value: 'j@e.com' }],
    })
    expect(await cognitoUserPool('us-east-1').getUser('pool-1', 'jordan'))
      .toEqual({ exists: true, status: 'CONFIRMED', sub: 'sub-1' })
  })

  it('reports absence for UserNotFoundException rather than throwing', async () => {
    cognito.on(AdminGetUserCommand).rejects(
      new UserNotFoundException({ message: 'User does not exist.', $metadata: {} }))
    expect(await cognitoUserPool('us-east-1').getUser('pool-1', 'jordan'))
      .toEqual({ exists: false })
  })

  it('propagates any other failure', async () => {
    cognito.on(AdminGetUserCommand).rejects(new Error('AccessDenied'))
    await expect(cognitoUserPool('us-east-1').getUser('pool-1', 'jordan'))
      .rejects.toThrow('AccessDenied')
  })
})

describe('cognitoUserPool.createUser', () => {
  it('never sends a TemporaryPassword — Cognito generates and emails one', async () => {
    // Sending one here would put a password in this process, and from there into
    // logs. The invitation email is the only delivery channel.
    cognito.on(AdminCreateUserCommand).resolves({})
    await cognitoUserPool('us-east-1').createUser('pool-1', 'jordan', 'j@e.com', false)
    const input = cognito.commandCalls(AdminCreateUserCommand)[0]!.args[0]!.input
    expect(input).not.toHaveProperty('TemporaryPassword')
    expect(input).not.toHaveProperty('MessageAction')
    expect(input.DesiredDeliveryMediums).toEqual(['EMAIL'])
    expect(input.UserAttributes).toEqual([
      { Name: 'email', Value: 'j@e.com' },
      { Name: 'email_verified', Value: 'true' },
    ])
  })

  it('adds MessageAction RESEND only when re-inviting', async () => {
    cognito.on(AdminCreateUserCommand).resolves({})
    await cognitoUserPool('us-east-1').createUser('pool-1', 'jordan', 'j@e.com', true)
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]!.args[0]!.input.MessageAction)
      .toBe('RESEND')
  })
})

describe('customerProfilesDirectory', () => {
  it('returns the first matching profile id', async () => {
    profiles.on(SearchProfilesCommand).resolves({ Items: [{ ProfileId: 'p-1' }, { ProfileId: 'p-2' }] })
    expect(await customerProfilesDirectory('us-east-1').findId('dom', '_phone', '+1555'))
      .toBe('p-1')
  })

  it('is null when nothing matches', async () => {
    profiles.on(SearchProfilesCommand).resolves({ Items: [] })
    expect(await customerProfilesDirectory('us-east-1').findId('dom', '_phone', '+1555')).toBeNull()
  })

  it('creates an INDIVIDUAL profile and returns its id', async () => {
    profiles.on(CreateProfileCommand).resolves({ ProfileId: 'p-new' })
    expect(await customerProfilesDirectory('us-east-1').create('dom', PROFILE)).toBe('p-new')
    expect(profiles.commandCalls(CreateProfileCommand)[0]!.args[0]!.input).toMatchObject({
      DomainName: 'dom', PartyType: 'INDIVIDUAL', FirstName: 'Jordan',
      PhoneNumber: '+15555550100', Attributes: { customer_number: '0000100042' },
    })
  })

  it('throws when create returns no id', async () => {
    profiles.on(CreateProfileCommand).resolves({})
    await expect(customerProfilesDirectory('us-east-1').create('dom', PROFILE))
      .rejects.toThrow(new CliError('CreateProfile returned no ProfileId'))
  })

  it('updates in place, keeping PartyType INDIVIDUAL', async () => {
    profiles.on(UpdateProfileCommand).resolves({})
    await customerProfilesDirectory('us-east-1').update('dom', 'p-1', PROFILE)
    expect(profiles.commandCalls(UpdateProfileCommand)[0]!.args[0]!.input).toMatchObject({
      DomainName: 'dom', ProfileId: 'p-1', PartyType: 'INDIVIDUAL',
    })
  })
})

describe('appIntegrationsApplications', () => {
  it('follows NextToken to the end — ListApplications has no SDK paginator', async () => {
    // Reading only the first page silently left applications behind, so teardown
    // reported success while the MCP application still existed.
    appint.on(ListApplicationsCommand)
      .resolvesOnce({
        Applications: [{ Name: 'proj-mcp', Arn: 'arn:1' }, { Name: 'other', Arn: 'arn:x' }],
        NextToken: 't',
      })
      .resolvesOnce({ Applications: [{ Name: 'proj-mcp', Arn: 'arn:2' }] })
    expect(await appIntegrationsApplications('us-east-1').findArnsByName('proj-mcp'))
      .toEqual(['arn:1', 'arn:2'])
    expect(appint.commandCalls(ListApplicationsCommand)).toHaveLength(2)
  })

  it('drops entries with no ARN', async () => {
    appint.on(ListApplicationsCommand).resolves({ Applications: [{ Name: 'proj-mcp' }] })
    expect(await appIntegrationsApplications('us-east-1').findArnsByName('proj-mcp')).toEqual([])
  })

  it('deletes by ARN', async () => {
    appint.on(DeleteApplicationCommand).resolves({})
    await appIntegrationsApplications('us-east-1').delete('arn:1')
    expect(appint.commandCalls(DeleteApplicationCommand)[0]!.args[0]!.input)
      .toEqual({ Arn: 'arn:1' })
  })
})

describe('dynamoTables and kmsKeys', () => {
  it('deletes a table by name', async () => {
    dynamo.on(DeleteTableCommand).resolves({})
    await dynamoTables('us-east-1').delete('proj-sap-orders')
    expect(dynamo.commandCalls(DeleteTableCommand)[0]!.args[0]!.input)
      .toEqual({ TableName: 'proj-sap-orders' })
  })

  it('schedules key deletion with the requested window', async () => {
    kms.on(ScheduleKeyDeletionCommand).resolves({})
    await kmsKeys('us-east-1').scheduleDeletion('arn:kms:key/1', 7)
    expect(kms.commandCalls(ScheduleKeyDeletionCommand)[0]!.args[0]!.input)
      .toEqual({ KeyId: 'arn:kms:key/1', PendingWindowInDays: 7 })
  })
})
