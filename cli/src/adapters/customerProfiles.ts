import {
  CustomerProfilesClient,
  SearchProfilesCommand,
  CreateProfileCommand,
  UpdateProfileCommand,
} from '@aws-sdk/client-customer-profiles'
import { CliError } from '../lib/errors.js'
import type { Profiles } from '../core/ports.js'

export function customerProfilesDirectory(region: string): Profiles {
  const customerProfiles = new CustomerProfilesClient({ region })
  return {
    async findId(domain, keyName, value) {
      const r = await customerProfiles.send(new SearchProfilesCommand({
        DomainName: domain, KeyName: keyName, Values: [value] }))
      return r.Items?.[0]?.ProfileId ?? null
    },
    async create(domain, profile) {
      const r = await customerProfiles.send(new CreateProfileCommand({
        DomainName: domain,
        AccountNumber: profile.accountNumber,
        FirstName: profile.firstName,
        LastName: profile.lastName,
        PartyType: 'INDIVIDUAL',
        PhoneNumber: profile.phone,
        EmailAddress: profile.email,
        Attributes: profile.attributes,
      }))
      if (!r.ProfileId) throw new CliError('CreateProfile returned no ProfileId')
      return r.ProfileId
    },
    async update(domain, profileId, profile) {
      await customerProfiles.send(new UpdateProfileCommand({
        DomainName: domain,
        ProfileId: profileId,
        AccountNumber: profile.accountNumber,
        FirstName: profile.firstName,
        LastName: profile.lastName,
        PartyType: 'INDIVIDUAL',
        PhoneNumber: profile.phone,
        EmailAddress: profile.email,
        Attributes: profile.attributes,
      }))
    },
  }
}
