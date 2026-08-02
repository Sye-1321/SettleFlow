import { Logger } from '@nestjs/common';

import { WebhookDeliverySignalService } from './webhook-delivery-signal.service';

describe('WebhookDeliverySignalService', () => {
  it('emits the bounded redacted delivery counters supplied by Webhooks', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = new WebhookDeliverySignalService();

    service.record({
      claimed: 4,
      deadLettered: 1,
      delivered: 2,
      event: 'webhook.delivery.dispatcher_batch',
      ownershipLost: 0,
      recoveredUnknown: 1,
      retrying: 1,
    });

    expect(log).toHaveBeenCalledWith(
      '{"claimed":4,"deadLettered":1,"delivered":2,"event":"webhook.delivery.dispatcher_batch","ownershipLost":0,"recoveredUnknown":1,"retrying":1}',
    );
  });
});
