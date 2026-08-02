import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import {
  InboxService,
  OUTBOX_RABBITMQ_TOPOLOGY,
  PrismaInboxRepository,
  RabbitMqOutboxPublisher,
  RabbitMqPaymentCreatedConsumer,
  type ClaimedOutboxEvent,
  type PaymentCreatedMessageHandler,
} from '@settleflow/eventing';
import { MonotonicUlidGenerator, PrismaDatabase } from '@settleflow/infrastructure';
import {
  PaymentCreatedWebhookProjectionService,
  PrismaWebhookProjectionRepository,
} from '@settleflow/webhooks';

import { provisionTestRuntimeRole, testRuntimeDatabaseUrl } from './support/postgres-runtime-role';

const POSTGRES_IMAGE =
  'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
const RABBITMQ_IMAGE =
  'rabbitmq:4.3.4-management@sha256:4e628d3cbc61ef45c5918e19bb9844874410d96d4ced897ced7d072d63ad555c';
const RABBITMQ_USER = 'settleflow_projection_test';
const RABBITMQ_PASSWORD = 'settleflow_projection_test_only';

jest.setTimeout(120_000);

function deployMigrations(databaseUrl: string): Promise<void> {
  const prismaCli = resolve(process.cwd(), 'node_modules/prisma/build/index.js');
  const config = resolve(process.cwd(), 'prisma.config.mts');
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--config', config],
      {
        cwd: process.cwd(),
        env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl },
        timeout: 120_000,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (error !== null) {
          rejectCommand(new Error(`Prisma migrate deploy failed: ${stderr}`, { cause: error }));
          return;
        }
        resolveCommand();
      },
    );
  });
}

interface QueueDetails {
  readonly messages: number;
  readonly messages_ready: number;
  readonly messages_unacknowledged: number;
}

