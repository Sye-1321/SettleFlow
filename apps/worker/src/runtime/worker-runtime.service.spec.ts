import type { ConfigService } from '@nestjs/config';
import type {
  OutboxRelayService,
  RabbitMqOutboxPublisher,
  RabbitMqPaymentCreatedConsumer,
  RabbitMqSettlementLifecycleConsumer,
} from '@settleflow/eventing';
import type { PrismaDatabase, TelemetryRuntime } from '@settleflow/infrastructure';
import type { ReconciliationProcessor } from '@settleflow/reconciliation';
import type { WebhookDeliveryService } from '@settleflow/webhooks';

import type { WorkerEnvironment } from '../config/environment';
import { WorkerHealthService } from '../health/worker-health.service';
import { OutboxRelaySignalService } from './outbox-relay-signal.service';
import { WebhookDeliverySignalService } from './webhook-delivery-signal.service';
import { WorkerRuntimeService } from './worker-runtime.service';

function createConfig(): ConfigService<WorkerEnvironment, true> {
  const values: WorkerEnvironment = {
    DATABASE_URL: 'postgresql://settleflow:local@127.0.0.1:5432/settleflow',
    DEPENDENCY_READINESS_TIMEOUT_MS: 2_000,
    INTERNAL_TELEMETRY_ENABLED: false,
    INTERNAL_TELEMETRY_HOST: '127.0.0.1',
    INTERNAL_TELEMETRY_PORT: 9_465,
    NODE_ENV: 'test',
    OPERATIONAL_METRICS_POLL_INTERVAL_MS: 15_000,
    OPERATIONAL_METRICS_QUERY_TIMEOUT_MS: 2_000,
    OUTBOX_RELAY_BATCH_SIZE: 50,
    OUTBOX_RELAY_CONFIRM_TIMEOUT_MS: 5_000,
    OUTBOX_RELAY_LEASE_MS: 30_000,
    OUTBOX_RELAY_POLL_INTERVAL_MS: 500,
    OUTBOX_RELAY_RETRY_BASE_MS: 1_000,
    OUTBOX_RELAY_RETRY_MAX_MS: 60_000,
    OUTBOX_RELAY_SHUTDOWN_TIMEOUT_MS: 10_000,
    OTEL_DEMO_TRACE_MODE: false,
    OTEL_TRACE_EXPORT_TIMEOUT_MS: 5_000,
    OTEL_TRACE_SAMPLE_RATIO: 0.1,
    OTEL_TRACING_ENABLED: false,
    RABBITMQ_URL: 'amqp://settleflow:local@127.0.0.1:5672/settleflow',
    RELEASE_COMMIT: 'local',
    RELEASE_VERSION: '0.0.0-test',
    RECONCILIATION_POLL_INTERVAL_MS: 500,
    SETTLEFLOW_DEPLOYMENT_MODE: 'host',
    SETTLEMENT_CONSUMER_BODY_LIMIT_BYTES: 16_384,
    SETTLEMENT_CONSUMER_PREFETCH: 2,
    SETTLEMENT_CONSUMER_RECONNECT_BASE_MS: 1_000,
    SETTLEMENT_CONSUMER_RECONNECT_MAX_MS: 60_000,
    SETTLEMENT_CONSUMER_SHUTDOWN_TIMEOUT_MS: 10_000,
    WEBHOOK_DELIVERY_ATTEMPT_TIMEOUT_MS: 8_000,
    WEBHOOK_DELIVERY_BATCH_SIZE: 4,
    WEBHOOK_DELIVERY_CONCURRENCY: 4,
    WEBHOOK_DELIVERY_LEASE_MS: 30_000,
    WEBHOOK_DELIVERY_POLL_INTERVAL_MS: 500,
    WEBHOOK_DELIVERY_RESPONSE_LIMIT_BYTES: 65_536,
    WEBHOOK_DELIVERY_SHUTDOWN_TIMEOUT_MS: 10_000,
    WEBHOOK_DELIVERY_TRANSACTION_RETRIES: 3,
    WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS: [],
    WEBHOOK_KEYRING_PROVIDER: 'local',
    WEBHOOK_LOCAL_ACTIVE_KEY_ID: 'local-v1',
    WEBHOOK_LOCAL_KEYS_JSON: JSON.stringify({
      'local-v1': Buffer.alloc(32, 1).toString('base64url'),
    }),
    WEBHOOK_PROJECTION_BODY_LIMIT_BYTES: 16_384,
    WEBHOOK_PROJECTION_PREFETCH: 2,
    WEBHOOK_PROJECTION_RECONNECT_BASE_MS: 1_000,
    WEBHOOK_PROJECTION_RECONNECT_MAX_MS: 60_000,
    WEBHOOK_PROJECTION_SHUTDOWN_TIMEOUT_MS: 10_000,
    WEBHOOK_PROJECTION_TRANSACTION_RETRIES: 3,
    WEBHOOK_URL_POLICY_MODE: 'development',
    WORKER_HEARTBEAT_INTERVAL_MS: 30_000,
  };
  return {
    get: jest.fn((key: keyof WorkerEnvironment) => values[key]),
  } as unknown as ConfigService<WorkerEnvironment, true>;
}

