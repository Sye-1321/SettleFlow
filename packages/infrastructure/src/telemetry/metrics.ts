import { Counter, Gauge, Histogram, Registry } from 'prom-client';

const ID_LABEL =
  /(delivery|endpoint|event|ledger|merchant|payment|reconciliation|refund|request|settlement).*id/iu;

const LABEL_VALUES = {
  business_type: new Set(['capture', 'refund', 'reversal', 'settlement']),
  command: new Set(['capture', 'create', 'refund']),
  consumer: new Set(['settlement.lifecycle', 'webhook-projection.payment-created.v1']),
  currency: new Set(['ETB', 'USD']),
  dependency: new Set([
    'configuration',
    'postgresql',
    'rabbitmq_consumer',
    'rabbitmq_publisher',
    'reconciliation_processor',
    'webhook_delivery',
  ]),
  error_class: new Set([
    'balance',
    'currency',
    'deadlock',
    'entry_count',
    'immutability',
    'lock_timeout',
    'serialization',
    'tenant',
  ]),
  event_type: new Set([
    'payment.captured.v1',
    'payment.created.v1',
    'payment.refunded.v1',
    'reconciliation.completed.v1',
    'settlement.finalized.v1',
  ]),
  method: new Set(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']),
  module: new Set([
    'eventing',
    'idempotency',
    'ledger',
    'payments',
    'reconciliation',
    'settlements',
    'webhooks',
  ]),
  outcome: new Set([
    'acquired',
    'committed',
    'conflict',
    'dead_lettered',
    'delivered',
    'down',
    'expired',
    'failed',
    'in_progress',
    'invalid',
    'ownership_lost',
    'published',
    'rejected',
    'replay',
    'replayed',
    'retrying',
    'success',
    'up',
  ]),
  service: new Set(['api', 'worker']),
  status_class: new Set(['2xx', '3xx', '4xx', '5xx']),
} as const;

type ProtectedLabelName = keyof typeof LABEL_VALUES;
type ProtectedLabels = Partial<Record<ProtectedLabelName, string>>;

export interface MetricsRegistryOptions {
  readonly releaseCommit: string;
  readonly releaseVersion: string;
  readonly service: 'api' | 'worker';
}

export class MetricsRegistry {
  public readonly contentType: string;
  private readonly dependencyReady: Gauge<'dependency' | 'service'>;
  private readonly httpDuration: Histogram<'method' | 'route' | 'status_class'>;
  private readonly httpRequests: Counter<'method' | 'route' | 'status_class'>;
  private readonly processReady: Gauge<'service'>;
  private readonly telemetryDropped: Counter<'service'>;
  private readonly registry = new Registry();

  public constructor(private readonly options: MetricsRegistryOptions) {
    this.registry.setDefaultLabels({ service: options.service });
    new Gauge({
      help: 'Immutable build identity for the running process.',
      labelNames: ['commit', 'service', 'version'],
      name: 'settleflow_build_info',
      registers: [this.registry],
    }).set(
      { commit: options.releaseCommit, service: options.service, version: options.releaseVersion },
      1,
    );
    this.processReady = new Gauge({
      help: 'Whether the process is eligible for work or traffic.',
      labelNames: ['service'],
      name: 'settleflow_process_ready',
      registers: [this.registry],
    });
    this.dependencyReady = new Gauge({
      help: 'Whether a bounded required dependency class is ready.',
      labelNames: ['dependency', 'service'],
      name: 'settleflow_dependency_ready',
      registers: [this.registry],
    });
    this.httpRequests = new Counter({
      help: 'Completed HTTP requests by bounded route template and status class.',
      labelNames: ['method', 'route', 'status_class'],
      name: 'settleflow_http_requests_total',
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.3, 0.6, 1, 2.5, 5],
      help: 'HTTP request duration in seconds.',
      labelNames: ['method', 'route', 'status_class'],
      name: 'settleflow_http_request_duration_seconds',
      registers: [this.registry],
    });
    this.telemetryDropped = new Counter({
      help: 'Telemetry observations dropped by the non-interference boundary.',
      labelNames: ['service'],
      name: 'settleflow_telemetry_dropped_total',
      registers: [this.registry],
    });
    this.contentType = this.registry.contentType;
    this.declareApprovedCatalog();
  }

  public drop(): void {
    this.nonInterfering(() => this.telemetryDropped.inc({ service: this.options.service }));
  }

  public async exposition(): Promise<string> {
    return this.registry.metrics();
  }

  public observeHttp(input: {
    readonly durationMs: number;
    readonly method: string;
    readonly route: string;
    readonly statusClass: string;
  }): void {
    this.nonInterfering(() => {
      const labels = this.validateLabels({
        method: input.method,
        status_class: input.statusClass,
      });
      const route = normalizeRoute(input.route);
      this.httpRequests.inc({ ...labels, route } as {
        method: string;
        route: string;
        status_class: string;
      });
      this.httpDuration.observe(
        { ...labels, route } as { method: string; route: string; status_class: string },
        input.durationMs / 1_000,
      );
    });
  }

  public setReadiness(ready: boolean, dependencies: Readonly<Record<string, boolean>>): void {
    this.nonInterfering(() => {
      this.processReady.set({ service: this.options.service }, ready ? 1 : 0);
      for (const [dependency, dependencyReady] of Object.entries(dependencies)) {
        const labels = this.validateLabels({ dependency, service: this.options.service });
        this.dependencyReady.set(
          labels as { dependency: string; service: string },
          dependencyReady ? 1 : 0,
        );
      }
    });
  }

  public validateLabels(labels: ProtectedLabels): Record<string, string> {
    const validated: Record<string, string> = {};
    for (const [name, value] of Object.entries(labels)) {
      if (ID_LABEL.test(name)) throw new Error('Identifier metric labels are prohibited');
      const allowed: ReadonlySet<string> | undefined = LABEL_VALUES[name as ProtectedLabelName];
      if (allowed?.has(value) !== true) {
        throw new Error(`Unapproved metric label: ${name}`);
      }
      validated[name] = value;
    }
    return validated;
  }

  private declareApprovedCatalog(): void {
    const counters: readonly [string, readonly string[]][] = [
      ['settleflow_payment_commands_total', ['command', 'outcome', 'currency']],
      ['settleflow_idempotency_outcomes_total', ['outcome']],
      ['settleflow_ledger_postings_total', ['business_type', 'outcome']],
      ['settleflow_ledger_invariant_failures_total', ['error_class']],
      ['settleflow_outbox_publish_total', ['event_type', 'outcome']],
      ['settleflow_rabbit_messages_total', ['consumer', 'event_type', 'outcome']],
      ['settleflow_inbox_dedup_hits_total', ['consumer', 'event_type']],
      ['settleflow_webhook_attempts_total', ['outcome', 'status_class']],
      ['settleflow_settlement_runs_total', ['outcome', 'currency']],
      ['settleflow_reconciliation_imports_total', ['outcome']],
      ['settleflow_reconciliation_results_total', ['outcome', 'currency']],
      ['settleflow_transaction_retries_total', ['module', 'error_class']],
    ];
    const gauges: readonly [string, readonly string[]][] = [
      ['settleflow_outbox_pending', ['event_type']],
      ['settleflow_outbox_oldest_age_seconds', ['event_type']],
      ['settleflow_webhook_due', []],
      ['settleflow_webhook_due_oldest_age_seconds', []],
      ['settleflow_webhook_dead_lettered', []],
      ['settleflow_settlement_pending_adjustments', ['currency']],
      ['settleflow_reconciliation_reports_with_difference', ['currency']],
    ];
    const histograms: readonly [string, readonly string[]][] = [
      ['settleflow_payment_command_duration_seconds', ['command', 'outcome', 'currency']],
      ['settleflow_outbox_publish_duration_seconds', ['event_type', 'outcome']],
      ['settleflow_webhook_delivery_duration_seconds', ['outcome', 'status_class']],
      ['settleflow_settlement_batch_duration_seconds', ['outcome', 'currency']],
      ['settleflow_reconciliation_duration_seconds', ['outcome']],
    ];
    for (const [name, labelNames] of counters) {
      new Counter({
        help: `${name} bounded operational counter.`,
        labelNames,
        name,
        registers: [this.registry],
      });
    }
    for (const [name, labelNames] of gauges) {
      new Gauge({
        help: `${name} bounded operational gauge.`,
        labelNames,
        name,
        registers: [this.registry],
      });
    }
    for (const [name, labelNames] of histograms) {
      new Histogram({
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.3, 0.6, 1, 2.5, 5, 10],
        help: `${name} bounded operational duration.`,
        labelNames,
        name,
        registers: [this.registry],
      });
    }
  }

  private nonInterfering(operation: () => void): void {
    try {
      operation();
    } catch {
      try {
        this.telemetryDropped.inc({ service: this.options.service });
      } catch {
        // Deliberately drop telemetry if even self-observation is unavailable.
      }
    }
  }
}

function normalizeRoute(route: string): string {
  if (/^\/(?:health\/(?:live|ready)|v1(?:\/(?:[a-z0-9-]+|:id))*)$/u.test(route)) return route;
  return 'unmatched';
}

export const metricInternals = { ID_LABEL, LABEL_VALUES, normalizeRoute };
