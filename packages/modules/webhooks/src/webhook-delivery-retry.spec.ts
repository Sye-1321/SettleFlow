import { calculateWebhookRetryDelayMs, classifyWebhookResult } from './webhook-delivery-retry';

describe('webhook delivery retry policy', () => {
  it.each([
    [2, 60_000],
    [3, 300_000],
    [4, 900_000],
    [5, 3_600_000],
    [6, 21_600_000],
    [7, 86_400_000],
  ])('uses the approved full-jitter ceiling for attempt %i', (attempt, ceiling) => {
    expect(calculateWebhookRetryDelayMs(attempt, () => 0)).toBe(0);
    expect(calculateWebhookRetryDelayMs(attempt, () => 1)).toBe(ceiling);
  });

  it('has no automatic schedule outside attempts two through seven', () => {
    expect(calculateWebhookRetryDelayMs(1, Math.random)).toBeUndefined();
    expect(calculateWebhookRetryDelayMs(8, Math.random)).toBeUndefined();
  });

  it.each([408, 429, 500, 599])('retries HTTP %i until the seventh attempt', (statusCode) => {
    const result = {
      bodySha256: Buffer.alloc(32),
      bodyTruncated: false,
      kind: 'response' as const,
      statusCode,
    };
    expect(classifyWebhookResult(1, result)).toMatchObject({
      evidence: { outcome: 'retryable_failure' },
      status: 'retrying',
    });
    expect(classifyWebhookResult(7, result)).toMatchObject({
      evidence: { outcome: 'retryable_failure' },
      status: 'dead_lettered',
    });
  });

  it.each([200, 204, 299])('delivers on HTTP %i', (statusCode) => {
    expect(
      classifyWebhookResult(1, {
        bodySha256: Buffer.alloc(32),
        bodyTruncated: false,
        kind: 'response',
        statusCode,
      }),
    ).toMatchObject({ evidence: { outcome: 'delivered' }, status: 'delivered' });
  });

  it.each([301, 400, 409, 422, 499])('dead-letters non-retryable HTTP %i', (statusCode) => {
    expect(
      classifyWebhookResult(1, {
        bodySha256: Buffer.alloc(32),
        bodyTruncated: false,
        kind: 'response',
        statusCode,
      }),
    ).toMatchObject({ evidence: { outcome: 'non_retryable_failure' }, status: 'dead_lettered' });
  });

  it('distinguishes transient transport from security/configuration failures', () => {
    expect(classifyWebhookResult(1, { code: 'request_timeout', kind: 'failure' }).status).toBe(
      'retrying',
    );
    expect(
      classifyWebhookResult(1, { code: 'destination_prohibited', kind: 'failure' }).status,
    ).toBe('dead_lettered');
    expect(
      classifyWebhookResult(1, { code: 'tls_verification_failed', kind: 'failure' }).status,
    ).toBe('dead_lettered');
  });
});
