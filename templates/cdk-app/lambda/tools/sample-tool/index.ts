interface ToolEvent {
  orderId?: string;
}

interface ToolResponse {
  status: 'ok' | 'not_found';
  orderId?: string;
  trackingNumber?: string;
  estimatedDelivery?: string;
}

export const handler = async (event: ToolEvent): Promise<ToolResponse> => {
  if (!event.orderId) return { status: 'not_found' };
  return {
    status: 'ok',
    orderId: event.orderId,
    trackingNumber: `TRK-${event.orderId.slice(-6)}`,
    estimatedDelivery: '2026-06-25',
  };
};
