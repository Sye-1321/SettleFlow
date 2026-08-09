import type { TelemetryRuntime } from '@settleflow/infrastructure';

import { WebhookDeliverySignalService } from './webhook-delivery-signal.service';

describe('WebhookDeliverySignalService', () => {
  it('emits the bounded redacted delivery counters supplied by Webhooks', () => {
    const record = jest.fn();
    const service = new WebhookDeliverySignalService({
      logger: { record },
    } as unknown as TelemetryRuntime);

    service.record({
      claimed: 4,
      deadLettered: 1,
      delivered: 2,
      event: 'webhook.delivery.dispatcher_batch',
      ownershipLost: 0,
      recoveredUnknown: 1,
      retrying: 1,
    });

    expect(record).toHaveBeenCalledWith('info', {
      claimed: 4,
      deadLettered: 1,
      delivered: 2,
      event: 'webhook.delivery.dispatcher_batch',
      ownershipLost: 0,
      recoveredUnknown: 1,
      retrying: 1,
    });
  });
});
