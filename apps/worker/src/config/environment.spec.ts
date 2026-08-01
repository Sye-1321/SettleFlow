import { validateWorkerEnvironment } from './environment';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://settleflow:local@127.0.0.1:5432/settleflow',
  RABBITMQ_URL: 'amqp://settleflow:local@127.0.0.1:5672/settleflow',
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
    });
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
});
