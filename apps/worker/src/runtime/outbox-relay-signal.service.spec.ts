import { Logger } from '@nestjs/common';

import { OutboxRelaySignalService } from './outbox-relay-signal.service';

describe('OutboxRelaySignalService', () => {
  it('emits only the bounded signal object supplied by Eventing', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = new OutboxRelaySignalService();

    service.record({
      code: 'rabbitmq_unavailable',
      event: 'outbox.relay.dependency_unavailable',
    });

    expect(log).toHaveBeenCalledWith(
      '{"code":"rabbitmq_unavailable","event":"outbox.relay.dependency_unavailable"}',
    );
  });
});
