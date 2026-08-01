import type { ConfigService } from '@nestjs/config';
import type { OutboxRelayService, RabbitMqOutboxPublisher } from '@settleflow/eventing';
import type { PrismaDatabase } from '@settleflow/infrastructure';

import type { WorkerEnvironment } from '../config/environment';
import { WorkerHealthService } from '../health/worker-health.service';
import { OutboxRelaySignalService } from './outbox-relay-signal.service';
import { WorkerRuntimeService } from './worker-runtime.service';

function createConfig(): ConfigService<WorkerEnvironment, true> {
  const values: WorkerEnvironment = {
    DATABASE_URL: 'postgresql://settleflow:local@127.0.0.1:5432/settleflow',
    DEPENDENCY_READINESS_TIMEOUT_MS: 2_000,
    NODE_ENV: 'test',
    OUTBOX_RELAY_BATCH_SIZE: 50,
    OUTBOX_RELAY_CONFIRM_TIMEOUT_MS: 5_000,
    OUTBOX_RELAY_LEASE_MS: 30_000,
    OUTBOX_RELAY_POLL_INTERVAL_MS: 500,
    OUTBOX_RELAY_RETRY_BASE_MS: 1_000,
    OUTBOX_RELAY_RETRY_MAX_MS: 60_000,
    OUTBOX_RELAY_SHUTDOWN_TIMEOUT_MS: 10_000,
    RABBITMQ_URL: 'amqp://settleflow:local@127.0.0.1:5672/settleflow',
    WORKER_HEARTBEAT_INTERVAL_MS: 30_000,
  };
  return {
    get: jest.fn((key: keyof WorkerEnvironment) => values[key]),
  } as unknown as ConfigService<WorkerEnvironment, true>;
}

describe('WorkerRuntimeService', () => {
  it('requires PostgreSQL plus the confirmed topology before becoming ready', async () => {
    jest.useFakeTimers();
    const prisma = {
      checkConnectivity: jest.fn().mockResolvedValue(true),
    } as unknown as PrismaDatabase;
    const ensureReady = jest.fn().mockResolvedValue(true);
    const publisher = {
      ensureReady,
    } as unknown as RabbitMqOutboxPublisher;
    const relay = {
      runOnce: jest.fn().mockResolvedValue({
        claimed: 0,
        ownershipLost: 0,
        published: 0,
        publisherReady: true,
        retryScheduled: 0,
      }),
    } as unknown as OutboxRelayService;
    const health = new WorkerHealthService();
    const record = jest.fn();
    const signals = { record } as unknown as OutboxRelaySignalService;
    const runtime = new WorkerRuntimeService(
      createConfig(),
      prisma,
      publisher,
      relay,
      health,
      signals,
    );

    await runtime.onApplicationBootstrap();

    expect(health.getReadiness().status).toBe('ready');
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ event: 'outbox.relay.started' });
    runtime.beforeApplicationShutdown('SIGTERM');
    jest.useRealTimers();
  });

  it('runs only one relay cycle at a time', async () => {
    jest.useFakeTimers();
    let release:
      | ((value: {
          claimed: number;
          ownershipLost: number;
          published: number;
          publisherReady: boolean;
          retryScheduled: number;
        }) => void)
      | undefined;
    const activeCycle = new Promise<{
      claimed: number;
      ownershipLost: number;
      published: number;
      publisherReady: boolean;
      retryScheduled: number;
    }>((resolve) => {
      release = resolve;
    });
    const prisma = {
      checkConnectivity: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as PrismaDatabase;
    const publisher = {
      close: jest.fn().mockResolvedValue(undefined),
      ensureReady: jest.fn().mockResolvedValue(true),
    } as unknown as RabbitMqOutboxPublisher;
    const runOnce = jest.fn().mockReturnValue(activeCycle);
    const relay = { runOnce } as unknown as OutboxRelayService;
    const runtime = new WorkerRuntimeService(
      createConfig(),
      prisma,
      publisher,
      relay,
      new WorkerHealthService(),
      { record: jest.fn() } as unknown as OutboxRelaySignalService,
    );

    await runtime.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    release?.({
      claimed: 0,
      ownershipLost: 0,
      published: 0,
      publisherReady: true,
      retryScheduled: 0,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(500);
    expect(runOnce).toHaveBeenCalledTimes(2);

    runtime.beforeApplicationShutdown('SIGTERM');
    release?.({
      claimed: 0,
      ownershipLost: 0,
      published: 0,
      publisherReady: true,
      retryScheduled: 0,
    });
    jest.useRealTimers();
  });

  it('stops new work, drains, and closes publisher before Prisma', async () => {
    const closeOrder: string[] = [];
    const prisma = {
      close: jest.fn(() => {
        closeOrder.push('prisma');
        return Promise.resolve();
      }),
    } as unknown as PrismaDatabase;
    const publisher = {
      close: jest.fn(() => {
        closeOrder.push('publisher');
        return Promise.resolve();
      }),
    } as unknown as RabbitMqOutboxPublisher;
    const relay = {} as OutboxRelayService;
    const runtime = new WorkerRuntimeService(
      createConfig(),
      prisma,
      publisher,
      relay,
      new WorkerHealthService(),
      { record: jest.fn() } as unknown as OutboxRelaySignalService,
    );

    runtime.beforeApplicationShutdown('SIGTERM');
    await runtime.onApplicationShutdown();

    expect(closeOrder).toEqual(['publisher', 'prisma']);
  });
});
