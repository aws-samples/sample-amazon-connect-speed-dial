import { BedrockClient, GetFoundationModelCommand } from '@aws-sdk/client-bedrock'
import type { Models } from '../core/ports.js'

/** Only these mean "this account cannot use the model". A throttle, an expired
 *  token or a network fault must NOT be reported as "enable model access in the
 *  console" — that sends the user to fix the wrong thing. */
const MEANS_NO_ACCESS = new Set([
  'AccessDeniedException',
  'ResourceNotFoundException',
  'ValidationException',
])

export function bedrockModels(region: string): Models {
  const bedrock = new BedrockClient({ region })
  return {
    async accessible(modelId) {
      try {
        await bedrock.send(new GetFoundationModelCommand({ modelIdentifier: modelId }))
        return true
      } catch (err) {
        if (MEANS_NO_ACCESS.has((err as { name?: string })?.name ?? '')) return false
        throw err
      }
    },
  }
}
