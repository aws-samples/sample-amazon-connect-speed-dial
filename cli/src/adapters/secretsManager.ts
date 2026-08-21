import { SecretsManagerClient, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import type { Secrets } from '../core/ports.js'

export function secretsManagerSecrets(region: string): Secrets {
  const secretsManager = new SecretsManagerClient({ region })
  return {
    async put(name, value) {
      await secretsManager.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }))
    },
  }
}
