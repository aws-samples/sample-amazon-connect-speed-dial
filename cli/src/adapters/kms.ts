import { KMSClient, ScheduleKeyDeletionCommand } from '@aws-sdk/client-kms'
import type { Keys } from '../core/ports.js'

export function kmsKeys(region: string): Keys {
  const kms = new KMSClient({ region })
  return {
    async scheduleDeletion(keyArn, pendingDays) {
      await kms.send(new ScheduleKeyDeletionCommand({
        KeyId: keyArn, PendingWindowInDays: pendingDays }))
    },
  }
}
