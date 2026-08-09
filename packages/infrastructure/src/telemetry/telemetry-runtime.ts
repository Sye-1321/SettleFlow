import type { Span } from '@opentelemetry/api';

import {
  InternalHttpServer,
  type InternalHealthSource,
  type InternalReadiness,
} from './internal-http-server';
import { MetricsRegistry } from './metrics';
import { StructuredJsonLogger } from './structured-json-logger';
import { TelemetryContext, type TelemetryContextValue } from './telemetry-context';
import { TracingRuntime } from './tracing';

export interface TelemetryRuntimeOptions {
  readonly environment: 'development' | 'production' | 'test';
  readonly internalListener: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
  };
  readonly releaseCommit: string;
  readonly releaseVersion: string;
  readonly service: 'api' | 'worker';
  readonly tracing: {
    readonly demo: boolean;
    readonly enabled: boolean;
    readonly endpoint?: string;
    readonly exportTimeoutMs: number;
    readonly sampleRatio: number;
  };
}

export class TelemetryRuntime {
  public readonly context = new TelemetryContext();
  public readonly logger: StructuredJsonLogger;
  public readonly metrics: MetricsRegistry;
  private internalServer: InternalHttpServer | undefined;
  private stopping = false;
  private readonly tracing: TracingRuntime;

  public constructor(private readonly options: TelemetryRuntimeOptions) {
    this.metrics = new MetricsRegistry(options);
    this.logger = new StructuredJsonLogger(options, this.context);
    this.tracing = new TracingRuntime(
      {
        ...options.tracing,
        releaseCommit: options.releaseCommit,
        releaseVersion: options.releaseVersion,
        service: options.service,
      },
      () => this.metrics.drop(),
    );
  }

  public beginShutdown(): void {
    this.stopping = true;
    this.updateReadinessMetrics({ checks: {}, ready: false });
  }

  public internalAddress(): { readonly address: string; readonly port: number } | undefined {
    return this.internalServer?.address();
  }

  public async shutdown(): Promise<void> {
    this.beginShutdown();
    try {
      await this.internalServer?.close();
    } finally {
      await this.tracing.shutdown();
    }
  }

  public async span<T>(
    name: string,
    attributes: Readonly<Record<string, boolean | number | string | undefined>>,
    operation: (span: Span | undefined) => Promise<T>,
  ): Promise<T> {
    return this.tracing.span(name, attributes, operation);
  }

  public async start(health: InternalHealthSource): Promise<void> {
    this.tracing.start();
    if (!this.options.internalListener.enabled) return;
    const internalServer = new InternalHttpServer(
      this.options.internalListener,
      {
        liveness: (): object => health.liveness(),
        readiness: async (): Promise<InternalReadiness> => {
          const current = this.stopping ? { checks: {}, ready: false } : await health.readiness();
          this.updateReadinessMetrics(current);
          return current;
        },
      },
      async () => ({
        body: await this.metrics.exposition(),
        contentType: this.metrics.contentType,
      }),
    );
    try {
      await internalServer.start();
      this.internalServer = internalServer;
    } catch {
      this.metrics.drop();
      this.logger.record('warn', {
        code: 'listener_unavailable',
        event: 'telemetry.internal_listener.unavailable',
      });
    }
  }

  public updateReadinessMetrics(readiness: InternalReadiness): void {
    this.metrics.setReadiness(readiness.ready && !this.stopping, readiness.checks);
  }

  public withContext<T>(values: TelemetryContextValue, callback: () => T): T {
    return this.context.run(values, callback);
  }
}
