import type { EventBridgeEvent } from 'aws-lambda';

/**
 * Logs Amazon Connect voice contact disconnect events received via EventBridge.
 *
 * The EventBridge rule forwards events where the customer disconnected (client-side).
 * This handler simply structures and logs the relevant fields so they appear in
 * CloudWatch Logs for troubleshooting or analytics.
 */
export const handler = async (event: EventBridgeEvent<'Amazon Connect Contact Event', Record<string, unknown>>): Promise<void> => {
  const detail = event.detail ?? {};

  console.log(JSON.stringify({
    message: 'Client-side disconnect detected',
    contactId: detail.contactId,
    instanceArn: detail.instanceArn,
    channel: detail.channel,
    initiationMethod: detail.initiationMethod,
    disconnectReason: detail.disconnectReason,
    eventType: detail.eventType,
    timestamp: event.time,
  }));
};
