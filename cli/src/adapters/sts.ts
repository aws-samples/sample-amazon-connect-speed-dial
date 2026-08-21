import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { CliError } from '../lib/errors.js'
import type { Identity } from '../core/ports.js'

export function stsIdentity(region: string): Identity {
  const sts = new STSClient({ region })
  const account = async (): Promise<string | null> => {
    const r = await sts.send(new GetCallerIdentityCommand({}))
    return r.Account ?? null
  }
  return {
    async accountId() {
      const a = await account()
      if (!a) throw new CliError('could not resolve the AWS account id from STS')
      return a
    },
    async accountIdOrNull() {
      // preflight turns a null into "AWS credentials not configured", so an
      // unreachable STS or expired credentials must not throw here.
      try {
        return await account()
      } catch {
        return null
      }
    },
  }
}
