import { SSOAdminClient, ListInstancesCommand } from '@aws-sdk/client-sso-admin'
import type { SsoInstances } from '../core/ports.js'

export function ssoAdminInstances(region: string): SsoInstances {
  const sso = new SSOAdminClient({ region })
  return {
    async visible() {
      // An account with no Identity Center returns an empty list rather than an
      // error, so there is nothing to swallow here.
      const r = await sso.send(new ListInstancesCommand({}))
      return Boolean(r.Instances?.[0]?.InstanceArn)
    },
  }
}
