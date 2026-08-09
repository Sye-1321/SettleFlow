import { MetricsRegistry } from './metrics';

describe('MetricsRegistry', () => {
  const options = {
    releaseCommit: 'abcdef0',
    releaseVersion: '1.0.0-test',
    service: 'api' as const,
  };

  it('uses an isolated registry and exposes the approved process and HTTP series', async () => {
    const first = new MetricsRegistry(options);
    const second = new MetricsRegistry(options);
    first.setReadiness(true, { configuration: true, postgresql: true });
    first.observeHttp({
      durationMs: 25,
      method: 'POST',
      route: '/v1/payment-intents',
      statusClass: '2xx',
    });

    const exposition = await first.exposition();
    expect(exposition).toContain('settleflow_build_info');
    expect(exposition).toContain('settleflow_process_ready');
    expect(exposition).toContain('settleflow_http_requests_total');
    expect(await second.exposition()).not.toContain('settleflow_http_requests_total{');
  });

  it('rejects identifiers and values outside closed label sets', () => {
    const metrics = new MetricsRegistry(options);
    expect(() => metrics.validateLabels({ merchantId: 'merchant' } as never)).toThrow(
      'Identifier metric labels are prohibited',
    );
    expect(() => metrics.validateLabels({ outcome: 'merchant-specific-value' })).toThrow(
      'Unapproved metric label',
    );
  });

  it('collapses unknown routes without throwing into business code', async () => {
    const metrics = new MetricsRegistry(options);
    metrics.observeHttp({
      durationMs: 1,
      method: 'GET',
      route: '/secret/value',
      statusClass: '2xx',
    });
    expect(await metrics.exposition()).toContain('route="unmatched"');
  });

  it('retains bounded parameterized route templates', async () => {
    const metrics = new MetricsRegistry(options);
    metrics.observeHttp({
      durationMs: 1,
      method: 'POST',
      route: '/v1/payment-intents/:id/capture',
      statusClass: '2xx',
    });
    expect(await metrics.exposition()).toContain('route="/v1/payment-intents/:id/capture"');
  });
});
