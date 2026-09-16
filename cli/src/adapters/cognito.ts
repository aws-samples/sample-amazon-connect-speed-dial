import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider'
import type { UserPool } from '../core/ports.js'

export function cognitoUserPool(region: string): UserPool {
  const cognito = new CognitoIdentityProviderClient({ region })
  return {
    async getUser(poolId, username) {
      try {
        const r = await cognito.send(new AdminGetUserCommand({
          UserPoolId: poolId, Username: username }))
        return {
          exists: true,
          status: r.UserStatus,
          sub: r.UserAttributes?.find((a) => a.Name === 'sub')?.Value,
        }
      } catch (err) {
        // "No such user" is a real answer, not a failure. Everything else throws.
        if (err instanceof UserNotFoundException) return { exists: false }
        throw err
      }
    },
    async createUser(poolId, username, email, resend) {
      // No TemporaryPassword: Cognito generates one and emails it, so it never
      // reaches stdout. No MessageAction SUPPRESS either — the invitation email
      // is the delivery mechanism. RESEND re-invites a still-pending user.
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: poolId,
        Username: username,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
        ...(resend ? { MessageAction: 'RESEND' as const } : {}),
      }))
    },
  }
}