describe('payment.created.v1 webhook projection consumer with real dependencies', () => {
  let consumer: RabbitMqPaymentCreatedConsumer | undefined;
  let ownerDatabase: PrismaDatabase | undefined;
  let postgres: StartedPostgreSqlContainer | undefined;
  let publisher: RabbitMqOutboxPublisher | undefined;
  let rabbitmq: StartedRabbitMQContainer | undefined;
  let rabbitmqUrl = '';
  let managementBaseUrl = '';
  let runtimeDatabase: PrismaDatabase | undefined;

  beforeAll(async () => {
    [postgres, rabbitmq] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('settleflow_projection_test')
        .withUsername('settleflow_projection_test')
        .withPassword('settleflow_projection_test_only')
        .start(),
      new RabbitMQContainer(RABBITMQ_IMAGE)
        .withEnvironment({
          RABBITMQ_DEFAULT_PASS: RABBITMQ_PASSWORD,
          RABBITMQ_DEFAULT_USER: RABBITMQ_USER,
        })
        .withStartupTimeout(120_000)
        .start(),
    ]);
    await provisionTestRuntimeRole(postgres);
    await deployMigrations(postgres.getConnectionUri());
    ownerDatabase = new PrismaDatabase({
      connectionTimeoutMs: 5_000,
      databaseUrl: postgres.getConnectionUri(),
      maxConnections: 10,
    });
    runtimeDatabase = new PrismaDatabase({
      connectionTimeoutMs: 5_000,
      databaseUrl: testRuntimeDatabaseUrl(postgres),
      maxConnections: 5,
    });
    await Promise.all([ownerDatabase.connect(), runtimeDatabase.connect()]);
    rabbitmqUrl = `amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@${rabbitmq.getHost()}:${rabbitmq.getMappedPort(5672)}`;
    managementBaseUrl = `http://${rabbitmq.getHost()}:${rabbitmq.getMappedPort(15672)}/api`;
    publisher = new RabbitMqOutboxPublisher({
      confirmTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      rabbitmqUrl,
      retryBaseMs: 1_000,
      retryMaxMs: 60_000,
    });
    await expect(publisher.ensureReady()).resolves.toBe(true);
  }, 120_000);

  afterEach(async () => {
    if (consumer !== undefined) {
      await consumer.close();
      consumer = undefined;
    }
  });

  afterAll(async () => {
    await Promise.allSettled([
      consumer?.close() ?? Promise.resolve(),
      publisher?.close() ?? Promise.resolve(),
      runtimeDatabase?.close() ?? Promise.resolve(),
      ownerDatabase?.close() ?? Promise.resolve(),
    ]);
    await Promise.allSettled([
      rabbitmq?.stop() ?? Promise.resolve(),
      postgres?.stop() ?? Promise.resolve(),
    ]);
  }, 120_000);

  function owner(): PrismaDatabase {
    if (ownerDatabase === undefined) {
      throw new Error('Owner database is unavailable');
    }
    return ownerDatabase;
  }

  function runtime(): PrismaDatabase {
    if (runtimeDatabase === undefined) {
      throw new Error('Runtime database is unavailable');
    }
    return runtimeDatabase;
  }

  function createProjectionHandler(): PaymentCreatedWebhookProjectionService {
    return new PaymentCreatedWebhookProjectionService(
      new InboxService(
        new PrismaInboxRepository(runtime(), {
          lockTimeoutMs: 2_000,
          statementTimeoutMs: 8_000,
          transactionTimeoutMs: 9_000,
        }),
        { retryAttempts: 3 },
      ),
      new PrismaWebhookProjectionRepository(),
      new MonotonicUlidGenerator(),
    );
  }

  function createConsumer(handler: PaymentCreatedMessageHandler): RabbitMqPaymentCreatedConsumer {
    consumer = new RabbitMqPaymentCreatedConsumer(handler, {
      bodyLimitBytes: 16_384,
      connectionTimeoutMs: 5_000,
      prefetch: 2,
      rabbitmqUrl,
      random: (): number => 0.5,
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 60_000,
      shutdownTimeoutMs: 10_000,
    });
    return consumer;
  }

  function createEvent(merchantId: string, eventId: string, paymentId: string): ClaimedOutboxEvent {
    const occurredAt = new Date(Date.now() - 5_000);
    return {
      aggregateId: paymentId,
      aggregateType: 'payment_intent',
      attemptCount: 1,
      eventId,
      eventType: 'payment.created.v1',
      id: '99999999-9999-4999-8999-999999999999',
      merchantId,
      occurredAt,
      payload: {
        amountMinor: 75_000,
        currency: 'ETB',
        eventId,
        eventType: 'payment.created.v1',
        merchantId,
        occurredAt: occurredAt.toISOString(),
        paymentId,
        requestId: `req_${eventId.slice(4, 14)}`,
        status: 'CREATED',
      },
      requestId: `req_${eventId.slice(4, 14)}`,
    };
  }

  function createLifecycleEvent(
    merchantId: string,
    eventId: string,
    paymentId: string,
    eventType: 'payment.captured.v1' | 'payment.refunded.v1',
  ): ClaimedOutboxEvent {
    const occurredAt = new Date(Date.now() - 5_000);
    const common = {
      eventId,
      eventType,
      occurredAt: occurredAt.toISOString(),
      requestId: `req_${eventId.slice(4, 14)}`,
      merchantId,
      paymentId,
    };
    return {
      aggregateId: paymentId,
      aggregateType: 'payment_intent',
      attemptCount: 1,
      eventId,
      eventType,
      id: crypto.randomUUID(),
      merchantId,
      occurredAt,
      payload:
        eventType === 'payment.captured.v1'
          ? {
              ...common,
              capturedAmountMinor: 75_000,
              currency: 'ETB',
              availableOn: occurredAt.toISOString(),
              ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            }
          : {
              ...common,
              refundId: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
              amountMinor: 25_000,
              currency: 'ETB',
              cumulativeRefundedAmountMinor: 25_000,
              ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAW',
            },
      requestId: common.requestId,
    };
  }

  async function managementRequest(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set(
      'authorization',
      `Basic ${Buffer.from(`${RABBITMQ_USER}:${RABBITMQ_PASSWORD}`).toString('base64')}`,
    );
    if (init?.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    const response = await fetch(`${managementBaseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw new Error(`RabbitMQ management request failed with ${response.status}`);
    }
    return response;
  }

  async function queueDetails(queue: string): Promise<QueueDetails> {
    const path = `/queues/${encodeURIComponent('/')}/${encodeURIComponent(queue)}`;
    return (await (await managementRequest(path)).json()) as QueueDetails;
  }

  async function waitFor(
    predicate: () => Promise<boolean>,
    description: string,
    timeoutMs = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  it('commits a tenant-safe projection before ack and deduplicates a broker redelivery', async () => {
    const merchant = await owner()
      .getClient()
      .merchant.create({ data: { code: 'projection-a' } });
    const otherMerchant = await owner()
      .getClient()
      .merchant.create({ data: { code: 'projection-other' } });
    const currentSecret = {
      algorithm: 'aes-256-gcm',
      authenticationTag: Uint8Array.from(Buffer.alloc(16, 1)),
      ciphertext: Uint8Array.from(Buffer.alloc(49, 2)),
      encryptionKeyId: 'projection-test-v1',
      lifecycle: 'CURRENT' as const,
      nonce: Uint8Array.from(Buffer.alloc(12, 3)),
      secretVersion: 1,
    };
    const endpoints = await Promise.all([
      owner()
        .getClient()
        .webhookEndpoint.create({
          data: {
            merchantId: merchant.id,
            normalizedUrl: 'https://eligible.example.com/',
            publicId: 'whe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            status: 'ACTIVE',
            secrets: { create: currentSecret },
            subscriptions: { create: { eventType: 'payment.created.v1' } },
          },
        }),
      owner()
        .getClient()
        .webhookEndpoint.create({
          data: {
            merchantId: merchant.id,
            normalizedUrl: 'https://inactive.example.com/',
            publicId: 'whe_01ARZ3NDEKTSV4RRFFQ69G5FAW',
            status: 'INACTIVE',
            secrets: { create: currentSecret },
            subscriptions: { create: { eventType: 'payment.created.v1' } },
          },
        }),
      owner()
        .getClient()
        .webhookEndpoint.create({
          data: {
            merchantId: otherMerchant.id,
            normalizedUrl: 'https://other.example.com/',
            publicId: 'whe_01ARZ3NDEKTSV4RRFFQ69G5FAX',
            status: 'ACTIVE',
            secrets: { create: currentSecret },
            subscriptions: { create: { eventType: 'payment.created.v1' } },
          },
        }),
    ]);
    const event = createEvent(
      merchant.id,
      'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
    const projection = createProjectionHandler();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler: PaymentCreatedMessageHandler = {
      handle: jest.fn(async (message) => {
        await held;
        return projection.handle(message);
      }),
    };
    const activeConsumer = createConsumer(handler);
    await expect(activeConsumer.ensureReady()).resolves.toBe(true);

    await expect(publisher?.publishBatch([event])).resolves.toEqual([
      { eventId: event.eventId, kind: 'confirmed' },
    ]);
    await waitFor(
      async () =>
        (await queueDetails(OUTBOX_RABBITMQ_TOPOLOGY.queue)).messages_unacknowledged === 1,
      'one unacknowledged projection message',
    );
    expect(await owner().getClient().inboxMessage.count()).toBe(0);
    release?.();

    await waitFor(
      async () => (await owner().getClient().webhookDelivery.count()) === 1,
      'durable webhook projection',
    );
    await waitFor(
      async () => (await queueDetails(OUTBOX_RABBITMQ_TOPOLOGY.queue)).messages === 0,
      'queue acknowledgement',
    );
    expect(await owner().getClient().inboxMessage.count()).toBe(1);
    expect(await owner().getClient().webhookEventProjection.count()).toBe(1);
    const deliveries = await owner().getClient().webhookDelivery.findMany();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      attemptCount: 0,
      endpointId: endpoints[0]?.id,
      merchantId: merchant.id,
      nextAttemptAt: deliveries[0]?.createdAt,
      status: 'PENDING',
      updatedAt: deliveries[0]?.createdAt,
    });
    expect(deliveries[0]?.publicId).toMatch(/^whd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);

    await expect(publisher?.publishBatch([event])).resolves.toEqual([
      { eventId: event.eventId, kind: 'confirmed' },
    ]);
    await waitFor(
      async () => (await queueDetails(OUTBOX_RABBITMQ_TOPOLOGY.queue)).messages === 0,
      'duplicate acknowledgement',
    );
    expect(await owner().getClient().inboxMessage.count()).toBe(1);
    expect(await owner().getClient().webhookEventProjection.count()).toBe(1);
    expect(await owner().getClient().webhookDelivery.count()).toBe(1);

    const merchantWithoutEndpoints = await owner()
      .getClient()
      .merchant.create({ data: { code: 'projection-zero' } });
    const zeroFanoutEvent = createEvent(
      merchantWithoutEndpoints.id,
      'evt_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      'pi_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
    );
    await expect(publisher?.publishBatch([zeroFanoutEvent])).resolves.toEqual([
      { eventId: zeroFanoutEvent.eventId, kind: 'confirmed' },
    ]);
    await waitFor(
      async () => (await owner().getClient().webhookEventProjection.count()) === 2,
      'durable zero-endpoint marker',
    );
    expect(await owner().getClient().inboxMessage.count()).toBe(2);
    expect(await owner().getClient().webhookDelivery.count()).toBe(1);
  });

  it('routes an unsupported message immediately to the existing DLQ', async () => {
    const inboxCountBefore = await owner().getClient().inboxMessage.count();
    const activeConsumer = createConsumer(createProjectionHandler());
    await expect(activeConsumer.ensureReady()).resolves.toBe(true);
    const publish = await managementRequest(
      `/exchanges/${encodeURIComponent('/')}/${encodeURIComponent(OUTBOX_RABBITMQ_TOPOLOGY.exchange)}/publish`,
      {
        body: JSON.stringify({
          payload: '{"eventType":"unsupported"}',
          payload_encoding: 'string',
          properties: {
            content_encoding: 'utf-8',
            content_type: 'application/json',
            delivery_mode: 2,
            message_id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FB0',
            type: 'unsupported.v1',
          },
          routing_key: OUTBOX_RABBITMQ_TOPOLOGY.routingKey,
        }),
        method: 'POST',
      },
    );
    await expect(publish.json()).resolves.toEqual({ routed: true });

    await waitFor(
      async () =>
        (await queueDetails(OUTBOX_RABBITMQ_TOPOLOGY.deadLetterQueue)).messages_ready === 1,
      'poison message in the DLQ',
    );
    expect(await owner().getClient().inboxMessage.count()).toBe(inboxCountBefore);
  });

  it('projects exact captured/refunded bytes only to endpoints subscribed at processing time', async () => {
    const merchant = await owner()
      .getClient()
      .merchant.create({ data: { code: 'projection-lifecycle' } });
    const endpoint = await owner()
      .getClient()
      .webhookEndpoint.create({
        data: {
          merchantId: merchant.id,
          normalizedUrl: 'https://lifecycle.example.com/',
          publicId: 'whe_01ARZ3NDEKTSV4RRFFQ69G5FB1',
          status: 'ACTIVE',
          secrets: {
            create: {
              algorithm: 'aes-256-gcm',
              authenticationTag: Uint8Array.from(Buffer.alloc(16, 1)),
              ciphertext: Uint8Array.from(Buffer.alloc(49, 2)),
              encryptionKeyId: 'projection-test-v1',
              lifecycle: 'CURRENT',
              nonce: Uint8Array.from(Buffer.alloc(12, 3)),
              secretVersion: 1,
            },
          },
          subscriptions: {
            createMany: {
              data: [{ eventType: 'payment.captured.v1' }, { eventType: 'payment.refunded.v1' }],
            },
          },
        },
      });
    const capture = createLifecycleEvent(
      merchant.id,
      'evt_01ARZ3NDEKTSV4RRFFQ69G5FB1',
      'pi_01ARZ3NDEKTSV4RRFFQ69G5FB1',
      'payment.captured.v1',
    );
    const refund = createLifecycleEvent(
      merchant.id,
      'evt_01ARZ3NDEKTSV4RRFFQ69G5FB2',
      'pi_01ARZ3NDEKTSV4RRFFQ69G5FB1',
      'payment.refunded.v1',
    );
    const activeConsumer = createConsumer(createProjectionHandler());
    await expect(activeConsumer.ensureReady()).resolves.toBe(true);
    await expect(publisher?.publishBatch([capture, refund])).resolves.toEqual([
      { eventId: capture.eventId, kind: 'confirmed' },
      { eventId: refund.eventId, kind: 'confirmed' },
    ]);

    await waitFor(
      async () =>
        (await owner()
          .getClient()
          .webhookDelivery.count({ where: { endpointId: endpoint.id } })) === 2,
      'captured and refunded projections',
    );
    const projections = await owner()
      .getClient()
      .webhookEventProjection.findMany({
        orderBy: { eventType: 'asc' },
        where: { merchantId: merchant.id },
      });
    expect(projections).toHaveLength(2);
    expect(projections.map((projection) => projection.eventType)).toEqual([
      'payment.captured.v1',
      'payment.refunded.v1',
    ]);
    expect(
      Buffer.from(projections[0]!.payloadBytes).equals(
        Buffer.from(JSON.stringify(capture.payload)),
      ),
    ).toBe(true);
    expect(
      Buffer.from(projections[1]!.payloadBytes).equals(Buffer.from(JSON.stringify(refund.payload))),
    ).toBe(true);
    expect(projections[0]).toMatchObject({
      amountMinor: 75_000n,
      availableOn: capture.occurredAt,
      ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      paymentStatus: null,
      refundId: null,
    });
    expect(projections[1]).toMatchObject({
      amountMinor: 25_000n,
      cumulativeRefundedAmountMinor: 25_000n,
      ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      paymentStatus: null,
      refundId: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
  });

  it('allows the runtime role to append but not mutate projection evidence', async () => {
    await expect(
      runtime().getClient().$executeRawUnsafe('UPDATE "inbox_messages" SET "completed_at" = now()'),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      runtime().getClient().$executeRawUnsafe('DELETE FROM "webhook_event_projections"'),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      runtime().getClient().$executeRawUnsafe('TRUNCATE TABLE "webhook_deliveries"'),
    ).rejects.toThrow(/permission denied/iu);
  });
});
