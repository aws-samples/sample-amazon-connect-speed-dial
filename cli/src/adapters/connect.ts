import {
  ConnectClient,
  DescribeInstanceCommand,
  DescribeContactFlowCommand,
  ListPhoneNumbersV2Command,
  DeleteInstanceCommand,
  DisassociateSecurityProfilesCommand,
  paginateListInstances,
  paginateListSecurityProfiles,
  SearchAvailablePhoneNumbersCommand,
  ClaimPhoneNumberCommand,
  AssociatePhoneNumberContactFlowCommand,
  type PhoneNumberCountryCode,
  type PhoneNumberType,
} from '@aws-sdk/client-connect'
import { CliError } from '../lib/errors.js'
import type {
  ConnectInstances, ContactFlows, InstanceDescription, PhoneNumbers, SecurityProfiles,
} from '../core/ports.js'

// One ConnectClient per region, shared by every Connect-backed port. Adapters
// translate the API into the port's shape and nothing else: no retries, no
// sentinel values, no swallowed errors. A caller that wants a failure treated as
// non-fatal catches it.

const client = (region: string): ConnectClient => new ConnectClient({ region })

export function connectInstances(region: string): ConnectInstances {
  const connect = client(region)
  return {
    async describe(instanceId): Promise<InstanceDescription> {
      const r = await connect.send(new DescribeInstanceCommand({ InstanceId: instanceId }))
      const instance = r.Instance
      if (!instance?.InstanceStatus) {
        throw new CliError(`DescribeInstance returned no status for instance ${instanceId}`)
      }
      return {
        status: instance.InstanceStatus,
        // Absent only on very old instances; report it rather than guessing.
        identityManagementType: instance.IdentityManagementType ?? 'UNKNOWN',
      }
    },
    async findIdByAlias(alias) {
      for await (const page of paginateListInstances({ client: connect }, {})) {
        const hit = page.InstanceSummaryList?.find((i) => i.InstanceAlias === alias)
        if (hit?.Id) return hit.Id
      }
      return null
    },
    async delete(instanceId) {
      await connect.send(new DeleteInstanceCommand({ InstanceId: instanceId }))
    },
  }
}

export function connectSecurityProfiles(region: string): SecurityProfiles {
  const connect = client(region)
  return {
    async findIdByName(instanceId, name) {
      for await (const page of paginateListSecurityProfiles({ client: connect },
        { InstanceId: instanceId })) {
        const hit = page.SecurityProfileSummaryList?.find((profile) => profile.Name === name)
        if (hit?.Id) return hit.Id
      }
      return null
    },
    async disassociateAiAgent(instanceId, entityArn, securityProfileId) {
      await connect.send(new DisassociateSecurityProfilesCommand({
        InstanceId: instanceId,
        EntityType: 'AI_AGENT',
        EntityArn: entityArn,
        SecurityProfiles: [{ Id: securityProfileId }],
      }))
    },
  }
}

export function connectContactFlows(region: string): ContactFlows {
  const connect = client(region)
  return {
    async status(instanceId, flowId) {
      const r = await connect.send(new DescribeContactFlowCommand({
        InstanceId: instanceId, ContactFlowId: flowId }))
      const status = r.ContactFlow?.Status
      if (!status) throw new CliError(`DescribeContactFlow returned no status for flow ${flowId}`)
      return status
    },
  }
}

export function connectPhoneNumbers(region: string): PhoneNumbers {
  const connect = client(region)
  return {
    async listClaimed(instanceId, countryCode) {
      const r = await connect.send(new ListPhoneNumbersV2Command({ InstanceId: instanceId }))
      return (r.ListPhoneNumbersSummaryList ?? [])
        .filter((n) => n.PhoneNumberCountryCode === countryCode && n.PhoneNumber && n.PhoneNumberId)
        .map((n) => ({ phoneNumber: n.PhoneNumber!, phoneNumberId: n.PhoneNumberId! }))
    },
    async searchAvailable(instanceArn, countryCode, numberType, limit) {
      // The port is deliberately more general than the SDK's enums; these casts
      // are where that generality stops. An unsupported code or type surfaces as
      // an AWS validation error, which is the right failure.
      const r = await connect.send(new SearchAvailablePhoneNumbersCommand({
        TargetArn: instanceArn,
        PhoneNumberCountryCode: countryCode as PhoneNumberCountryCode,
        PhoneNumberType: numberType as PhoneNumberType,
        MaxResults: limit,
      }))
      return (r.AvailableNumbersList ?? [])
        .map((n) => n.PhoneNumber)
        .filter((n): n is string => Boolean(n))
    },
    async claim(instanceArn, phoneNumber) {
      const r = await connect.send(new ClaimPhoneNumberCommand({
        TargetArn: instanceArn, PhoneNumber: phoneNumber }))
      return r.PhoneNumberId ?? null
    },
    async routeToFlow(phoneNumberId, instanceId, flowId) {
      await connect.send(new AssociatePhoneNumberContactFlowCommand({
        PhoneNumberId: phoneNumberId, InstanceId: instanceId, ContactFlowId: flowId }))
    },
  }
}
