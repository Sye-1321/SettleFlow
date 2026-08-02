import { Buffer } from 'node:buffer';

import { validateApiEnvironment } from './environment';

const baseEnvironment = {
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
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
      IDEMPOTENCY_LEASE_MS: 30_000,
      IDEMPOTENCY_LOCK_TIMEOUT_MS: 5_000,
      IDEMPOTENCY_REPLAY_TTL_HOURS: 168,
      IDEMPOTENCY_STATEMENT_TIMEOUT_MS: 10_000,
    });
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
});
