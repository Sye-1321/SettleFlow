import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaOutboxRelayRepository } from '@settleflow/eventing';
import { TelemetryRuntime } from '@settleflow/infrastructure';
import { PrismaReconciliationRepository } from '@settleflow/reconciliation';
import { PrismaSettlementRepository } from '@settleflow/settlements';
import { PrismaWebhookDeliveryRepository } from '@settleflow/webhooks';

import { WorkerEnvironment } from '../config/environment';

const CURRENCIES = ['ETB', 'USD'] as const;
const EVENT_TYPES = [
  'payment.captured.v1',
  'payment.created.v1',
  'payment.refunded.v1',
  'reconciliation.completed.v1',
  'settlement.finalized.v1',
] as const;

type CollectorName = 'outbox' | 'reconciliation' | 'settlements' | 'webhooks';

@Injectable()
export class OperationalMetricsService {
  private collection: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly config: ConfigService<WorkerEnvironment, true>,
    private readonly outbox: PrismaOutboxRelayRepository,
    private readonly webhooks: PrismaWebhookDeliveryRepository,
    private readonly settlements: PrismaSettlementRepository,
    private readonly reconciliation: PrismaReconciliationRepository,
    private readonly telemetry: TelemetryRuntime,
  ) {}

  public beginShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public collectNow(): Promise<void> {
    if (this.collection !== undefined) return this.collection;
    const collection = this.collectAll().finally(() => {
      if (this.collection === collection) this.collection = undefined;
    });
    this.collection = collection;
    return collection;
  }

  public start(): void {
    if (!this.config.get('INTERNAL_TELEMETRY_ENABLED', { infer: true })) return;
    void this.collectNow();
    this.timer = setInterval(
      () => {
        void this.collectNow();
      },
      this.config.get('OPERATIONAL_METRICS_POLL_INTERVAL_MS', { infer: true }),
    );
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    this.beginShutdown();
    await this.collection;
  }

  private async collectAll(): Promise<void> {
    const timeoutMs = this.config.get('OPERATIONAL_METRICS_QUERY_TIMEOUT_MS', { infer: true });
    await Promise.all([
      this.collect('outbox', async () => {
        const rows = await this.outbox.readBacklogMetrics();
        const byType = new Map(rows.map((row) => [row.eventType, row]));
        this.telemetry.metrics.setOutboxBacklog(
          EVENT_TYPES.map((eventType) => ({
            eventType,
            oldestAgeSeconds: byType.get(eventType)?.oldestAgeSeconds ?? 0,
            pending: byType.get(eventType)?.pending ?? 0,
          })),
        );
      }),
      this.collect('webhooks', async () => {
        this.telemetry.metrics.setWebhookBacklog(await this.webhooks.readBacklogMetrics());
      }),
      this.collect('settlements', async () => {
        const rows = await this.settlements.readBacklogMetrics(timeoutMs);
        const byCurrency = new Map(rows.map((row) => [row.currency, row.pending]));
        this.telemetry.metrics.setSettlementBacklog(
          CURRENCIES.map((currency) => ({ currency, value: byCurrency.get(currency) ?? 0 })),
        );
      }),
      this.collect('reconciliation', async () => {
        const rows = await this.reconciliation.readBacklogMetrics(timeoutMs);
        const byCurrency = new Map(rows.map((row) => [row.currency, row.reportsWithDifference]));
        this.telemetry.metrics.setReconciliationBacklog(
          CURRENCIES.map((currency) => ({ currency, value: byCurrency.get(currency) ?? 0 })),
        );
      }),
    ]);
  }

  private async collect(name: CollectorName, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
      this.telemetry.metrics.setBacklogCollectorStatus(name, true);
    } catch {
      this.telemetry.metrics.setBacklogCollectorStatus(name, false);
      this.telemetry.logger.record('warn', {
        code: 'collection_failed',
        dependency: name,
        event: 'telemetry.backlog_collection.failed',
      });
    }
  }
}

export const operationalMetricsInternals = { CURRENCIES, EVENT_TYPES };
