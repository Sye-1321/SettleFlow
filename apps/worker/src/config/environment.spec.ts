import { validateWorkerEnvironment } from './environment';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://settleflow:local@127.0.0.1:5432/settleflow',
  RABBITMQ_URL: 'amqp://settleflow:local@127.0.0.1:5672/settleflow',
  WEBHOOK_KEYRING_PROVIDER: 'local',
  WEBHOOK_LOCAL_ACTIVE_KEY_ID: 'local-v1',
  WEBHOOK_LOCAL_KEYS_JSON: JSON.stringify({
    'local-v1': Buffer.alloc(32, 1).toString('base64url'),
  }),
};

describe('validateWorkerEnvironment', () => {
  it('applies every approved relay default', () => {
    expect(validateWorkerEnvironment(baseEnvironment)).toMatchObject({
      OUTBOX_RELAY_BATCH_SIZE: 50,
      OUTBOX_RELAY_CONFIRM_TIMEOUT_MS: 5_000,
      OUTBOX_RELAY_LEASE_MS: 30_000,
      OUTBOX_RELAY_POLL_INTERVAL_MS: 500,
      OUTBOX_RELAY_RETRY_BASE_MS: 1_000,
      OUTBOX_RELAY_RETRY_MAX_MS: 60_000,
      OUTBOX_RELAY_SHUTDOWN_TIMEOUT_MS: 10_000,
      INTERNAL_TELEMETRY_ENABLED: true,
      OTEL_TRACE_SAMPLE_RATIO: 0.1,
      OTEL_TRACING_ENABLED: false,
      OPERATIONAL_METRICS_POLL_INTERVAL_MS: 15_000,
      OPERATIONAL_METRICS_QUERY_TIMEOUT_MS: 2_000,
      WEBHOOK_DELIVERY_ATTEMPT_TIMEOUT_MS: 8_000,
      WEBHOOK_DELIVERY_BATCH_SIZE: 4,
      WEBHOOK_DELIVERY_CONCURRENCY: 4,
      WEBHOOK_DELIVERY_LEASE_MS: 30_000,
      WEBHOOK_DELIVERY_POLL_INTERVAL_MS: 500,
      WEBHOOK_DELIVERY_RESPONSE_LIMIT_BYTES: 65_536,
      WEBHOOK_DELIVERY_SHUTDOWN_TIMEOUT_MS: 10_000,
      WEBHOOK_DELIVERY_TRANSACTION_RETRIES: 3,
      WEBHOOK_PROJECTION_BODY_LIMIT_BYTES: 16_384,
      WEBHOOK_PROJECTION_PREFETCH: 2,
      WEBHOOK_PROJECTION_RECONNECT_BASE_MS: 1_000,
      WEBHOOK_PROJECTION_RECONNECT_MAX_MS: 60_000,
      WEBHOOK_PROJECTION_SHUTDOWN_TIMEOUT_MS: 10_000,
      WEBHOOK_PROJECTION_TRANSACTION_RETRIES: 3,
    });
  });

  it('rejects production startup with the local keyring or development URL policy', () => {
    expect(() =>
      validateWorkerEnvironment({
        ...baseEnvironment,
        NODE_ENV: 'production',
        WEBHOOK_URL_POLICY_MODE: 'development',
      }),
    ).toThrow('Production requires WEBHOOK_URL_POLICY_MODE=production');
    expect(() =>
      validateWorkerEnvironment({
        ...baseEnvironment,
        NODE_ENV: 'production',
        WEBHOOK_URL_POLICY_MODE: 'production',
      }),
    ).toThrow('local webhook keyring provider is forbidden in production');
  });

  it('rejects a confirm timeout that is not shorter than the lease', () => {
    expect(() =>
      validateWorkerEnvironment({
        ...baseEnvironment,
        OUTBOX_RELAY_CONFIRM_TIMEOUT_MS: 5_000,
        OUTBOX_RELAY_LEASE_MS: 5_000,
      }),
    ).toThrow('OUTBOX_RELAY_CONFIRM_TIMEOUT_MS must be shorter');
  });

  it('requires an explicitly non-production release-simulation internal listener', () => {
    expect(
      validateWorkerEnvironment({
        ...baseEnvironment,
        INTERNAL_TELEMETRY_HOST: '0.0.0.0',
        NODE_ENV: 'development',
        SETTLEFLOW_DEPLOYMENT_MODE: 'release-simulation',
      }).SETTLEFLOW_DEPLOYMENT_MODE,
    ).toBe('release-simulation');
    expect(() =>
      validateWorkerEnvironment({ ...baseEnvironment, INTERNAL_TELEMETRY_HOST: '0.0.0.0' }),
    ).toThrow('Host mode requires a loopback');
  });
});
