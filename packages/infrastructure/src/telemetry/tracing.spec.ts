import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

import {
  PolicySpanExporter,
  safeTraceAttributes,
  traceIdSelected,
  TracingRuntime,
} from './tracing';

describe('tracing policy', () => {
  it('uses deterministic ten-percent successful sampling boundaries', () => {
    expect(traceIdSelected('00000000ffffffffffffffffffffffff', 0.1)).toBe(true);
    expect(traceIdSelected('ffffffffffffffffffffffffffffffff', 0.1)).toBe(false);
    expect(traceIdSelected('ffffffffffffffffffffffffffffffff', 1)).toBe(true);
  });

  it('keeps only explicitly allowlisted attributes', () => {
    expect(
      safeTraceAttributes({
        'http.route': '/v1/payment-intents',
        amountMinor: 100,
        destination: 'https://example.test',
        operation: 'payment.create',
      }),
    ).toEqual({ 'http.route': '/v1/payment-intents', operation: 'payment.create' });
  });

  it('exports errors even when successful traces are not selected', () => {
    const exported: ReadableSpan[][] = [];
    const exporter = {
      export: (spans: ReadableSpan[], callback: Parameters<SpanExporter['export']>[1]): void => {
        exported.push(spans);
        callback({ code: 0 });
      },
      shutdown: (): Promise<void> => Promise.resolve(),
    } satisfies SpanExporter;
    const policy = new PolicySpanExporter(exporter, 0, false, jest.fn());
    const ok = span('ffffffffffffffffffffffffffffffff', SpanStatusCode.OK);
    const failed = span('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', SpanStatusCode.ERROR);

    policy.export([ok, failed], jest.fn());

    expect(exported).toEqual([[failed]]);
  });

  it('does not change the operation result when the OTLP endpoint is unavailable', async () => {
    const drop = jest.fn();
    const tracing = new TracingRuntime(
      {
        demo: true,
        enabled: true,
        endpoint: 'http://127.0.0.1:1/v1/traces',
        exportTimeoutMs: 100,
        releaseCommit: 'local',
        releaseVersion: '0.0.0-test',
        sampleRatio: 0.1,
        service: 'worker',
      },
      drop,
    );
    tracing.start();

    await expect(
      tracing.span('outbox.claim', { operation: 'outbox.claim' }, () => Promise.resolve(42)),
    ).resolves.toBe(42);
    await tracing.shutdown();
    expect(drop).toHaveBeenCalled();
  });

  it('drops tracing instead of failing work when runtime initialization is invalid', async () => {
    const drop = jest.fn();
    const tracing = new TracingRuntime(
      {
        demo: false,
        enabled: true,
        exportTimeoutMs: 100,
        releaseCommit: 'local',
        releaseVersion: '0.0.0-test',
        sampleRatio: 0.1,
        service: 'api',
      },
      drop,
    );

    expect(() => tracing.start()).not.toThrow();
    await expect(tracing.span('http.request', {}, () => Promise.resolve(42))).resolves.toBe(42);
    expect(drop).toHaveBeenCalledTimes(1);
  });
});

function span(traceId: string, status: SpanStatusCode): ReadableSpan {
  return {
    attributes: {},
    spanContext: () => ({ spanId: '0000000000000001', traceFlags: 1, traceId }),
    status: { code: status },
  } as unknown as ReadableSpan;
}
