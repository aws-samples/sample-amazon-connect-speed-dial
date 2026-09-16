import { describe, it, expect, beforeEach } from 'vitest'
import { mockClient } from 'aws-sdk-client-mock'
import { SecretsManagerClient, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { secretsManagerSecrets } from '../../src/adapters/secretsManager.js'

const secretsManager = mockClient(SecretsManagerClient)
beforeEach(() => { secretsManager.reset() })

describe('secretsManagerSecrets.put', () => {
  it('writes the value under the given secret name', async () => {
    secretsManager.on(PutSecretValueCommand).resolves({})
    await secretsManagerSecrets('eu-central-1').put('proj-widget-secret-wid-1', 'signing-key')
    expect(secretsManager.commandCalls(PutSecretValueCommand)[0]!.args[0]!.input).toEqual({
      SecretId: 'proj-widget-secret-wid-1',
      SecretString: 'signing-key',
    })
  })

  it('propagates a write failure so setup-widget can report it without the key', async () => {
    // setupWidget catches this and raises a message naming only the secret — the
    // key must never reach an error string.
    secretsManager.on(PutSecretValueCommand).rejects(new Error('AccessDeniedException'))
    await expect(secretsManagerSecrets('us-east-1').put('s', 'signing-key'))
      .rejects.toThrow('AccessDeniedException')
  })
})
