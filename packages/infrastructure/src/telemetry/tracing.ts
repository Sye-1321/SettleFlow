import { SpanStatusCode, trace, type Attributes, type Span, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';

const SAFE_ATTRIBUTE_NAMES = new Set([
  'code',
  'consumer',
  'event.type',
  'http.method',
  'http.route',
  'http.status_class',
  'operation',
  'outcome',
  'request.id',
  'resource.id',
  'retry.count',
  'service',
  'settleflow.demo',
]);

export interface TracingOptions {
  readonly demo: boolean;
  readonly enabled: boolean;
  readonly endpoint?: string;
  readonly exportTimeoutMs: number;
  readonly releaseCommit: string;
  readonly releaseVersion: string;
  readonly sampleRatio: number;
  readonly service: 'api' | 'worker';
}

export class TracingRuntime {
  private sdk: NodeSDK | undefined;
  private tracer: Tracer | undefined;

  public constructor(
    private readonly options: TracingOptions,
    private readonly onDrop: () => void,
  ) {}

  public start(): void {
    if (!this.options.enabled || this.sdk !== undefined) return;
    try {
      if (this.options.endpoint === undefined) throw new Error('Tracing endpoint is required');
      const exporter = new PolicySpanExporter(
        new OTLPTraceExporter({ url: this.options.endpoint }),
        this.options.sampleRatio,
        this.options.demo,
        this.onDrop,
      );
      const sdk = new NodeSDK({
        resource: resourceFromAttributes({
          'service.name': this.options.service,
          'service.version': this.options.releaseVersion,
          'vcs.ref.head.revision': this.options.releaseCommit,
        }),
        sampler: new AlwaysOnSampler(),
        spanProcessors: [
          new BatchSpanProcessor(exporter, {
            exportTimeoutMillis: this.options.exportTimeoutMs,
            maxExportBatchSize: 128,
            maxQueueSize: 512,
            scheduledDelayMillis: 1_000,
          }),
        ],
      });
      sdk.start();
      this.sdk = sdk;
      this.tracer = trace.getTracer('settleflow', this.options.releaseVersion);
    } catch {
      this.sdk = undefined;
      this.tracer = undefined;
      this.onDrop();
    }
  }

  public async shutdown(): Promise<void> {
    const sdk = this.sdk;
    this.sdk = undefined;
    this.tracer = undefined;
    if (sdk === undefined) return;
    try {
      await sdk.shutdown();
    } catch {
      this.onDrop();
    }
  }

  public async span<T>(
    name: string,
    attributes: Readonly<Record<string, boolean | number | string | undefined>>,
    operation: (span: Span | undefined) => Promise<T>,
  ): Promise<T> {
    const tracer = this.tracer;
    if (tracer === undefined) return operation(undefined);
    const safeAttributes = safeTraceAttributes(attributes);
    return tracer.startActiveSpan(name, { attributes: safeAttributes }, async (span) => {
      try {
        const result = await operation(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

export class PolicySpanExporter implements SpanExporter {
  public constructor(
    private readonly exporter: SpanExporter,
    private readonly successfulSampleRatio: number,
    private readonly demo: boolean,
    private readonly onDrop: () => void,
  ) {}

  public export(spans: ReadableSpan[], callback: Parameters<SpanExporter['export']>[1]): void {
    const selected = spans.filter(
      (span) =>
        span.status.code === SpanStatusCode.ERROR ||
        this.demo ||
        span.attributes['settleflow.demo'] === true ||
        traceIdSelected(span.spanContext().traceId, this.successfulSampleRatio),
    );
    if (selected.length === 0) {
      callback({ code: 0 });
      return;
    }
    try {
      this.exporter.export(selected, (result) => {
        if (Number(result.code) !== 0) this.onDrop();
        callback(result);
      });
    } catch {
      this.onDrop();
      callback({ code: 1 });
    }
  }

  public forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
  }

  public async shutdown(): Promise<void> {
    try {
      await this.exporter.shutdown();
    } catch {
      this.onDrop();
    }
  }
}

export function safeTraceAttributes(
  attributes: Readonly<Record<string, boolean | number | string | undefined>>,
): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, boolean | number | string] =>
        SAFE_ATTRIBUTE_NAMES.has(entry[0]) && entry[1] !== undefined,
    ),
  );
}

export function traceIdSelected(traceId: string, ratio: number): boolean {
  if (ratio <= 0) return false;
  if (ratio >= 1) return true;
  const bucket = Number.parseInt(traceId.slice(0, 8), 16) / 0x1_0000_0000;
  return bucket < ratio;
}

export const tracingInternals = { SAFE_ATTRIBUTE_NAMES };
