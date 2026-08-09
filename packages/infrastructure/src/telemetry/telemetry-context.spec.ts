import { TelemetryContext } from './telemetry-context';

describe('TelemetryContext', () => {
  it('propagates and enriches one asynchronous unit without leaking to another', async () => {
    const context = new TelemetryContext();
    const first = context.run({ requestId: 'req_first' }, async () => {
      await Promise.resolve();
      context.enrich({ merchantId: 'merchant-first' });
      await new Promise((resolve) => setImmediate(resolve));
      return context.current();
    });
    const second = context.run({ requestId: 'req_second' }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return context.current();
    });

    await expect(first).resolves.toEqual({ merchantId: 'merchant-first', requestId: 'req_first' });
    await expect(second).resolves.toEqual({ requestId: 'req_second' });
    expect(context.current()).toEqual({});
  });
});
