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

  it('exposes bounded backlog snapshots and collector freshness without identifiers', async () => {
    const metrics = new MetricsRegistry({ ...options, service: 'worker' });
    metrics.setOutboxBacklog([
      { eventType: 'payment.created.v1', oldestAgeSeconds: 31, pending: 2 },
    ]);
    metrics.setWebhookBacklog({ deadLettered: 1, due: 3, oldestDueAgeSeconds: 121 });
    metrics.setSettlementBacklog([
      { currency: 'ETB', value: 4 },
      { currency: 'USD', value: 0 },
    ]);
    metrics.setReconciliationBacklog([
      { currency: 'ETB', value: 1 },
      { currency: 'USD', value: 0 },
    ]);
    metrics.setBacklogCollectorStatus('outbox', true, new Date('2026-08-09T00:00:00Z'));

    const exposition = await metrics.exposition();
    expect(exposition).toContain(
      'settleflow_outbox_pending{event_type="payment.created.v1",service="worker"} 2',
    );
    expect(exposition).toContain('settleflow_webhook_due{service="worker"} 3');
    expect(exposition).toContain(
      'settleflow_settlement_pending_adjustments{currency="ETB",service="worker"} 4',
    );
    expect(exposition).toContain(
      'settleflow_reconciliation_reports_with_difference{currency="ETB",service="worker"} 1',
    );
    expect(exposition).toContain(
      'settleflow_backlog_collector_last_success_timestamp_seconds{collector="outbox",service="worker"} 1786233600',
    );
    expect(exposition).not.toContain('merchant_id');
  });

  it('drops an invalid backlog observation without changing the last safe value', async () => {
    const metrics = new MetricsRegistry({ ...options, service: 'worker' });
    metrics.setWebhookBacklog({ deadLettered: 1, due: 2, oldestDueAgeSeconds: 3 });
    metrics.setWebhookBacklog({ deadLettered: 2, due: Number.NaN, oldestDueAgeSeconds: 4 });

    const exposition = await metrics.exposition();
    expect(exposition).toContain('settleflow_webhook_due{service="worker"} 2');
    expect(exposition).toContain('settleflow_telemetry_dropped_total{service="worker"} 1');
  });
});
