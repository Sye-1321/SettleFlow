import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { IdempotencyService, idempotencyServiceInternals } from '@settleflow/idempotency';
import { PrismaDatabase } from '@settleflow/infrastructure';
import { LedgerService } from '@settleflow/ledger';
import { MerchantAccessService } from '@settleflow/merchant-access';
import { paymentIntentServiceInternals } from '@settleflow/payments';

import { configureOpenApi } from '../../apps/api/src/openapi';
import { provisionTestRuntimeRole, testRuntimeDatabaseUrl } from './support/postgres-runtime-role';

const POSTGRES_IMAGE =
  'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
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

interface ProblemDetails {
  readonly code: string;
  readonly requestId: string;
  readonly status: number;
}

function digest(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(idempotencyServiceInternals.sha256(value));
}

describe('M1 Payment Intent API with real PostgreSQL', () => {
  let app: INestApplication | undefined;
  let baseUrl = '';
  let database: PrismaDatabase | undefined;
  let idempotency: IdempotencyService | undefined;
  let ledger: LedgerService | undefined;
  let merchantAccess: MerchantAccessService | undefined;
  let postgres: StartedPostgreSqlContainer | undefined;
  let merchantSequence = 0;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('settleflow_payment_intents_test')
      .withUsername('settleflow_payment_intents_test')
      .withPassword('settleflow_payment_intents_test_only')
      .start();
    await provisionTestRuntimeRole(postgres);
    await deployMigrations(postgres.getConnectionUri());

    process.env['API_HOST'] = '127.0.0.1';
    process.env['API_PORT'] = '3000';
    process.env['DATABASE_URL'] = testRuntimeDatabaseUrl(postgres);
    process.env['DEPENDENCY_READINESS_TIMEOUT_MS'] = '10000';
    process.env['IDEMPOTENCY_LEASE_MS'] = '60000';
    process.env['IDEMPOTENCY_LOCK_TIMEOUT_MS'] = '10000';
    process.env['IDEMPOTENCY_REPLAY_TTL_HOURS'] = '168';
    process.env['IDEMPOTENCY_STATEMENT_TIMEOUT_MS'] = '30000';
    process.env['NODE_ENV'] = 'test';
    process.env['RABBITMQ_URL'] = 'amqp://unavailable:unavailable@127.0.0.1:1/unavailable';
    process.env['WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS'] = '[]';
    process.env['WEBHOOK_ENDPOINT_LOCK_TIMEOUT_MS'] = '5000';
    process.env['WEBHOOK_ENDPOINT_STATEMENT_TIMEOUT_MS'] = '10000';
    process.env['WEBHOOK_KEYRING_PROVIDER'] = 'local';
    process.env['WEBHOOK_LOCAL_ACTIVE_KEY_ID'] = 'integration-v1';
    process.env['WEBHOOK_LOCAL_KEYS_JSON'] = JSON.stringify({
      'integration-v1': Buffer.alloc(32).toString('base64url'),
    });
    process.env['WEBHOOK_URL_POLICY_MODE'] = 'production';

    const { AppModule } = await import('../../apps/api/src/app.module.js');
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      logger: false,
      rawBody: true,
    });
    configureOpenApi(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    database = app.get(PrismaDatabase);
    idempotency = app.get(IdempotencyService);
    ledger = app.get(LedgerService);
    merchantAccess = app.get(MerchantAccessService);
  }, 120_000);

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
    if (database !== undefined) {
      await expect(database.checkConnectivity()).resolves.toBe(false);
    }
    if (postgres !== undefined) {
      await postgres.stop();
    }
  }, 120_000);

  async function issueKey(scopes: readonly ('payments:read' | 'payments:write')[]): Promise<{
    readonly merchantId: string;
    readonly plaintext: string;
  }> {
    if (database === undefined || ledger === undefined || merchantAccess === undefined) {
      throw new Error('Application services are unavailable');
    }
    merchantSequence += 1;
    const merchant = await database.getClient().merchant.create({
      data: { code: `payment-test-${merchantSequence}` },
    });
    await database
      .getClient()
      .$transaction((transaction) => ledger!.provisionAccounts(transaction, merchant.id));
    const issued = await merchantAccess.issueApiKey({ merchantId: merchant.id, scopes });
    return { merchantId: merchant.id, plaintext: issued.plaintext };
  }

  function post(
    plaintext: string,
    idempotencyKey: string,
    rawBody: string,
    requestId = 'req_payment_test',
    contentType = 'application/json',
  ): Promise<Response> {
    return fetch(`${baseUrl}/v1/payment-intents`, {
      body: rawBody,
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': contentType,
        'idempotency-key': idempotencyKey,
        'x-request-id': requestId,
      },
      method: 'POST',
    });
  }

  function postCapture(
    plaintext: string,
    paymentId: string,
    idempotencyKey: string,
    rawBody: string,
    requestId = 'req_capture_test',
  ): Promise<Response> {
    return fetch(`${baseUrl}/v1/payment-intents/${paymentId}/capture`, {
      body: rawBody,
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-request-id': requestId,
      },
      method: 'POST',
    });
  }

  function postRefund(
    plaintext: string,
    paymentId: string,
    idempotencyKey: string,
    rawBody: string,
    requestId = 'req_refund_test',
  ): Promise<Response> {
    return fetch(`${baseUrl}/v1/payment-intents/${paymentId}/refunds`, {
      body: rawBody,
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-request-id': requestId,
      },
      method: 'POST',
    });
  }

  const createBody =
    '{"externalRef":"order_1001","amountMinor":1000.0,"currency":"ETB","captureMethod":"manual"}';

  it('atomically creates one payment, completed snapshot, and exact outbox event, then replays it', async () => {
    if (database === undefined) {
      throw new Error('Database is unavailable');
    }
    const access = await issueKey(['payments:read', 'payments:write']);
    const first = await post(access.plaintext, 'idempotency-create-replay', createBody);
    expect(first.status).toBe(201);
    expect(first.headers.get('content-type')).toContain('application/json');
    expect(first.headers.get('x-request-id')).toBe('req_payment_test');
    const created = (await first.json()) as Record<string, unknown>;
    expect(created).toMatchObject({
      amountMinor: 1_000,
      captureMethod: 'manual',
      capturedAmountMinor: 0,
      currency: 'ETB',
      externalRef: 'order_1001',
      paymentStatus: 'created',
      refundedAmountMinor: 0,
      settlementStatus: 'NOT_ELIGIBLE',
      version: 0,
    });
    expect(created['id']).toMatch(/^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);

    const replay = await post(
      access.plaintext,
      'idempotency-create-replay',
      '{"externalRef":"order_1001","amountMinor":1e3,"currency":"ETB","captureMethod":"manual"}',
      'req_replay_attempt',
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get('x-request-id')).toBe('req_replay_attempt');
    await expect(replay.json()).resolves.toEqual(created);

    const payments = await database.getClient().paymentIntent.findMany({
      where: { merchantId: access.merchantId },
    });
    const idempotencyRows = await database.getClient().idempotencyKey.findMany({
      where: { merchantId: access.merchantId },
    });
    const outbox = await database.getClient().outboxEvent.findMany({
      where: { merchantId: access.merchantId },
    });
    expect(payments).toHaveLength(1);
    expect(idempotencyRows).toHaveLength(1);
    expect(idempotencyRows[0]).toMatchObject({
      responseContentType: 'application/json',
      responseStatus: 201,
      resultReference: created['id'],
      state: 'COMPLETED',
    });
    expect(idempotencyRows[0]?.responseBody).toEqual(created);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventId).toMatch(/^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(outbox[0]?.payload).toEqual({
      amountMinor: 1_000,
      currency: 'ETB',
      eventId: outbox[0]?.eventId,
      eventType: 'payment.created.v1',
      merchantId: access.merchantId,
      occurredAt: outbox[0]?.occurredAt.toISOString(),
      paymentId: created['id'],
      requestId: 'req_payment_test',
      status: 'CREATED',
    });
    expect(Object.keys(outbox[0]?.payload as object)).toHaveLength(9);
  });

  it('rejects changed fingerprints and active owners without duplicate effects', async () => {
    if (database === undefined) {
      throw new Error('Database is unavailable');
    }
    const access = await issueKey(['payments:write']);
    const initial = await post(
      access.plaintext,
      'idempotency-reuse',
      '{"externalRef":"reuse-order","amountMinor":1000,"currency":"USD","captureMethod":"manual"}',
    );
    expect(initial.status).toBe(201);
    const reused = await post(
      access.plaintext,
      'idempotency-reuse',
      '{"externalRef":"reuse-order","amountMinor":1001,"currency":"USD","captureMethod":"manual"}',
    );
    expect(reused.status).toBe(409);
    await expect(reused.json()).resolves.toMatchObject({
      code: 'idempotency_key_reused',
      status: 409,
    });

    const activeBody = {
      amountMinor: 2_000,
      captureMethod: 'manual' as const,
      currency: 'ETB' as const,
      externalRef: 'active-owner-order',
      idempotencyKey: 'idempotency-active-owner',
      merchantId: access.merchantId,
      requestId: 'not-fingerprinted',
    };
    const now = new Date();
    await database.getClient().idempotencyKey.create({
      data: {
        httpMethod: 'POST',
        keyHash: digest(activeBody.idempotencyKey),
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        merchantId: access.merchantId,
        normalizedRoute: '/v1/payment-intents',
        ownerToken: crypto.randomUUID(),
        requestHash: digest(paymentIntentServiceInternals.canonicalCreateCommand(activeBody)),
        state: 'IN_PROGRESS',
      },
    });
    const active = await post(
      access.plaintext,
      activeBody.idempotencyKey,
      '{"externalRef":"active-owner-order","amountMinor":2000,"currency":"ETB","captureMethod":"manual"}',
    );
    expect(active.status).toBe(409);
    expect(active.headers.get('retry-after')).toBe('1');
    await expect(active.json()).resolves.toMatchObject({
      code: 'idempotency_request_in_progress',
      status: 409,
    });

    const staleBody = {
      amountMinor: 3_000,
      captureMethod: 'manual' as const,
      currency: 'USD' as const,
      externalRef: 'stale-owner-order',
      idempotencyKey: 'idempotency-stale-owner',
      merchantId: access.merchantId,
      requestId: 'not-fingerprinted',
    };
    await database.getClient().idempotencyKey.create({
      data: {
        httpMethod: 'POST',
        keyHash: digest(staleBody.idempotencyKey),
        leaseExpiresAt: new Date(now.getTime() - 1_000),
        merchantId: access.merchantId,
        normalizedRoute: '/v1/payment-intents',
        ownerToken: crypto.randomUUID(),
        requestHash: digest(paymentIntentServiceInternals.canonicalCreateCommand(staleBody)),
        state: 'IN_PROGRESS',
      },
    });
    const recovered = await post(
      access.plaintext,
      staleBody.idempotencyKey,
      '{"externalRef":"stale-owner-order","amountMinor":3000,"currency":"USD","captureMethod":"manual"}',
    );
    expect(recovered.status).toBe(201);
    const recoveredRecord = await database.getClient().idempotencyKey.findFirstOrThrow({
      where: { keyHash: digest(staleBody.idempotencyKey), merchantId: access.merchantId },
    });
    expect(recoveredRecord.state).toBe('COMPLETED');
  });

  it('allows one durable effect under a concurrent same-key request storm', async () => {
    if (database === undefined) {
      throw new Error('Database is unavailable');
    }
    const access = await issueKey(['payments:write']);
    const stormBody =
      '{"externalRef":"storm-order","amountMinor":700,"currency":"ETB","captureMethod":"manual"}';
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        post(access.plaintext, 'idempotency-storm', stormBody, `req_storm_${String(index)}`),
      ),
    );
    expect(attempts.some((response) => response.status === 201)).toBe(true);
    expect(attempts.every((response) => response.status === 201 || response.status === 409)).toBe(
      true,
    );
    const replay = await post(access.plaintext, 'idempotency-storm', stormBody, 'req_storm_replay');
    expect(replay.status).toBe(201);
    expect(
      await database.getClient().paymentIntent.count({ where: { merchantId: access.merchantId } }),
    ).toBe(1);
    expect(
      await database.getClient().idempotencyKey.count({ where: { merchantId: access.merchantId } }),
    ).toBe(1);
    expect(
      await database.getClient().outboxEvent.count({ where: { merchantId: access.merchantId } }),
    ).toBe(1);
  });

  it('stores and replays a different-key external-reference conflict', async () => {
    if (database === undefined) {
      throw new Error('Database is unavailable');
    }
    const access = await issueKey(['payments:write']);
    const original =
      '{"externalRef":"unique-order","amountMinor":500,"currency":"ETB","captureMethod":"manual"}';
    expect((await post(access.plaintext, 'external-original', original)).status).toBe(201);

    const conflictBody =
      '{"externalRef":"unique-order","amountMinor":600,"currency":"ETB","captureMethod":"manual"}';
    const conflict = await post(access.plaintext, 'external-conflict', conflictBody);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'external_reference_conflict',
      status: 409,
    });
    const replay = await post(
      access.plaintext,
      'external-conflict',
      conflictBody,
      'req_conflict_replay',
    );
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({
      code: 'external_reference_conflict',
      requestId: 'req_conflict_replay',
      status: 409,
    });

    expect(
      await database.getClient().paymentIntent.count({ where: { merchantId: access.merchantId } }),
    ).toBe(1);
    expect(
      await database.getClient().outboxEvent.count({ where: { merchantId: access.merchantId } }),
    ).toBe(1);
    const conflictRecord = await database.getClient().idempotencyKey.findFirstOrThrow({
      where: {
        keyHash: digest('external-conflict'),
        merchantId: access.merchantId,
      },
    });
    expect(conflictRecord).toMatchObject({
      responseContentType: 'application/problem+json',
      responseStatus: 409,
      state: 'COMPLETED',
    });
  });

  it('enforces scopes and merchant ownership on create and retrieve', async () => {
    const owner = await issueKey(['payments:read', 'payments:write']);
    const other = await issueKey(['payments:read']);
    const writeOnly = await issueKey(['payments:write']);
    const createdResponse = await post(
      owner.plaintext,
      'tenant-create',
      '{"externalRef":"tenant-order","amountMinor":900,"currency":"USD","captureMethod":"manual"}',
    );
    const created = (await createdResponse.json()) as { readonly id: string };

    const ownerRead = await fetch(`${baseUrl}/v1/payment-intents/${created.id}`, {
      headers: { authorization: `Bearer ${owner.plaintext}` },
    });
    expect(ownerRead.status).toBe(200);
    await expect(ownerRead.json()).resolves.toMatchObject({
      id: created.id,
      settlementStatus: 'NOT_ELIGIBLE',
    });

    const foreignRead = await fetch(`${baseUrl}/v1/payment-intents/${created.id}`, {
      headers: { authorization: `Bearer ${other.plaintext}` },
    });
    const missingRead = await fetch(`${baseUrl}/v1/payment-intents/pi_01ARZ3NDEKTSV4RRFFQ69G5FAA`, {
      headers: { authorization: `Bearer ${owner.plaintext}` },
    });
    expect(foreignRead.status).toBe(404);
    expect(missingRead.status).toBe(404);
    await expect(foreignRead.json()).resolves.toMatchObject({
      code: 'payment_intent_not_found',
    });
    await expect(missingRead.json()).resolves.toMatchObject({
      code: 'payment_intent_not_found',
    });

    const readForbidden = await fetch(`${baseUrl}/v1/payment-intents/${created.id}`, {
      headers: { authorization: `Bearer ${writeOnly.plaintext}` },
    });
    const writeForbidden = await post(other.plaintext, 'scope-denied', createBody);
    const unauthorized = await fetch(`${baseUrl}/v1/payment-intents/${created.id}`);
    expect(readForbidden.status).toBe(403);
    expect(writeForbidden.status).toBe(403);
    expect(unauthorized.status).toBe(401);
  });

  it.each([
    [
      'fractional amount',
      '{"externalRef":"invalid-1","amountMinor":1.1,"currency":"ETB","captureMethod":"manual"}',
      400,
      'invalid_request',
    ],
    [
      'unsafe amount',
      '{"externalRef":"invalid-2","amountMinor":9007199254740992,"currency":"ETB","captureMethod":"manual"}',
      400,
      'invalid_request',
    ],
    [
      'duplicate field',
      '{"externalRef":"invalid-3","amountMinor":1000,"amountMinor":1000,"currency":"ETB","captureMethod":"manual"}',
      400,
      'invalid_request',
    ],
    [
      'unsupported currency',
      '{"externalRef":"invalid-4","amountMinor":1000,"currency":"EUR","captureMethod":"manual"}',
      422,
      'unsupported_currency',
    ],
    [
      'unsupported capture',
      '{"externalRef":"invalid-5","amountMinor":1000,"currency":"ETB","captureMethod":"automatic"}',
      422,
      'unsupported_capture_method',
    ],
  ])('returns an RFC problem for %s', async (_name, rawBody, status, code) => {
    const access = await issueKey(['payments:write']);
    const response = await post(access.plaintext, `invalid-${merchantSequence}`, rawBody);
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const problem = (await response.json()) as ProblemDetails;
    expect(problem).toMatchObject({ code, requestId: 'req_payment_test', status });
    expect(problem.requestId).not.toContain('\n');
  });

  it('publishes the exact OpenAPI path, scopes, headers, and problem content types', async () => {
    const response = await fetch(`${baseUrl}/docs/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      readonly paths: Record<
        string,
        {
          readonly get?: {
            readonly security?: unknown;
            readonly 'x-required-scopes'?: readonly string[];
          };
          readonly post?: {
            readonly parameters?: readonly { readonly name?: string }[];
            readonly responses?: Record<
              string,
              {
                readonly content?: Record<string, unknown>;
                readonly headers?: Record<string, unknown>;
              }
            >;
            readonly security?: unknown;
            readonly 'x-required-scopes'?: readonly string[];
          };
        }
      >;
    };
    const path = document.paths['/v1/payment-intents'];
    expect(path?.post?.security).toEqual([{ merchantApiKey: [] }]);
    expect(path?.post?.['x-required-scopes']).toEqual(['payments:write']);
    expect(path?.get).toBeUndefined();
    expect(path?.post?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key' })]),
    );
    expect(path?.post?.responses?.['400']?.content).toHaveProperty('application/problem+json');
    expect(path?.post?.responses?.['201']?.headers).toHaveProperty('X-Request-Id');
    expect(path?.post?.responses?.['409']?.headers).toHaveProperty('Retry-After');
    expect(document.paths['/v1/payment-intents/{id}']?.get?.security).toEqual([
      { merchantApiKey: [] },
    ]);
    expect(document.paths['/v1/payment-intents/{id}']?.get?.['x-required-scopes']).toEqual([
      'payments:read',
    ]);
    for (const route of ['/v1/payment-intents/{id}/capture', '/v1/payment-intents/{id}/refunds']) {
      expect(document.paths[route]?.post?.security).toEqual([{ merchantApiKey: [] }]);
      expect(document.paths[route]?.post?.['x-required-scopes']).toEqual(['payments:write']);
      expect(document.paths[route]?.post?.parameters).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key' })]),
      );
      expect(document.paths[route]?.post?.responses?.['409']?.content).toHaveProperty(
        'application/problem+json',
      );
    }
  });

  it('rolls back payment and outbox writes when completion fails before the snapshot', async () => {
    if (database === undefined || idempotency === undefined) {
      throw new Error('Application services are unavailable');
    }
    const access = await issueKey(['payments:write']);
    const now = new Date('2026-08-01T12:34:56.789Z');
    const paymentId = 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAB';
    const eventId = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAB';
    const acquisition = await idempotency.acquire({
      canonicalRequest:
        '{"v":1,"externalRef":"rollback-order","amountMinor":"800","currency":"ETB","captureMethod":"manual"}',
      key: 'idempotency-rollback',
      merchantId: access.merchantId,
      method: 'POST',
      normalizedRoute: '/v1/payment-intents',
      now: new Date(),
    });
    if (acquisition.kind !== 'acquired') {
      throw new Error('Expected fresh idempotency ownership');
    }

    await expect(
      idempotency.complete(acquisition.ownership, async (transaction) => {
        await transaction.paymentIntent.create({
          data: {
            amountMinor: 800n,
            captureMethod: 'MANUAL',
            currency: 'ETB',
            externalRef: 'rollback-order',
            merchantId: access.merchantId,
            publicId: paymentId,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            aggregateId: paymentId,
            aggregateType: 'payment_intent',
            eventId,
            eventType: 'payment.created.v1',
            merchantId: access.merchantId,
            occurredAt: now,
            payload: {
              amountMinor: 800,
              currency: 'ETB',
              eventId,
              eventType: 'payment.created.v1',
              merchantId: access.merchantId,
              occurredAt: now.toISOString(),
              paymentId,
              requestId: 'req_rollback_test',
              status: 'CREATED',
            },
            requestId: 'req_rollback_test',
          },
        });
        throw new Error('Synthetic failure before idempotency snapshot');
      }),
    ).rejects.toThrow('Synthetic failure before idempotency snapshot');

    expect(
      await database.getClient().paymentIntent.count({ where: { merchantId: access.merchantId } }),
    ).toBe(0);
    expect(
      await database.getClient().outboxEvent.count({ where: { merchantId: access.merchantId } }),
    ).toBe(0);
    await expect(
      database.getClient().idempotencyKey.findFirstOrThrow({
        where: { keyHash: digest('idempotency-rollback'), merchantId: access.merchantId },
      }),
    ).resolves.toMatchObject({ state: 'IN_PROGRESS' });
  });

  it('atomically captures, partially refunds, fully refunds, and replays each financial result', async () => {
    if (database === undefined) {
      throw new Error('Database is unavailable');
    }
    const access = await issueKey(['payments:read', 'payments:write']);
    const createdResponse = await post(
      access.plaintext,
      'financial-create',
      '{"externalRef":"financial-order","amountMinor":1000,"currency":"ETB","captureMethod":"manual"}',
      'req_financial_create',
    );
    const created = (await createdResponse.json()) as { readonly id: string };

    const captureResponse = await postCapture(
      access.plaintext,
      created.id,
      'financial-capture',
      '{"amountMinor":1000.0,"currency":"ETB"}',
      'req_financial_capture',
    );
    expect(captureResponse.status).toBe(200);
    const captured = (await captureResponse.json()) as Record<string, unknown>;
    expect(captured).toMatchObject({
      capturedAmountMinor: 1_000,
      id: created.id,
      paymentStatus: 'captured',
      refundedAmountMinor: 0,
      settlementStatus: 'NOT_ELIGIBLE',
      version: 1,
    });
    expect(captured['ledgerTransactionId']).toMatch(/^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);

    const captureReplay = await postCapture(
      access.plaintext,
      created.id,
      'financial-capture',
      '{"amountMinor":1e3,"currency":"ETB"}',
      'req_financial_capture_replay',
    );
    expect(captureReplay.status).toBe(200);
    await expect(captureReplay.json()).resolves.toEqual(captured);

    const partialResponse = await postRefund(
      access.plaintext,
      created.id,
      'financial-refund-partial',
      '{"externalRef":"financial-refund-1","amountMinor":400,"currency":"ETB"}',
      'req_financial_refund_1',
    );
    expect(partialResponse.status).toBe(201);
    const partial = (await partialResponse.json()) as Record<string, unknown>;
    expect(partial).toMatchObject({
      amountMinor: 400,
      cumulativeRefundedAmountMinor: 400,
      paymentId: created.id,
      paymentStatus: 'partially_refunded',
    });
    expect(partial['id']).toMatch(/^rf_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(partial['ledgerTransactionId']).toMatch(/^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);

    const partialReplay = await postRefund(
      access.plaintext,
      created.id,
      'financial-refund-partial',
      '{"externalRef":"financial-refund-1","amountMinor":400.0,"currency":"ETB"}',
      'req_financial_refund_1_replay',
    );
    expect(partialReplay.status).toBe(201);
    await expect(partialReplay.json()).resolves.toEqual(partial);

    const fullResponse = await postRefund(
      access.plaintext,
      created.id,
      'financial-refund-full',
      '{"externalRef":"financial-refund-2","amountMinor":600,"currency":"ETB"}',
      'req_financial_refund_2',
    );
    expect(fullResponse.status).toBe(201);
    await expect(fullResponse.json()).resolves.toMatchObject({
      amountMinor: 600,
      cumulativeRefundedAmountMinor: 1_000,
      paymentId: created.id,
      paymentStatus: 'refunded',
    });

    const overRefund = await postRefund(
      access.plaintext,
      created.id,
      'financial-refund-excess',
      '{"externalRef":"financial-refund-3","amountMinor":1,"currency":"ETB"}',
    );
    expect(overRefund.status).toBe(409);
    await expect(overRefund.json()).resolves.toMatchObject({
      code: 'payment_intent_not_refundable',
      status: 409,
    });

    const storedPayment = await database.getClient().paymentIntent.findFirstOrThrow({
      where: { merchantId: access.merchantId, publicId: created.id },
    });
    expect(storedPayment).toMatchObject({
      amountMinor: 1_000n,
      capturedAmountMinor: 1_000n,
      paymentStatus: 'REFUNDED',
      refundedAmountMinor: 1_000n,
      version: 3,
    });
    expect(storedPayment.capturedAt).not.toBeNull();
    expect(storedPayment.availableAt).toEqual(storedPayment.capturedAt);

    const ledgerTransactions = await database.getClient().ledgerTransaction.findMany({
      include: { entries: { include: { account: true }, orderBy: { entrySeq: 'asc' } } },
      orderBy: { occurredAt: 'asc' },
      where: { merchantId: access.merchantId },
    });
    expect(ledgerTransactions).toHaveLength(3);
    expect(ledgerTransactions.map((row) => row.businessType)).toEqual([
      'CAPTURE',
      'REFUND',
      'REFUND',
    ]);
    for (const transaction of ledgerTransactions) {
      expect(transaction.postedAt).not.toBeNull();
      expect(transaction.entries).toHaveLength(2);
      const debits = transaction.entries
        .filter((entry) => entry.side === 'DEBIT')
        .reduce((sum, entry) => sum + entry.amountMinor, 0n);
      const credits = transaction.entries
        .filter((entry) => entry.side === 'CREDIT')
        .reduce((sum, entry) => sum + entry.amountMinor, 0n);
      expect(debits).toBe(credits);
    }

    const outbox = await database.getClient().outboxEvent.findMany({
      orderBy: { occurredAt: 'asc' },
      where: { merchantId: access.merchantId },
    });
    expect(outbox.map((row) => row.eventType)).toEqual([
      'payment.created.v1',
      'payment.captured.v1',
      'payment.refunded.v1',
      'payment.refunded.v1',
    ]);
    expect(Object.keys(outbox[1]?.payload as object)).toHaveLength(10);
    expect(Object.keys(outbox[2]?.payload as object)).toHaveLength(11);
    expect(
      await database.getClient().refund.count({ where: { merchantId: access.merchantId } }),
    ).toBe(2);
    expect(
      await database.getClient().idempotencyKey.count({
        where: { merchantId: access.merchantId, state: 'COMPLETED' },
      }),
    ).toBe(5);
    expect(
      await database.getClient().auditEvent.count({ where: { merchantId: access.merchantId } }),
    ).toBe(0);
    await expect(
      database
        .getClient()
        .$executeRawUnsafe('UPDATE "refunds" SET "external_ref" = "external_ref"'),
    ).rejects.toThrow(/permission denied/iu);
    await expect(database.getClient().$executeRawUnsafe('DELETE FROM "refunds"')).rejects.toThrow(
      /permission denied/iu,
    );
    await expect(
      database.getClient().$executeRawUnsafe('TRUNCATE TABLE "refunds"'),
    ).rejects.toThrow(/permission denied/iu);
  });

  it('serializes fifty distinct capture keys so only one financial effect commits', async () => {
    if (database === undefined) {
      throw new Error('Database is unavailable');
    }
    const access = await issueKey(['payments:write']);
    const createdResponse = await post(
      access.plaintext,
      'capture-race-create',
      '{"externalRef":"capture-race-order","amountMinor":750,"currency":"USD","captureMethod":"manual"}',
    );
    const created = (await createdResponse.json()) as { readonly id: string };
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        postCapture(
          access.plaintext,
          created.id,
          `capture-race-${String(index)}`,
          '{"amountMinor":750,"currency":"USD"}',
          `req_capture_race_${String(index)}`,
        ),
      ),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(49);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    expect(
      await database.getClient().ledgerTransaction.count({
        where: { businessType: 'CAPTURE', merchantId: access.merchantId },
      }),
    ).toBe(1);
    expect(
      await database.getClient().outboxEvent.count({
        where: { eventType: 'payment.captured.v1', merchantId: access.merchantId },
      }),
    ).toBe(1);
  }, 60_000);

  it('serializes concurrent refunds and never permits the committed total to exceed capture', async () => {
    if (database === undefined) {
      throw new Error('Database is unavailable');
    }
    const access = await issueKey(['payments:write']);
    const createdResponse = await post(
      access.plaintext,
      'refund-race-create',
      '{"externalRef":"refund-race-order","amountMinor":1000,"currency":"ETB","captureMethod":"manual"}',
    );
    const created = (await createdResponse.json()) as { readonly id: string };
    expect(
      (
        await postCapture(
          access.plaintext,
          created.id,
          'refund-race-capture',
          '{"amountMinor":1000,"currency":"ETB"}',
        )
      ).status,
    ).toBe(200);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        postRefund(
          access.plaintext,
          created.id,
          `refund-race-${String(index)}`,
          `{"externalRef":"refund-race-${String(index)}","amountMinor":200,"currency":"ETB"}`,
          `req_refund_race_${String(index)}`,
        ),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(5);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    const storedPayment = await database.getClient().paymentIntent.findFirstOrThrow({
      where: { merchantId: access.merchantId, publicId: created.id },
    });
    expect(storedPayment.refundedAmountMinor).toBe(1_000n);
    expect(storedPayment.paymentStatus).toBe('REFUNDED');
    const refunds = await database.getClient().refund.findMany({
      where: { merchantId: access.merchantId },
    });
    expect(refunds).toHaveLength(5);
    expect(refunds.reduce((sum, refund) => sum + refund.amountMinor, 0n)).toBe(1_000n);
    expect(
      await database.getClient().ledgerTransaction.count({
        where: { businessType: 'REFUND', merchantId: access.merchantId },
      }),
    ).toBe(5);
  }, 60_000);

  it('keeps capture and refund commands tenant-scoped and payments:write protected', async () => {
    const owner = await issueKey(['payments:write']);
    const foreign = await issueKey(['payments:write']);
    const readOnly = await issueKey(['payments:read']);
    const createdResponse = await post(
      owner.plaintext,
      'financial-tenant-create',
      '{"externalRef":"financial-tenant-order","amountMinor":300,"currency":"USD","captureMethod":"manual"}',
    );
    const created = (await createdResponse.json()) as { readonly id: string };

    const foreignCapture = await postCapture(
      foreign.plaintext,
      created.id,
      'foreign-capture',
      '{"amountMinor":300,"currency":"USD"}',
    );
    const forbiddenCapture = await postCapture(
      readOnly.plaintext,
      created.id,
      'forbidden-capture',
      '{"amountMinor":300,"currency":"USD"}',
    );
    expect(foreignCapture.status).toBe(404);
    expect(forbiddenCapture.status).toBe(403);
    await expect(foreignCapture.json()).resolves.toMatchObject({
      code: 'payment_intent_not_found',
    });
  });

  it('returns a non-leaking RFC problem when PostgreSQL becomes unavailable', async () => {
    const access = await issueKey(['payments:read']);
    if (postgres === undefined) {
      throw new Error('PostgreSQL test container is unavailable');
    }
    await postgres.stop();
    postgres = undefined;

    const response = await fetch(`${baseUrl}/v1/payment-intents/pi_01ARZ3NDEKTSV4RRFFQ69G5FAV`, {
      headers: {
        authorization: `Bearer ${access.plaintext}`,
        'x-request-id': 'req_database_outage',
      },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    await expect(response.json()).resolves.toEqual({
      code: 'service_unavailable',
      detail: 'The service is temporarily unavailable.',
      requestId: 'req_database_outage',
      status: 503,
      title: 'Service unavailable',
      type: 'https://docs.settleflow.dev/problems/service_unavailable',
    });
  });
});
