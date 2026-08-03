import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaDatabase } from '@settleflow/infrastructure';
import {
  LocalWebhookKeyring,
  NodeWebhookHttpClient,
  NodeWebhookUrlPolicy,
  PrismaWebhookDeliveryRepository,
  verifyWebhookSignature,
  WebhookDeliveryService,
  WebhookSecretCipher,
} from '@settleflow/webhooks';

import { provisionTestRuntimeRole, testRuntimeDatabaseUrl } from './support/postgres-runtime-role';

const POSTGRES_IMAGE =
  'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';

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

interface ReceivedRequest {
  readonly body: Buffer;
  readonly headers: IncomingHttpHeaders;
  readonly url: string;
}

interface Fixture {
  readonly currentSecret: string;
  readonly deliveryId: string;
  readonly deliveryPublicId: string;
  readonly eventId: string;
  readonly eventPayload: Buffer;
  readonly previousSecret: string | undefined;
}

describe('signed HTTP webhook delivery with real PostgreSQL', () => {
  let endpointOrigin = '';
  let httpServer: Server | undefined;
  let ownerDatabase: PrismaDatabase | undefined;
  let postgres: StartedPostgreSqlContainer | undefined;
  let responseStatus = 204;
  const received: ReceivedRequest[] = [];
  let runtimeDatabase: PrismaDatabase | undefined;
  let sequence = 0;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('settleflow_webhook_delivery_test')
      .withUsername('settleflow_webhook_delivery_test')
      .withPassword('settleflow_webhook_delivery_test_only')
      .start();
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
      maxConnections: 10,
    });
    await Promise.all([ownerDatabase.connect(), runtimeDatabase.connect()]);

    httpServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          body: Buffer.concat(chunks),
          headers: request.headers,
          url: request.url ?? '',
        });
        response.statusCode = responseStatus;
        response.end('synthetic response');
      });
    });
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('HTTP test server failed');
    endpointOrigin = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    if (httpServer !== undefined) {
      httpServer.close();
      await once(httpServer, 'close');
    }
    await Promise.allSettled([
      runtimeDatabase?.close() ?? Promise.resolve(),
      ownerDatabase?.close() ?? Promise.resolve(),
    ]);
    await postgres?.stop();
  }, 120_000);

  function owner(): PrismaDatabase {
    if (ownerDatabase === undefined) throw new Error('Owner database is unavailable');
    return ownerDatabase;
  }

  function runtime(): PrismaDatabase {
    if (runtimeDatabase === undefined) throw new Error('Runtime database is unavailable');
    return runtimeDatabase;
  }

  function createKeyring(): LocalWebhookKeyring {
    return new LocalWebhookKeyring({
      activeKeyId: 'integration-v1',
      keysJson: JSON.stringify({
        'integration-v1': Buffer.alloc(32, 12).toString('base64url'),
      }),
      nodeEnvironment: 'test',
      provider: 'local',
    });
  }

  function repository(): PrismaWebhookDeliveryRepository {
    return new PrismaWebhookDeliveryRepository(runtime(), {
      leaseDurationMs: 30_000,
      retryAttempts: 3,
      transactionTimeoutMs: 5_000,
    });
  }

  function service(repo = repository()): WebhookDeliveryService {
    const localKeyring = createKeyring();
    return new WebhookDeliveryService(
      repo,
      localKeyring,
      new WebhookSecretCipher(localKeyring),
      new NodeWebhookUrlPolicy({
        developmentAllowedOrigins: [endpointOrigin],
        mode: 'development',
      }),
      new NodeWebhookHttpClient(),
      { random: (): number => 0 },
    );
  }

  async function createFixture(
    options: {
      readonly attemptCount?: number;
      readonly endpointStatus?: 'ACTIVE' | 'INACTIVE';
      readonly previousOverlapMs?: number;
      readonly previousSecret?: boolean;
      readonly status?: 'PENDING' | 'RETRYING';
    } = {},
  ): Promise<Fixture> {
    sequence += 1;
    const suffix = String(sequence).padStart(2, '0');
    const merchantId = randomUUID();
    const endpointId = randomUUID();
    const deliveryId = randomUUID();
    const eventId = `evt_01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`;
    const deliveryPublicId = `whd_01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`;
    const endpointPublicId = `whe_01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`;
    const eventPayload = Buffer.from(
      JSON.stringify({
        amountMinor: 1_000,
        currency: 'ETB',
        eventId,
        eventType: 'payment.created.v1',
        merchantId,
        occurredAt: '2026-08-02T10:00:00.000Z',
        paymentId: `pi_01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`,
        paymentStatus: 'CREATED',
        requestId: `req_webhook_delivery_${suffix}`,
        schemaVersion: 1,
      }),
      'utf8',
    );
    const keyring = createKeyring();
    const cipher = new WebhookSecretCipher(keyring);
    const currentVersion = options.previousSecret === true ? 2 : 1;
    const current = cipher.create({ endpointId, merchantId, secretVersion: currentVersion });
    const previous =
      options.previousSecret === true
        ? cipher.create({ endpointId, merchantId, secretVersion: 1 })
        : undefined;
    const now = new Date();

    await owner()
      .getClient()
      .$transaction(async (transaction) => {
        await transaction.merchant.create({
          data: { code: `webhook-delivery-${suffix}`, id: merchantId },
        });
        await transaction.webhookEndpoint.create({
          data: {
            id: endpointId,
            merchantId,
            normalizedUrl: `${endpointOrigin}/hook/${suffix}`,
            publicId: endpointPublicId,
            status: options.endpointStatus ?? 'ACTIVE',
            subscriptions: {
              create: { createdAt: now, eventType: 'payment.created.v1' },
            },
            secrets: {
              create: [
                {
                  algorithm: current.encrypted.algorithm,
                  authenticationTag: current.encrypted.authenticationTag,
                  ciphertext: current.encrypted.ciphertext,
                  encryptionKeyId: current.encrypted.encryptionKeyId,
                  lifecycle: 'CURRENT',
                  nonce: current.encrypted.nonce,
                  secretVersion: currentVersion,
                },
                ...(previous === undefined
                  ? []
                  : [
                      {
                        algorithm: previous.encrypted.algorithm,
                        authenticationTag: previous.encrypted.authenticationTag,
                        ciphertext: previous.encrypted.ciphertext,
                        encryptionKeyId: previous.encrypted.encryptionKeyId,
                        lifecycle: 'PREVIOUS' as const,
                        nonce: previous.encrypted.nonce,
                        overlapExpiresAt: new Date(
                          now.getTime() + (options.previousOverlapMs ?? 86_400_000),
                        ),
                        secretVersion: 1,
                      },
                    ]),
              ],
            },
          },
        });
        await transaction.webhookEventProjection.create({
          data: {
            aggregateId: `pi_01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`,
            aggregateType: 'payment_intent',
            amountMinor: 1_000n,
            currency: 'ETB',
            eventId,
            eventType: 'payment.created.v1',
            merchantId,
            occurredAt: new Date('2026-08-02T10:00:00.000Z'),
            payloadBytes: eventPayload,
            payloadSha256: Buffer.alloc(32, sequence),
            paymentId: `pi_01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`,
            paymentStatus: 'CREATED',
            projectedAt: now,
            requestId: `req_webhook_delivery_${suffix}`,
            schemaVersion: 1,
          },
        });
        await transaction.webhookDelivery.create({
          data: {
            attemptCount: options.attemptCount ?? 0,
            createdAt: now,
            endpointId,
            eventId,
            id: deliveryId,
            merchantId,
            nextAttemptAt: new Date(now.getTime() - 60_000),
            publicId: deliveryPublicId,
            status: options.status ?? 'PENDING',
            updatedAt: now,
          },
        });
      });

    return {
      currentSecret: current.plaintext,
      deliveryId,
      deliveryPublicId,
      eventId,
      eventPayload,
      previousSecret: previous?.plaintext,
    };
  }

  it('claims with the runtime role and sends exact bytes with ordered overlap signatures', async () => {
    responseStatus = 204;
    const fixture = await createFixture({ previousSecret: true });
    const sender = service();
    await expect(sender.ensureReady()).resolves.toBe(true);
    await expect(sender.runOnce('webhook_integration_one', 4)).resolves.toMatchObject({
      claimed: 1,
      delivered: 1,
      dispatcherReady: true,
    });

    const request = received.at(-1);
    expect(request?.body).toEqual(fixture.eventPayload);
    expect(request?.url).toContain('/hook/');
    expect(request?.headers['settleflow-webhook-id']).toBe(fixture.deliveryPublicId);
    expect(request?.headers['settleflow-event-id']).toBe(fixture.eventId);
    const signatureHeader = request?.headers['settleflow-signature'];
    const timestamp = request?.headers['settleflow-timestamp'];
    if (typeof timestamp !== 'string' || typeof signatureHeader !== 'string') {
      throw new Error('Expected scalar webhook signature headers');
    }
    expect(signatureHeader.split(';')).toHaveLength(2);
    expect(
      verifyWebhookSignature({
        body: fixture.eventPayload,
        deliveryId: fixture.deliveryPublicId,
        nowEpochSeconds: BigInt(timestamp),
        secret: fixture.currentSecret,
        signatureHeader,
        timestampHeader: timestamp,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        body: fixture.eventPayload,
        deliveryId: fixture.deliveryPublicId,
        nowEpochSeconds: BigInt(timestamp),
        secret: fixture.previousSecret!,
        signatureHeader,
        timestampHeader: timestamp,
      }),
    ).toBe(true);

    const persisted = await owner()
      .getClient()
      .webhookDelivery.findUniqueOrThrow({
        include: { attempts: true },
        where: { id: fixture.deliveryId },
      });
    expect(persisted).toMatchObject({ attemptCount: 1, status: 'DELIVERED' });
    expect(persisted.attempts).toHaveLength(1);
    expect(persisted.attempts[0]).toMatchObject({
      currentSecretVersion: 2,
      outcome: 'DELIVERED',
      previousSecretVersion: 1,
      signatureVersion: 'v1',
    });
  });

  it('omits an expired previous secret instead of extending the overlap', async () => {
    responseStatus = 204;
    const fixture = await createFixture({ previousOverlapMs: -60_000, previousSecret: true });
    await expect(service().runOnce('webhook_expired_previous', 4)).resolves.toMatchObject({
      delivered: 1,
    });
    const request = received.at(-1);
    const signatureHeader = request?.headers['settleflow-signature'];
    if (typeof signatureHeader !== 'string') {
      throw new Error('Expected scalar webhook signature header');
    }
    expect(signatureHeader.split(';')).toHaveLength(1);
    const attempt = await owner()
      .getClient()
      .webhookDeliveryAttempt.findFirstOrThrow({
        where: { deliveryId: fixture.deliveryId },
      });
    expect(attempt.currentSecretVersion).toBe(2);
    expect(attempt.previousSecretVersion).toBeNull();
  });

  it('applies seven immediate full-jitter retries and then dead-letters', async () => {
    responseStatus = 500;
    const fixture = await createFixture();
    const sender = service();
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const result = await sender.runOnce('webhook_integration_retry', 4);
      expect(result.claimed).toBe(1);
      expect(result.retrying).toBe(attempt < 7 ? 1 : 0);
      expect(result.deadLettered).toBe(attempt === 7 ? 1 : 0);
    }
    const persisted = await owner()
      .getClient()
      .webhookDelivery.findUniqueOrThrow({
        include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
        where: { id: fixture.deliveryId },
      });
    expect(persisted).toMatchObject({
      attemptCount: 7,
      nextAttemptAt: null,
      status: 'DEAD_LETTERED',
    });
    expect(persisted.attempts.map((attempt) => attempt.attemptNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(persisted.attempts.every((attempt) => attempt.outcome === 'RETRYABLE_FAILURE')).toBe(
      true,
    );

    await expect(
      runtime().getClient()
        .$executeRaw`UPDATE "webhook_delivery_attempts" SET "error_code" = 'changed' WHERE "delivery_id" = ${fixture.deliveryId}::uuid`,
    ).rejects.toBeDefined();
    await expect(
      runtime().getClient()
        .$executeRaw`DELETE FROM "webhook_deliveries" WHERE "id" = ${fixture.deliveryId}::uuid`,
    ).rejects.toBeDefined();
    await expect(
      owner().getClient()
        .$executeRaw`DELETE FROM "webhook_delivery_attempts" WHERE "delivery_id" = ${fixture.deliveryId}::uuid`,
    ).rejects.toBeDefined();
  });

  it('recovers a seventh started attempt as one immutable unknown terminal outcome', async () => {
    const fixture = await createFixture({ attemptCount: 6, status: 'RETRYING' });
    const repo = repository();
    const claims = await repo.claimDue('webhook_crash_owner', 1);
    const claimed = claims[0];
    if (claimed === undefined) throw new Error('Expected a claimed delivery');
    const loaded = await repo.loadContext(claimed);
    if (loaded === undefined) throw new Error('Expected a delivery context');
    const started = await repo.startAttempt(loaded, undefined);
    expect(started).toMatchObject({
      attempt: { attemptNumber: 7 },
      kind: 'started',
    });
    if (started.kind !== 'started') throw new Error('Expected a started delivery attempt');
    await owner().getClient().$executeRaw`
      UPDATE "webhook_deliveries"
      SET
        "locked_at" = clock_timestamp() - INTERVAL '60 seconds',
        "lease_expires_at" = clock_timestamp() - INTERVAL '30 seconds',
        "active_attempt_started_at" = clock_timestamp() - INTERVAL '60 seconds'
      WHERE "id" = ${fixture.deliveryId}::uuid
    `;

    await expect(
      repo.finalizeAttempt(claimed, started.attempt, {
        errorCode: undefined,
        httpStatus: 204,
        outcome: 'delivered',
        responseBodySha256: Buffer.alloc(32),
        responseBodyTruncated: false,
      }),
    ).resolves.toEqual({ status: 'dead_lettered', updated: false });

    await expect(repo.recoverExpired(4)).resolves.toEqual({
      clearedUnstarted: 0,
      deadLettered: 1,
      recoveredUnknown: 1,
    });
    await expect(repo.recoverExpired(4)).resolves.toEqual({
      clearedUnstarted: 0,
      deadLettered: 0,
      recoveredUnknown: 0,
    });
    const persisted = await owner()
      .getClient()
      .webhookDelivery.findUniqueOrThrow({
        include: { attempts: true },
        where: { id: fixture.deliveryId },
      });
    expect(persisted).toMatchObject({ attemptCount: 7, status: 'DEAD_LETTERED' });
    expect(persisted.attempts).toHaveLength(1);
    expect(persisted.attempts[0]).toMatchObject({
      attemptNumber: 7,
      errorCode: 'lease_expired_unknown',
      outcome: 'UNKNOWN',
    });
  });

  it('does not contact an endpoint that is inactive at attempt start', async () => {
    responseStatus = 204;
    const before = received.length;
    const fixture = await createFixture({ endpointStatus: 'INACTIVE' });
    await expect(service().runOnce('webhook_inactive', 4)).resolves.toMatchObject({
      deadLettered: 1,
    });
    expect(received).toHaveLength(before);
    const persisted = await owner()
      .getClient()
      .webhookDelivery.findUniqueOrThrow({
        include: { attempts: true },
        where: { id: fixture.deliveryId },
      });
    expect(persisted).toMatchObject({ attemptCount: 1, status: 'DEAD_LETTERED' });
    expect(persisted.attempts[0]).toMatchObject({
      currentSecretVersion: null,
      errorCode: 'endpoint_inactive',
      outcome: 'NON_RETRYABLE_FAILURE',
      signatureVersion: null,
    });
  });

  it('permits only one winner across competing claimers', async () => {
    const fixture = await createFixture();
    const [first, second] = await Promise.all([
      repository().claimDue('webhook_race_one', 1),
      repository().claimDue('webhook_race_two', 1),
    ]);
    expect(first.length + second.length).toBe(1);
    const winner = first[0] ?? second[0];
    if (winner === undefined) throw new Error('Expected one claim winner');
    expect(winner.deliveryId).toBe(fixture.deliveryId);
    await expect(repository().releaseUnstarted(winner)).resolves.toBe(true);
  });
});
