import type { TelemetryRuntime } from '@settleflow/infrastructure';

import { SettlementLifecycleSignalService } from './settlement-lifecycle-signal.service';

describe('SettlementLifecycleSignalService', () => {
  it('emits only bounded settlement consumer identifiers and outcomes', () => {
    const record = jest.fn();
    const service = new SettlementLifecycleSignalService({
      logger: { record },
    } as unknown as TelemetryRuntime);

    service.record({
      event: 'settlement.consumer.processed',
      eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      eventType: 'payment.refunded.v1',
    });

    expect(record).toHaveBeenCalledWith('info', {
      event: 'settlement.consumer.processed',
      eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      eventType: 'payment.refunded.v1',
    });
  });
});
