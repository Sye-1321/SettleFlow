import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaDatabase } from '@settleflow/infrastructure';

import { provisionTestRuntimeRole } from './support/postgres-runtime-role';

const POSTGRES_IMAGE =
  'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';

jest.setTimeout(120_000);

interface CommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

function runMigrationDeploy(databaseUrl: string): Promise<CommandResult> {
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
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectCommand(new Error(`Prisma migrate deploy failed: ${stderr}`, { cause: error }));
          return;
        }

        resolveCommand({ stderr, stdout });
      },
    );
  });
}

describe('Prisma data foundation with real PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('settleflow_prisma_test')
      .withUsername('settleflow_prisma_test')
      .withPassword('settleflow_prisma_test_only')
      .start();
    await provisionTestRuntimeRole(postgres);
  }, 120_000);

  afterAll(async () => {
    if (postgres !== undefined) {
      await postgres.stop();
    }
  }, 120_000);

  it('applies the migration history repeatedly with only authorized foundation tables', async () => {
    if (postgres === undefined) {
      throw new Error('Testcontainers did not start PostgreSQL');
    }

    const firstDeploy = await runMigrationDeploy(postgres.getConnectionUri());
    const secondDeploy = await runMigrationDeploy(postgres.getConnectionUri());

    expect(firstDeploy.stdout).toContain('successfully applied');
    expect(secondDeploy.stdout).toContain('No pending migrations');

    const tables = await postgres.exec([
      'psql',
      '--username',
      postgres.getUsername(),
      '--dbname',
      postgres.getDatabase(),
      '--tuples-only',
      '--no-align',
      '--command',
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;",
    ]);
    const appliedMigrations = await postgres.exec([
      'psql',
      '--username',
      postgres.getUsername(),
      '--dbname',
      postgres.getDatabase(),
      '--tuples-only',
      '--no-align',
      '--command',
      'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;',
    ]);

    expect(tables.exitCode).toBe(0);
    expect(tables.stdout.trim().split(/\r?\n/)).toEqual([
      '_prisma_migrations',
      'api_keys',
      'audit_events',
      'idempotency_keys',
      'merchants',
      'outbox_events',
      'payment_intents',
      'webhook_endpoint_secrets',
      'webhook_endpoint_subscriptions',
      'webhook_endpoints',
    ]);
    expect(appliedMigrations.exitCode).toBe(0);
    expect(appliedMigrations.stdout.trim()).toBe('4');
  });

  it('supports an atomic M1 persistence set and enforces the approved database invariants', async () => {
    if (postgres === undefined) {
      throw new Error('Testcontainers did not start PostgreSQL');
    }

    const database = new PrismaDatabase({
      connectionTimeoutMs: 15_000,
      databaseUrl: postgres.getConnectionUri(),
    });
    const client = database.getClient();
    const occurredAt = new Date('2026-08-01T10:11:12.123Z');
    const completedAt = new Date('2026-08-01T10:11:13.123Z');
    const paymentId = 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const eventId = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const requestId = 'req_m1-foundation';

    try {
      const merchant = await client.merchant.create({
        data: { code: 'mrc_m1_foundation' },
      });

      await client.$transaction(async (transaction) => {
        await transaction.paymentIntent.create({
          data: {
            amountMinor: 125_000n,
            captureMethod: 'MANUAL',
            currency: 'ETB',
            externalRef: 'order-M1-001',
            merchantId: merchant.id,
            publicId: paymentId,
          },
        });
        await transaction.idempotencyKey.create({
          data: {
            completedAt,
            httpMethod: 'POST',
            keyHash: Buffer.alloc(32, 1),
            merchantId: merchant.id,
            normalizedRoute: '/v1/payment-intents',
            requestHash: Buffer.alloc(32, 2),
            responseBody: {
              amountMinor: 125_000,
              currency: 'ETB',
              id: paymentId,
              status: 'created',
            },
            responseContentType: 'application/json',
            responseExpiresAt: new Date('2026-08-08T10:11:13.123Z'),
            responseHeaders: { 'x-request-id': requestId },
            responseStatus: 201,
            resultReference: paymentId,
            state: 'COMPLETED',
          },
        });
        await transaction.outboxEvent.create({
          data: {
            aggregateId: paymentId,
            aggregateType: 'payment_intent',
            eventId,
            eventType: 'payment.created.v1',
            merchantId: merchant.id,
            occurredAt,
            payload: {
              amountMinor: 125_000,
              currency: 'ETB',
              eventId,
              eventType: 'payment.created.v1',
              merchantId: merchant.id,
              occurredAt: occurredAt.toISOString(),
              paymentId,
              requestId,
              status: 'CREATED',
            },
            requestId,
          },
        });
      });

      await expect(
        client.paymentIntent.create({
          data: {
            amountMinor: 1n,
            captureMethod: 'MANUAL',
            currency: 'ETB',
            externalRef: 'order-M1-bad-id',
            merchantId: merchant.id,
            publicId: 'pi_not-a-ulid',
          },
        }),
      ).rejects.toThrow('payment_intents_public_id_format_check');

      await expect(
        client.paymentIntent.create({
          data: {
            amountMinor: 9_007_199_254_740_992n,
            captureMethod: 'MANUAL',
            currency: 'ETB',
            externalRef: 'order-M1-overflow',
            merchantId: merchant.id,
            publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAX',
          },
        }),
      ).rejects.toThrow('payment_intents_amount_minor_range_check');

      await expect(
        client.paymentIntent.create({
          data: {
            amountMinor: 1n,
            captureMethod: 'MANUAL',
            currency: 'EUR',
            externalRef: 'order-M1-currency',
            merchantId: merchant.id,
            publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAY',
          },
        }),
      ).rejects.toThrow('payment_intents_currency_allowlist_check');

      await expect(
        client.paymentIntent.create({
          data: {
            amountMinor: 1n,
            captureMethod: 'MANUAL',
            currency: 'USD',
            externalRef: ' order-M1-whitespace',
            merchantId: merchant.id,
            publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
          },
        }),
      ).rejects.toThrow('payment_intents_external_ref_format_check');

      await expect(
        client.paymentIntent.create({
          data: {
            amountMinor: 125_000n,
            captureMethod: 'MANUAL',
            currency: 'ETB',
            externalRef: 'order-M1-invalid-state',
            merchantId: merchant.id,
            paymentStatus: 'CAPTURED',
            publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FB0',
          },
        }),
      ).rejects.toThrow('payment_intents_status_projection_check');

      await expect(
        client.paymentIntent.create({
          data: {
            amountMinor: 125_000n,
            captureMethod: 'MANUAL',
            currency: 'ETB',
            externalRef: 'order-M1-001',
            merchantId: merchant.id,
            publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FB1',
          },
        }),
      ).rejects.toThrow();

      await expect(
        client.idempotencyKey.create({
          data: {
            httpMethod: 'POST',
            keyHash: Buffer.alloc(31, 1),
            leaseExpiresAt: new Date('2026-08-01T10:12:00.000Z'),
            merchantId: merchant.id,
            normalizedRoute: '/v1/payment-intents',
            ownerToken: '00000000-0000-4000-8000-000000000001',
            requestHash: Buffer.alloc(32, 2),
            state: 'IN_PROGRESS',
          },
        }),
      ).rejects.toThrow('idempotency_keys_key_hash_length_check');

      await expect(
        client.idempotencyKey.create({
          data: {
            httpMethod: 'POST',
            keyHash: Buffer.alloc(32, 3),
            merchantId: merchant.id,
            normalizedRoute: '/v1/payment-intents',
            requestHash: Buffer.alloc(32, 4),
            state: 'COMPLETED',
          },
        }),
      ).rejects.toThrow('idempotency_keys_state_consistency_check');

      await expect(
        client.outboxEvent.create({
          data: {
            aggregateId: paymentId,
            aggregateType: 'payment_intent',
            eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAX',
            eventType: 'payment.created.v1',
            merchantId: merchant.id,
            occurredAt,
            payload: {
              amountMinor: 125_000,
              currency: 'ETB',
              eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAX',
              eventType: 'payment.created.v1',
              extra: 'not-approved',
              merchantId: merchant.id,
              occurredAt: occurredAt.toISOString(),
              paymentId,
              requestId,
              status: 'CREATED',
            },
            requestId,
          },
        }),
      ).rejects.toThrow('outbox_events_payload_contract_check');

      await expect(
        client.outboxEvent.create({
          data: {
            aggregateId: paymentId,
            aggregateType: 'payment_intent',
            eventId: 'evt_not-a-ulid',
            eventType: 'payment.created.v1',
            merchantId: merchant.id,
            occurredAt,
            payload: {
              amountMinor: 125_000,
              currency: 'ETB',
              eventId: 'evt_not-a-ulid',
              eventType: 'payment.created.v1',
              merchantId: merchant.id,
              occurredAt: occurredAt.toISOString(),
              paymentId,
              requestId,
              status: 'CREATED',
            },
            requestId,
          },
        }),
      ).rejects.toThrow('outbox_events_event_id_format_check');

      const persisted = await client.$transaction([
        client.paymentIntent.count({ where: { merchantId: merchant.id } }),
        client.idempotencyKey.count({ where: { merchantId: merchant.id } }),
        client.outboxEvent.count({ where: { merchantId: merchant.id } }),
      ]);

      expect(persisted).toEqual([1, 1, 1]);

      const disposedSnapshots = await client.$executeRaw`
        UPDATE "idempotency_keys"
        SET
          "response_status" = NULL,
          "response_content_type" = NULL,
          "response_headers" = NULL,
          "response_body" = NULL
        WHERE "merchant_id" = ${merchant.id}::uuid
          AND "state" = 'completed'
      `;
      expect(disposedSnapshots).toBe(1);

      await client.paymentIntent.create({
        data: {
          amountMinor: 125_000n,
          captureMethod: 'MANUAL',
          currency: 'ETB',
          externalRef: 'order-m1-001',
          merchantId: merchant.id,
          publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FB2',
        },
      });
      const secondMerchant = await client.merchant.create({
        data: { code: 'mrc_m1_foundation_second' },
      });
      await client.paymentIntent.create({
        data: {
          amountMinor: 125_000n,
          captureMethod: 'MANUAL',
          currency: 'ETB',
          externalRef: 'order-M1-001',
          merchantId: secondMerchant.id,
          publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FB3',
        },
      });

      await expect(client.merchant.delete({ where: { id: merchant.id } })).rejects.toThrow();
    } finally {
      await database.close();
    }
  });

  it('installs the named M1 checks and recovery indexes', async () => {
    if (postgres === undefined) {
      throw new Error('Testcontainers did not start PostgreSQL');
    }

    const constraints = await postgres.exec([
      'psql',
      '--username',
      postgres.getUsername(),
      '--dbname',
      postgres.getDatabase(),
      '--tuples-only',
      '--no-align',
      '--command',
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('payment_intents'::regclass, 'idempotency_keys'::regclass, 'outbox_events'::regclass) ORDER BY conname;",
    ]);
    const indexes = await postgres.exec([
      'psql',
      '--username',
      postgres.getUsername(),
      '--dbname',
      postgres.getDatabase(),
      '--tuples-only',
      '--no-align',
      '--command',
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('payment_intents', 'idempotency_keys', 'outbox_events') ORDER BY indexname;",
    ]);

    expect(constraints.exitCode).toBe(0);
    expect(constraints.stdout.trim().split(/\r?\n/)).toEqual(
      expect.arrayContaining([
        'idempotency_keys_key_hash_length_check',
        'idempotency_keys_minimum_replay_window_check',
        'idempotency_keys_state_consistency_check',
        'outbox_events_event_id_format_check',
        'outbox_events_lock_consistency_check',
        'outbox_events_payload_contract_check',
        'payment_intents_amount_minor_range_check',
        'payment_intents_currency_allowlist_check',
        'payment_intents_public_id_format_check',
        'payment_intents_status_projection_check',
      ]),
    );
    expect(indexes.exitCode).toBe(0);
    expect(indexes.stdout.trim().split(/\r?\n/)).toEqual(
      expect.arrayContaining([
        'idempotency_keys_completed_response_expires_at_idx',
        'idempotency_keys_in_progress_lease_expires_at_idx',
        'idempotency_keys_scope_key',
        'outbox_events_event_id_key',
        'outbox_events_pending_available_at_idx',
        'payment_intents_merchant_id_external_ref_key',
        'payment_intents_public_id_key',
      ]),
    );
  });

  it('uses one lazy Prisma client and disconnects idempotently', async () => {
    if (postgres === undefined) {
      throw new Error('Testcontainers did not start PostgreSQL');
    }

    const database = new PrismaDatabase({
      connectionTimeoutMs: 15_000,
      databaseUrl: postgres.getConnectionUri(),
    });

    expect(database.getClient()).toBe(database.getClient());
    await database.connect();
    const rows = await database.getClient().$queryRaw<Record<string, unknown>[]>`SELECT 1`;
    expect(rows).toHaveLength(1);
    await expect(database.checkConnectivity()).resolves.toBe(true);
    await database.close();
    await database.close();
    await expect(database.checkConnectivity()).resolves.toBe(false);
    expect(() => database.getClient()).toThrow('Prisma database is closed');
  });
});