describe('WorkerRuntimeService', () => {
  function createTelemetry(): TelemetryRuntime {
    return {
      beginShutdown: jest.fn(),
      logger: { record: jest.fn() },
      shutdown: jest.fn().mockResolvedValue(undefined),
      span: jest.fn(
        async (
          _name: string,
          _attributes: object,
          operation: () => Promise<unknown>,
        ): Promise<unknown> => operation(),
      ),
      start: jest.fn().mockResolvedValue(undefined),
      updateReadinessMetrics: jest.fn(),
      withContext: jest.fn((_context: object, operation: () => unknown) => operation()),
    } as unknown as TelemetryRuntime;
  }
  function createSettlementConsumer(): RabbitMqSettlementLifecycleConsumer {
    return {
      beginShutdown: jest.fn(),
      close: jest.fn().mockResolvedValue(true),
      ensureReady: jest.fn().mockResolvedValue(true),
      isReady: jest.fn().mockReturnValue(true),
    } as unknown as RabbitMqSettlementLifecycleConsumer;
  }

  function createReconciliationProcessor(): ReconciliationProcessor {
    return {
      processNext: jest.fn().mockResolvedValue(false),
    } as unknown as ReconciliationProcessor;
  }
  function createDelivery(overrides: Partial<WebhookDeliveryService> = {}): WebhookDeliveryService {
    return {
      abortActive: jest.fn(),
      beginShutdown: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(true),
      isReady: jest.fn().mockReturnValue(true),
      runOnce: jest.fn().mockResolvedValue({
        claimed: 0,
        deadLettered: 0,
        delivered: 0,
        dispatcherReady: true,
        ownershipLost: 0,
        recoveredUnknown: 0,
        retrying: 0,
      }),
      ...overrides,
    } as unknown as WebhookDeliveryService;
  }

  it('requires PostgreSQL plus the confirmed topology before becoming ready', async () => {
    jest.useFakeTimers();
    const prisma = {
      checkConnectivity: jest.fn().mockResolvedValue(true),
    } as unknown as PrismaDatabase;
    const ensureReady = jest.fn().mockResolvedValue(true);
    const publisher = {
      ensureReady,
    } as unknown as RabbitMqOutboxPublisher;
    const ensureConsumerReady = jest.fn().mockResolvedValue(true);
    const consumer = {
      beginShutdown: jest.fn(),
      ensureReady: ensureConsumerReady,
      isReady: jest.fn().mockReturnValue(true),
    } as unknown as RabbitMqPaymentCreatedConsumer;
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
    const delivery = createDelivery();
    const telemetryStart = jest.fn().mockResolvedValue(undefined);
    const telemetryBeginShutdown = jest.fn();
    const telemetry = {
      beginShutdown: telemetryBeginShutdown,
      logger: { record: jest.fn() },
      shutdown: jest.fn().mockResolvedValue(undefined),
      span: jest.fn(
        async (
          _name: string,
          _attributes: object,
          operation: () => Promise<unknown>,
        ): Promise<unknown> => operation(),
      ),
      start: telemetryStart,
      updateReadinessMetrics: jest.fn(),
      withContext: jest.fn((_context: object, operation: () => unknown) => operation()),
    } as unknown as TelemetryRuntime;
    const runtime = new WorkerRuntimeService(
      createConfig(),
      prisma,
      publisher,
      consumer,
      createSettlementConsumer(),
      createReconciliationProcessor(),
      relay,
      delivery,
      health,
      signals,
      { record: jest.fn() } as unknown as WebhookDeliverySignalService,
      telemetry,
    );

    await runtime.onApplicationBootstrap();

    expect(health.getReadiness().status).toBe('ready');
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(ensureConsumerReady).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ event: 'outbox.relay.started' });
    expect(telemetryStart).toHaveBeenCalledTimes(1);
    runtime.beforeApplicationShutdown('SIGTERM');
    expect(telemetryBeginShutdown).toHaveBeenCalledTimes(1);
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
    const consumer = {
      beginShutdown: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(true),
      isReady: jest.fn().mockReturnValue(true),
    } as unknown as RabbitMqPaymentCreatedConsumer;
    const runOnce = jest.fn().mockReturnValue(activeCycle);
    const relay = { runOnce } as unknown as OutboxRelayService;
    const delivery = createDelivery();
    const runtime = new WorkerRuntimeService(
      createConfig(),
      prisma,
      publisher,
      consumer,
      createSettlementConsumer(),
      createReconciliationProcessor(),
      relay,
      delivery,
      new WorkerHealthService(),
      { record: jest.fn() } as unknown as OutboxRelaySignalService,
      { record: jest.fn() } as unknown as WebhookDeliverySignalService,
      createTelemetry(),
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

  it('caps Webhook delivery at batch four and never overlaps dispatcher cycles', async () => {
    jest.useFakeTimers();
    let releaseDelivery:
      | ((value: {
          claimed: number;
          deadLettered: number;
          delivered: number;
          dispatcherReady: boolean;
          ownershipLost: number;
          recoveredUnknown: number;
          retrying: number;
        }) => void)
      | undefined;
    const activeDelivery = new Promise<{
      claimed: number;
      deadLettered: number;
      delivered: number;
      dispatcherReady: boolean;
      ownershipLost: number;
      recoveredUnknown: number;
      retrying: number;
    }>((resolve) => {
      releaseDelivery = resolve;
    });
    const prisma = {
      checkConnectivity: jest.fn().mockResolvedValue(true),
    } as unknown as PrismaDatabase;
    const publisher = {
      ensureReady: jest.fn().mockResolvedValue(true),
      isReady: jest.fn().mockReturnValue(true),
    } as unknown as RabbitMqOutboxPublisher;
    const consumer = {
      beginShutdown: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(true),
      isReady: jest.fn().mockReturnValue(true),
    } as unknown as RabbitMqPaymentCreatedConsumer;
    const relay = {
      runOnce: jest.fn().mockResolvedValue({
        claimed: 0,
        ownershipLost: 0,
        published: 0,
        publisherReady: true,
        retryScheduled: 0,
      }),
    } as unknown as OutboxRelayService;
    const runOnce = jest.fn().mockReturnValue(activeDelivery);
    const delivery = createDelivery({ runOnce });
    const runtime = new WorkerRuntimeService(
      createConfig(),
      prisma,
      publisher,
      consumer,
      createSettlementConsumer(),
      createReconciliationProcessor(),
      relay,
      delivery,
      new WorkerHealthService(),
      { record: jest.fn() } as unknown as OutboxRelaySignalService,
      { record: jest.fn() } as unknown as WebhookDeliverySignalService,
      createTelemetry(),
    );

    await runtime.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledWith(expect.stringMatching(/^webhook_/u), 4);

    releaseDelivery?.({
      claimed: 0,
      deadLettered: 0,
      delivered: 0,
      dispatcherReady: true,
      ownershipLost: 0,
      recoveredUnknown: 0,
      retrying: 0,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(500);
    expect(runOnce).toHaveBeenCalledTimes(2);

    runtime.beforeApplicationShutdown('SIGTERM');
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
    const consumer = {
      beginShutdown: jest.fn(),
      close: jest.fn(() => {
        closeOrder.push('consumer');
        return Promise.resolve(true);
      }),
    } as unknown as RabbitMqPaymentCreatedConsumer;
    const relay = {} as OutboxRelayService;
    const beginDeliveryShutdown = jest.fn();
    const abortActive = jest.fn();
    const delivery = createDelivery({ abortActive, beginShutdown: beginDeliveryShutdown });
    const runtime = new WorkerRuntimeService(
      createConfig(),
      prisma,
      publisher,
      consumer,
      createSettlementConsumer(),
      createReconciliationProcessor(),
      relay,
      delivery,
      new WorkerHealthService(),
      { record: jest.fn() } as unknown as OutboxRelaySignalService,
      { record: jest.fn() } as unknown as WebhookDeliverySignalService,
      createTelemetry(),
    );

    runtime.beforeApplicationShutdown('SIGTERM');
    await runtime.onApplicationShutdown();

    expect(beginDeliveryShutdown).toHaveBeenCalledTimes(1);
    expect(abortActive).not.toHaveBeenCalled();
    expect(closeOrder).toEqual(['consumer', 'publisher', 'prisma']);
  });
});
