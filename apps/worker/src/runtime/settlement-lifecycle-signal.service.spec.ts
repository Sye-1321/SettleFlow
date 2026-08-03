import { Logger } from '@nestjs/common';

import { SettlementLifecycleSignalService } from './settlement-lifecycle-signal.service';

describe('SettlementLifecycleSignalService', () => {
  it('emits only bounded settlement consumer identifiers and outcomes', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = new SettlementLifecycleSignalService();

    service.record({
      event: 'settlement.consumer.processed',
      eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      eventType: 'payment.refunded.v1',
    });

    expect(log).toHaveBeenCalledWith(
      '{"event":"settlement.consumer.processed","eventId":"evt_01ARZ3NDEKTSV4RRFFQ69G5FAV","eventType":"payment.refunded.v1"}',
    );
  });
});
