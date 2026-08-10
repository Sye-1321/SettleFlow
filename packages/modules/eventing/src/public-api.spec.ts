import * as eventing from './index';

describe('eventing public API', () => {
  it('exposes every supported eventing contract and adapter', () => {
    expect(Object.values(eventing).every((value) => value !== undefined)).toBe(true);
    expect(typeof eventing.EventingService).toBe('function');
    expect(typeof eventing.InboxService).toBe('function');
    expect(typeof eventing.OutboxRelayService).toBe('function');
    expect(typeof eventing.RabbitMqOutboxPublisher).toBe('function');
  });
});
