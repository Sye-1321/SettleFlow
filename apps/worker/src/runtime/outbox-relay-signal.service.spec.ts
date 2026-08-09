import type { TelemetryRuntime } from '@settleflow/infrastructure';

import { OutboxRelaySignalService } from './outbox-relay-signal.service';

describe('OutboxRelaySignalService', () => {
  it('emits only the bounded signal object supplied by Eventing', () => {
    const record = jest.fn();
    const service = new OutboxRelaySignalService({
      logger: { record },
    } as unknown as TelemetryRuntime);

    service.record({
      code: 'rabbitmq_unavailable',
      event: 'outbox.relay.dependency_unavailable',
    });

    expect(record).toHaveBeenCalledWith('info', {
      code: 'rabbitmq_unavailable',
      event: 'outbox.relay.dependency_unavailable',
    });
  });
});
