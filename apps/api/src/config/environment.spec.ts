import { Buffer } from 'node:buffer';

import { validateApiEnvironment } from './environment';

const baseEnvironment = {
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  DATABASE_MAX_CONNECTIONS: '30',
  DATABASE_URL: 'postgresql://local:local@127.0.0.1:5432/settleflow',
  DEPENDENCY_READINESS_TIMEOUT_MS: '2000',
  IDEMPOTENCY_LEASE_MS: '30000',
  IDEMPOTENCY_LOCK_TIMEOUT_MS: '5000',
  IDEMPOTENCY_REPLAY_TTL_HOURS: '168',
  IDEMPOTENCY_STATEMENT_TIMEOUT_MS: '10000',
  NODE_ENV: 'test',
  RABBITMQ_URL: 'amqp://local:local@127.0.0.1:5672/settleflow',
  WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS: '[]',
  WEBHOOK_KEYRING_PROVIDER: 'local',
  WEBHOOK_LOCAL_ACTIVE_KEY_ID: 'test-v1',
  WEBHOOK_LOCAL_KEYS_JSON: JSON.stringify({
    'test-v1': Buffer.alloc(32).toString('base64url'),
  }),
  WEBHOOK_URL_POLICY_MODE: 'production',
};

describe('API environment', () => {
  it('accepts the safe bounded idempotency defaults', () => {
    expect(validateApiEnvironment(baseEnvironment)).toMatchObject({
      DATABASE_MAX_CONNECTIONS: 30,
      IDEMPOTENCY_LEASE_MS: 30_000,
      IDEMPOTENCY_LOCK_TIMEOUT_MS: 5_000,
      IDEMPOTENCY_REPLAY_TTL_HOURS: 168,
      IDEMPOTENCY_STATEMENT_TIMEOUT_MS: 10_000,
      INTERNAL_TELEMETRY_ENABLED: false,
      OTEL_TRACE_SAMPLE_RATIO: 0.1,
      OTEL_TRACING_ENABLED: false,
    });
  });

  it('bounds the API database pool independently of readiness timeouts', () => {
    expect(() =>
      validateApiEnvironment({ ...baseEnvironment, DATABASE_MAX_CONNECTIONS: '0' }),
    ).toThrow('DATABASE_MAX_CONNECTIONS');
    expect(() =>
      validateApiEnvironment({ ...baseEnvironment, DATABASE_MAX_CONNECTIONS: '51' }),
    ).toThrow('DATABASE_MAX_CONNECTIONS');
  });

  it('requires an HTTP OTLP endpoint only when tracing is enabled', () => {
    expect(() =>
      validateApiEnvironment({ ...baseEnvironment, OTEL_TRACING_ENABLED: 'true' }),
    ).toThrow('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
    expect(
      validateApiEnvironment({
        ...baseEnvironment,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces',
        OTEL_TRACING_ENABLED: 'true',
      }).OTEL_TRACING_ENABLED,
    ).toBe(true);
  });

  it('requires lock and statement work to fit inside the owner lease', () => {
    expect(() =>
      validateApiEnvironment({
        ...baseEnvironment,
        IDEMPOTENCY_LOCK_TIMEOUT_MS: '11000',
      }),
    ).toThrow('IDEMPOTENCY_LOCK_TIMEOUT_MS');
    expect(() =>
      validateApiEnvironment({
        ...baseEnvironment,
        IDEMPOTENCY_LEASE_MS: '10000',
      }),
    ).toThrow('IDEMPOTENCY_STATEMENT_TIMEOUT_MS');
  });

  it('rejects the development URL policy and local keyring in production', () => {
    expect(() =>
      validateApiEnvironment({
        ...baseEnvironment,
        NODE_ENV: 'production',
        WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS: '["http://127.0.0.1:8080"]',
        WEBHOOK_URL_POLICY_MODE: 'development',
      }),
    ).toThrow('Production');
  });

  it('requires an explicitly non-production release-simulation internal listener', () => {
    expect(
      validateApiEnvironment({
        ...baseEnvironment,
        INTERNAL_TELEMETRY_HOST: '0.0.0.0',
        NODE_ENV: 'development',
        SETTLEFLOW_DEPLOYMENT_MODE: 'release-simulation',
      }).SETTLEFLOW_DEPLOYMENT_MODE,
    ).toBe('release-simulation');
    expect(() =>
      validateApiEnvironment({ ...baseEnvironment, INTERNAL_TELEMETRY_HOST: '0.0.0.0' }),
    ).toThrow('Host mode requires a loopback');
    expect(() =>
      validateApiEnvironment({
        ...baseEnvironment,
        INTERNAL_TELEMETRY_HOST: '0.0.0.0',
        NODE_ENV: 'production',
        SETTLEFLOW_DEPLOYMENT_MODE: 'release-simulation',
      }),
    ).toThrow('Release-simulation mode requires NODE_ENV=development');
  });
});
