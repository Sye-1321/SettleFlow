import type { ConfigService } from '@nestjs/config';
import type { PrismaOutboxRelayRepository } from '@settleflow/eventing';
import type { TelemetryRuntime } from '@settleflow/infrastructure';
import type { PrismaReconciliationRepository } from '@settleflow/reconciliation';
import type { PrismaSettlementRepository } from '@settleflow/settlements';
import type { PrismaWebhookDeliveryRepository } from '@settleflow/webhooks';

import type { WorkerEnvironment } from '../config/environment';
import { OperationalMetricsService } from './operational-metrics.service';

interface MetricsMocks {
  readonly setBacklogCollectorStatus: jest.Mock;
  readonly setOutboxBacklog: jest.Mock;
  readonly setReconciliationBacklog: jest.Mock;
  readonly setSettlementBacklog: jest.Mock;
  readonly setWebhookBacklog: jest.Mock;
}

interface OperationalMetricsFixture {
  readonly loggerRecord: jest.Mock;
  readonly metrics: MetricsMocks;
  readonly outbox: PrismaOutboxRelayRepository;
  readonly readOutboxBacklog: jest.Mock;
  readonly service: OperationalMetricsService;
  readonly telemetry: TelemetryRuntime;
}

function config(enabled = true): ConfigService<WorkerEnvironment, true> {
  const values = {
    INTERNAL_TELEMETRY_ENABLED: enabled,
    OPERATIONAL_METRICS_POLL_INTERVAL_MS: 15_000,
    OPERATIONAL_METRICS_QUERY_TIMEOUT_MS: 2_000,
  };
  return {
    get: jest.fn((key: keyof typeof values) => values[key]),
  } as unknown as ConfigService<WorkerEnvironment, true>;
}

describe('OperationalMetricsService', () => {
  function fixture(
    overrides: { readonly outboxFailure?: boolean } = {},
  ): OperationalMetricsFixture {
    const readOutboxBacklog = overrides.outboxFailure
      ? jest.fn().mockRejectedValue(new Error('unavailable'))
      : jest
          .fn()
          .mockResolvedValue([
            { eventType: 'payment.created.v1', oldestAgeSeconds: 31, pending: 2 },
          ]);
    const outbox = {
      readBacklogMetrics: readOutboxBacklog,
    } as unknown as PrismaOutboxRelayRepository;
    const webhooks = {
      readBacklogMetrics: jest
        .fn()
        .mockResolvedValue({ deadLettered: 1, due: 3, oldestDueAgeSeconds: 121 }),
    } as unknown as PrismaWebhookDeliveryRepository;
    const settlements = {
      readBacklogMetrics: jest.fn().mockResolvedValue([{ currency: 'ETB', pending: 4 }]),
    } as unknown as PrismaSettlementRepository;
    const reconciliation = {
      readBacklogMetrics: jest
        .fn()
        .mockResolvedValue([{ currency: 'USD', reportsWithDifference: 1 }]),
    } as unknown as PrismaReconciliationRepository;
    const metrics: MetricsMocks = {
      setBacklogCollectorStatus: jest.fn(),
      setOutboxBacklog: jest.fn(),
      setReconciliationBacklog: jest.fn(),
      setSettlementBacklog: jest.fn(),
      setWebhookBacklog: jest.fn(),
    };
    const loggerRecord = jest.fn();
    const telemetry = {
      logger: { record: loggerRecord },
      metrics,
    } as unknown as TelemetryRuntime;
    return {
      metrics,
      loggerRecord,
      outbox,
      readOutboxBacklog,
      service: new OperationalMetricsService(
        config(),
        outbox,
        webhooks,
        settlements,
        reconciliation,
        telemetry,
      ),
      telemetry,
    };
  }

  it('publishes complete bounded snapshots and success freshness independently', async () => {
    const { metrics, service } = fixture();
    await service.collectNow();

    expect(metrics.setOutboxBacklog).toHaveBeenCalledWith(
      expect.arrayContaining([
        { eventType: 'payment.created.v1', oldestAgeSeconds: 31, pending: 2 },
        { eventType: 'payment.refunded.v1', oldestAgeSeconds: 0, pending: 0 },
      ]),
    );
    expect(metrics.setSettlementBacklog).toHaveBeenCalledWith([
      { currency: 'ETB', value: 4 },
      { currency: 'USD', value: 0 },
    ]);
    expect(metrics.setReconciliationBacklog).toHaveBeenCalledWith([
      { currency: 'ETB', value: 0 },
      { currency: 'USD', value: 1 },
    ]);
    expect(metrics.setBacklogCollectorStatus).toHaveBeenCalledTimes(4);
  });

  it('marks only the failed collector down and does not reject the collection cycle', async () => {
    const { loggerRecord, metrics, service } = fixture({ outboxFailure: true });
    await expect(service.collectNow()).resolves.toBeUndefined();

    expect(metrics.setBacklogCollectorStatus).toHaveBeenCalledWith('outbox', false);
    expect(metrics.setBacklogCollectorStatus).toHaveBeenCalledWith('webhooks', true);
    expect(loggerRecord).toHaveBeenCalledWith('warn', {
      code: 'collection_failed',
      dependency: 'outbox',
      event: 'telemetry.backlog_collection.failed',
    });
  });

  it('does not query PostgreSQL when internal telemetry is disabled', () => {
    const { outbox, readOutboxBacklog, telemetry } = fixture();
    const service = new OperationalMetricsService(
      config(false),
      outbox,
      { readBacklogMetrics: jest.fn() } as unknown as PrismaWebhookDeliveryRepository,
      { readBacklogMetrics: jest.fn() } as unknown as PrismaSettlementRepository,
      { readBacklogMetrics: jest.fn() } as unknown as PrismaReconciliationRepository,
      telemetry,
    );

    service.start();
    expect(readOutboxBacklog).not.toHaveBeenCalled();
  });

  it('does not hold worker startup on the initial bounded collection', async () => {
    const { readOutboxBacklog, service } = fixture();
    let finishCollection: (() => void) | undefined;
    readOutboxBacklog.mockImplementation(
      (): Promise<readonly never[]> =>
        new Promise<readonly never[]>((resolve) => {
          finishCollection = (): void => {
            resolve([]);
          };
        }),
    );

    expect(service.start()).toBeUndefined();
    expect(readOutboxBacklog).toHaveBeenCalledTimes(1);

    finishCollection?.();
    await service.stop();
  });
});
