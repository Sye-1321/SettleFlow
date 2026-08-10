import * as webhooks from './index';

describe('webhooks public API', () => {
  it('exposes endpoint, projection, and delivery boundaries', () => {
    expect(Object.values(webhooks).every((value) => value !== undefined)).toBe(true);
    expect(typeof webhooks.PaymentCreatedWebhookProjectionService).toBe('function');
    expect(typeof webhooks.WebhookDeliveryService).toBe('function');
    expect(typeof webhooks.WebhookEndpointService).toBe('function');
  });
});
