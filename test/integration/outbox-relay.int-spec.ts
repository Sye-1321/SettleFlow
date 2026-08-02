import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import {
  EventingService,
  OUTBOX_RABBITMQ_TOPOLOGY,
  OutboxRelayService,
  PrismaOutboxRelayRepository,
  PrismaOutboxRepository,
  RabbitMqOutboxPublisher,
} from '@settleflow/eventing';
import { MonotonicUlidGenerator, PrismaDatabase } from '@settleflow/infrastructure';

import { WorkerHealthService } from '../../apps/worker/src/health/worker-health.service';
import { provisionTestRuntimeRole, testRuntimeDatabaseUrl } from './support/postgres-runtime-role';

const POSTGRES_IMAGE =
  'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
const RABBITMQ_IMAGE =
  'rabbitmq:4.3.4-management@sha256:4e628d3cbc61ef45c5918e19bb9844874410d96d4ced897ced7d072d63ad555c';
const RABBITMQ_USER = 'settleflow_relay_test';
const RABBITMQ_PASSWORD = 'settleflow_relay_test_only';

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

interface ManagementMessage {
  readonly payload: string;
  readonly properties: {
    readonly app_id?: string;
    readonly correlation_id?: string;
    readonly headers?: Readonly<Record<string, unknown>>;
    readonly message_id?: string;
    readonly type?: string;
  };
  readonly routing_key: string;
}

interface QueueDetails {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly durable: boolean;
  readonly name: string;
}

describe('transactional outbox relay with real PostgreSQL and RabbitMQ', () => {
  let database: PrismaDatabase | undefined;
  let postgres: StartedPostgreSqlContainer | undefined;
  let rabbitmq: StartedRabbitMQContainer | undefined;
  let merchantId = '';
  let fixtureSequence = 0;
  let managementBaseUrl = '';
  let rabbitmqUrl = '';
  const identifiers = new MonotonicUlidGenerator();
  const publishers = new Set<RabbitMqOutboxPublisher>();

  beforeAll(async () => {
    [postgres, rabbitmq] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('settleflow_relay_test')
        .withUsername('settleflow_relay_test')
        .withPassword('settleflow_relay_test_only')
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
    database = new PrismaDatabase({
      connectionTimeoutMs: 5_000,
      databaseUrl: postgres.getConnectionUri(),
      maxConnections: 10,
    });
    await database.connect();
    const merchant = await database.getClient().merchant.create({
      data: { code: 'outbox-relay-test' },
    });
    merchantId = merchant.id;
    rabbitmqUrl = `amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@${rabbitmq.getHost()}:${rabbitmq.getMappedPort(5672)}`;
    managementBaseUrl = `http://${rabbitmq.getHost()}:${rabbitmq.getMappedPort(15672)}/api`;

    const topologyPublisher = createPublisher();
    await expect(topologyPublisher.ensureReady()).resolves.toBe(true);
    await topologyPublisher.close();
    publishers.delete(topologyPublisher);
  }, 120_000);

  beforeEach(async () => {
    await getDatabase()
      .getClient()
      .outboxEvent.deleteMany({
        where: { publishedAt: null },
      });
    await purgeQueue(OUTBOX_RABBITMQ_TOPOLOGY.queue);
    await purgeQueue(OUTBOX_RABBITMQ_TOPOLOGY.deadLetterQueue);
  });

  afterAll(async () => {
    await Promise.allSettled([...publishers].map((publisher) => publisher.close()));
    if (database !== undefined) {
      await database.close();
    }
    const stops: Promise<unknown>[] = [];
    if (rabbitmq !== undefined) {
      stops.push(rabbitmq.stop());
    }
    if (postgres !== undefined) {
      stops.push(postgres.stop());
    }
    await Promise.allSettled(stops);
  }, 120_000);

  function getDatabase(): PrismaDatabase {
    if (database === undefined) {
      throw new Error('Test database is unavailable');
    }
    return database;
  }

  function only<T>(items: readonly T[]): T {
    const item = items[0];
    if (item === undefined) {
      throw new Error('Expected one test fixture');
    }
    return item;
  }

  function createPublisher(url = rabbitmqUrl): RabbitMqOutboxPublisher {
    const publisher = new RabbitMqOutboxPublisher({
      confirmTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      rabbitmqUrl: url,
      random: (): number => 0.5,
      retryBaseMs: 1_000,
      retryMaxMs: 60_000,
    });
    publishers.add(publisher);
    return publisher;
  }

  function createRepository(leaseDurationMs = 30_000): PrismaOutboxRelayRepository {
    return new PrismaOutboxRelayRepository(getDatabase(), {
      leaseDurationMs,
      transactionTimeoutMs: 5_000,
    });
  }

  function createRelay(
    repository: PrismaOutboxRelayRepository,
    publisher: RabbitMqOutboxPublisher,
  ): OutboxRelayService {
    return new OutboxRelayService(repository, publisher, {
      batchSize: 50,
      random: () => 0.5,
      retryBaseMs: 1_000,
      retryMaxMs: 60_000,
    });
  }

  async function createPendingEvents(count: number): Promise<readonly string[]> {
    const client = getDatabase().getClient();
    const eventing = new EventingService(new PrismaOutboxRepository(), identifiers);
    const eventIds: string[] = [];

    await client.$transaction(async (transaction) => {
      for (let index = 0; index < count; index += 1) {
        fixtureSequence += 1;
        const occurredAt = new Date(Date.now() - 5_000);
        const paymentId = `pi_${identifiers.generate(occurredAt.getTime())}`;
        await transaction.paymentIntent.create({
          data: {
            amountMinor: BigInt(1_000 + fixtureSequence),
            captureMethod: 'MANUAL',
            currency: fixtureSequence % 2 === 0 ? 'ETB' : 'USD',
            externalRef: `relay-${fixtureSequence}`,
            merchantId,
            publicId: paymentId,
          },
        });
        const event = eventing.createPaymentCreatedEvent(
          {
            amountMinor: 1_000 + fixtureSequence,
            currency: fixtureSequence % 2 === 0 ? 'ETB' : 'USD',
            merchantId,
            paymentId,
            requestId: `req_relay_${fixtureSequence}`,
          },
          occurredAt,
        );
        await eventing.persistPaymentCreated(transaction, event);
        eventIds.push(event.eventId);
      }
    });

    // Prisma materializes @default(now()) from the application clock. Make the
    // synthetic fixtures explicitly due so direct claim assertions are not
    // sensitive to host/container clock skew; production polls every 500 ms.
    await client.outboxEvent.updateMany({
      data: { availableAt: new Date(Date.now() - 5_000) },
      where: { eventId: { in: eventIds } },
    });

    return eventIds;
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
    const response = await fetch(`${managementBaseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new Error(`RabbitMQ management request failed with ${response.status}`);
    }
    return response;
  }

  function queuePath(queue: string): string {
    return `/queues/${encodeURIComponent('/')}/${encodeURIComponent(queue)}`;
  }

  async function purgeQueue(queue: string): Promise<void> {
    await managementRequest(`${queuePath(queue)}/contents`, { method: 'DELETE' });
  }

  async function getMessages(
    queue: string,
    count: number,
    ackmode: 'ack_requeue_false' | 'reject_requeue_false' = 'ack_requeue_false',
  ): Promise<readonly ManagementMessage[]> {
    const response = await managementRequest(`${queuePath(queue)}/get`, {
      body: JSON.stringify({ ackmode, count, encoding: 'auto', truncate: 50_000 }),
      method: 'POST',
    });
    return (await response.json()) as readonly ManagementMessage[];
  }

  async function waitForMessages(
    queue: string,
    count: number,
    ackmode: 'ack_requeue_false' | 'reject_requeue_false' = 'ack_requeue_false',
  ): Promise<readonly ManagementMessage[]> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const messages = await getMessages(queue, count, ackmode);
      if (messages.length > 0) {
        return messages;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    return [];
  }

  it('declares the approved quorum topology and publishes exact consumer-ready metadata', async () => {
    const eventId = only(await createPendingEvents(1));
    const publisher = createPublisher();
    const result = await createRelay(createRepository(), publisher).runOnce('worker_topology');

    expect(result).toMatchObject({ claimed: 1, published: 1, retryScheduled: 0 });
    const queueResponse = await managementRequest(queuePath(OUTBOX_RABBITMQ_TOPOLOGY.queue));
    const queue = (await queueResponse.json()) as QueueDetails;
    expect(queue).toMatchObject({ durable: true, name: OUTBOX_RABBITMQ_TOPOLOGY.queue });
    expect(queue.arguments).toMatchObject({
      'x-dead-letter-exchange': OUTBOX_RABBITMQ_TOPOLOGY.deadLetterExchange,
      'x-dead-letter-routing-key': OUTBOX_RABBITMQ_TOPOLOGY.deadLetterRoutingKey,
      'x-queue-type': 'quorum',
    });

    const [message] = await waitForMessages(
      OUTBOX_RABBITMQ_TOPOLOGY.queue,
      1,
      'reject_requeue_false',
    );
    expect(message?.routing_key).toBe('payment.created.v1');
    expect(message?.properties).toMatchObject({
      app_id: 'settleflow-worker',
      message_id: eventId,
      type: 'payment.created.v1',
    });
    expect(message?.properties.correlation_id).toMatch(/^req_relay_/u);
    expect(message?.properties.headers).toMatchObject({
      'x-settleflow-aggregate-type': 'payment_intent',
      'x-settleflow-merchant-id': merchantId,
      'x-settleflow-publish-attempt': 1,
      'x-settleflow-schema-version': 1,
    });
    expect(JSON.parse(message?.payload ?? '{}')).toMatchObject({
      eventId,
      eventType: 'payment.created.v1',
      merchantId,
      status: 'CREATED',
    });

    const [deadLetter] = await waitForMessages(OUTBOX_RABBITMQ_TOPOLOGY.deadLetterQueue, 1);
    expect(deadLetter?.properties.message_id).toBe(eventId);
  });

  it('starts ready on the real publisher topology and closes worker resources gracefully', async () => {
    process.env['DATABASE_URL'] =
      postgres === undefined ? undefined : testRuntimeDatabaseUrl(postgres);
    process.env['DEPENDENCY_READINESS_TIMEOUT_MS'] = '5000';
    process.env['NODE_ENV'] = 'test';
    process.env['OUTBOX_RELAY_BATCH_SIZE'] = '50';
    process.env['OUTBOX_RELAY_CONFIRM_TIMEOUT_MS'] = '5000';
    process.env['OUTBOX_RELAY_LEASE_MS'] = '30000';
    process.env['OUTBOX_RELAY_POLL_INTERVAL_MS'] = '500';
    process.env['OUTBOX_RELAY_RETRY_BASE_MS'] = '1000';
    process.env['OUTBOX_RELAY_RETRY_MAX_MS'] = '60000';
    process.env['OUTBOX_RELAY_SHUTDOWN_TIMEOUT_MS'] = '10000';
    process.env['RABBITMQ_URL'] = rabbitmqUrl;
    process.env['WEBHOOK_KEYRING_PROVIDER'] = 'local';
    process.env['WEBHOOK_LOCAL_ACTIVE_KEY_ID'] = 'local-v1';
    process.env['WEBHOOK_LOCAL_KEYS_JSON'] = JSON.stringify({
      'local-v1': Buffer.alloc(32, 7).toString('base64url'),
    });
    process.env['WORKER_HEARTBEAT_INTERVAL_MS'] = '30000';
    const { WorkerModule } = await import('../../apps/worker/src/worker.module.js');
    const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    const workerDatabase = app.get(PrismaDatabase);
    const health = app.get(WorkerHealthService);

    expect(health.getReadiness().status).toBe('ready');
    await app.close();
    await expect(workerDatabase.checkConnectivity()).resolves.toBe(false);
    expect(health.getReadiness().status).toBe('not_ready');

    const eventId = only(await createPendingEvents(1));
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    const untouched = await getDatabase().getClient().outboxEvent.findUniqueOrThrow({
      where: { eventId },
    });
    expect(untouched).toMatchObject({ attemptCount: 0, lockedBy: null, publishedAt: null });
  });

  it('lets competing workers claim disjoint batches and publishes a healthy backlog under 10 seconds', async () => {
    const eventIds = await createPendingEvents(60);
    const publisherOne = createPublisher();
    const publisherTwo = createPublisher();
    const startedAt = performance.now();
    const [first, second] = await Promise.all([
      createRelay(createRepository(), publisherOne).runOnce('worker_competing_one'),
      createRelay(createRepository(), publisherTwo).runOnce('worker_competing_two'),
    ]);
    const elapsedMs = performance.now() - startedAt;

    expect(first.claimed + second.claimed).toBe(60);
    expect(first.published + second.published).toBe(60);
    expect(first.ownershipLost + second.ownershipLost).toBe(0);
    expect(elapsedMs).toBeLessThan(10_000);
    const rows = await getDatabase()
      .getClient()
      .outboxEvent.findMany({
        where: { eventId: { in: [...eventIds] } },
      });
    expect(rows).toHaveLength(60);
    expect(rows.every((row) => row.publishedAt !== null && row.attemptCount === 1)).toBe(true);
    const publishLags = rows
      .map(
        (row) => (row.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY) - row.createdAt.getTime(),
      )
      .sort((left, right) => left - right);
    const p95Index = Math.ceil(publishLags.length * 0.95) - 1;
    expect(publishLags[p95Index]).toBeLessThan(10_000);

    const messages = await waitForMessages(OUTBOX_RABBITMQ_TOPOLOGY.queue, 100);
    expect(new Set(messages.map((message) => message.properties.message_id))).toEqual(
      new Set(eventIds),
    );
  });

  it('does not claim while RabbitMQ is unavailable and recovers without mutating the event', async () => {
    const eventId = only(await createPendingEvents(1));
    const unavailablePublisher = createPublisher(
      'amqp://settleflow:unavailable@127.0.0.1:1/unavailable',
    );
    const repository = createRepository();
    const unavailableResult = await createRelay(repository, unavailablePublisher).runOnce(
      'worker_outage',
    );
    const untouched = await getDatabase().getClient().outboxEvent.findUniqueOrThrow({
      where: { eventId },
    });

    expect(unavailableResult).toMatchObject({ claimed: 0, publisherReady: false });
    expect(untouched).toMatchObject({ attemptCount: 0, lockedBy: null, publishedAt: null });

    const recovered = await createRelay(repository, createPublisher()).runOnce('worker_recovered');
    expect(recovered).toMatchObject({ claimed: 1, published: 1 });
    const message = await waitForMessages(OUTBOX_RABBITMQ_TOPOLOGY.queue, 1);
    expect(message[0]?.properties.message_id).toBe(eventId);
  });

  it('reclaims an expired lease and exposes the intentional duplicate with the same message ID', async () => {
    const eventId = only(await createPendingEvents(1));
    const crashedRepository = createRepository();
    const [claimed] = await crashedRepository.claimPending({
      batchSize: 50,
      workerId: 'worker_crashed',
    });
    if (claimed === undefined) {
      throw new Error('Expected a claimed outbox event');
    }
    const crashedPublisher = createPublisher();
    await expect(crashedPublisher.publishBatch([claimed])).resolves.toEqual([
      { eventId, kind: 'confirmed' },
    ]);

    const expiredAt = new Date(Date.now() - 1_000);
    await getDatabase()
      .getClient()
      .outboxEvent.update({
        data: {
          leaseExpiresAt: expiredAt,
          lockedAt: new Date(expiredAt.getTime() - 30_000),
        },
        where: { eventId },
      });
    const recovery = await createRelay(createRepository(), createPublisher()).runOnce(
      'worker_lease_recovery',
    );
    expect(recovery).toMatchObject({ claimed: 1, published: 1 });
    const row = await getDatabase().getClient().outboxEvent.findUniqueOrThrow({
      where: { eventId },
    });
    expect(row).toMatchObject({ attemptCount: 2, lockedBy: null });
    expect(row.publishedAt).not.toBeNull();

    const messages = await waitForMessages(OUTBOX_RABBITMQ_TOPOLOGY.queue, 10);
    expect(messages.map((message) => message.properties.message_id)).toEqual([eventId, eventId]);
  });

  it('excludes active leases and refuses finalization by a worker that does not own the row', async () => {
    await createPendingEvents(1);
    const repository = createRepository();
    const [claimed] = await repository.claimPending({ batchSize: 50, workerId: 'worker_owner' });
    if (claimed === undefined) {
      throw new Error('Expected a claimed outbox event');
    }

    await expect(
      repository.claimPending({ batchSize: 50, workerId: 'worker_competitor' }),
    ).resolves.toEqual([]);
    await expect(
      repository.finalize({
        events: [{ eventId: claimed.eventId, id: claimed.id, kind: 'published' }],
        workerId: 'worker_competitor',
      }),
    ).resolves.toEqual({ ownershipLost: 1, updated: 0 });

    await expect(
      repository.finalize({
        events: [
          {
            eventId: claimed.eventId,
            id: claimed.id,
            kind: 'retry',
            retryDelayMs: 0,
          },
        ],
        workerId: 'worker_owner',
      }),
    ).resolves.toEqual({ ownershipLost: 0, updated: 1 });
  });

  it('uses the pending availability index for a representative claim query', async () => {
    const futureEventIds = await createPendingEvents(5);
    await getDatabase()
      .getClient()
      .outboxEvent.updateMany({
        data: { availableAt: new Date(Date.now() + 60_000) },
        where: { eventId: { in: [...futureEventIds] } },
      });
    await createPendingEvents(5);

    const plan = await getDatabase().getClient().$queryRaw<readonly unknown[]>`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT "id"
      FROM "outbox_events"
      WHERE "published_at" IS NULL
        AND "available_at" <= clock_timestamp()
        AND (
          "lease_expires_at" IS NULL
          OR "lease_expires_at" <= clock_timestamp()
        )
      ORDER BY "available_at", "id"
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `;
    const evidence = JSON.stringify(plan);
    expect(evidence).toContain('outbox_events_pending_available_at_idx');
  });

  it('keeps a mandatory-returned event pending and recreates deleted topology safely', async () => {
    const eventId = only(await createPendingEvents(1));
    const publisher = createPublisher();
    await expect(publisher.ensureReady()).resolves.toBe(true);
    await managementRequest(queuePath(OUTBOX_RABBITMQ_TOPOLOGY.queue), { method: 'DELETE' });

    const result = await createRelay(createRepository(), publisher).runOnce('worker_return');
    expect(result).toMatchObject({ claimed: 1, published: 0, retryScheduled: 1 });
    const row = await getDatabase().getClient().outboxEvent.findUniqueOrThrow({
      where: { eventId },
    });
    expect(row).toMatchObject({
      attemptCount: 1,
      lockedAt: null,
      lockedBy: null,
      publishedAt: null,
    });
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());

    await publisher.close();
    publishers.delete(publisher);
    const recoveryPublisher = createPublisher();
    await expect(recoveryPublisher.ensureReady()).resolves.toBe(true);
    const queueResponse = await managementRequest(queuePath(OUTBOX_RABBITMQ_TOPOLOGY.queue));
    expect(queueResponse.status).toBe(200);
  });

  it('refuses to claim against conflicting topology and does not delete it automatically', async () => {
    const eventId = only(await createPendingEvents(1));
    await managementRequest(queuePath(OUTBOX_RABBITMQ_TOPOLOGY.queue), { method: 'DELETE' });
    await managementRequest(queuePath(OUTBOX_RABBITMQ_TOPOLOGY.queue), {
      body: JSON.stringify({ arguments: {}, auto_delete: false, durable: true }),
      method: 'PUT',
    });
    const publisher = createPublisher();

    const result = await createRelay(createRepository(), publisher).runOnce('worker_conflict');
    expect(result).toMatchObject({ claimed: 0, publisherReady: false });
    const row = await getDatabase().getClient().outboxEvent.findUniqueOrThrow({
      where: { eventId },
    });
    expect(row).toMatchObject({ attemptCount: 0, lockedBy: null, publishedAt: null });
    const conflictingQueue = (await (
      await managementRequest(queuePath(OUTBOX_RABBITMQ_TOPOLOGY.queue))
    ).json()) as QueueDetails;
    expect(conflictingQueue.arguments['x-queue-type']).not.toBe('quorum');

    await publisher.close();
    publishers.delete(publisher);
    await managementRequest(queuePath(OUTBOX_RABBITMQ_TOPOLOGY.queue), { method: 'DELETE' });
    const recoveryPublisher = createPublisher();
    await expect(recoveryPublisher.ensureReady()).resolves.toBe(true);
  });
});
