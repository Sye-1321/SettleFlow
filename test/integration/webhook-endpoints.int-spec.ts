import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaDatabase } from '@settleflow/infrastructure';
import { MerchantAccessService } from '@settleflow/merchant-access';
import { WebhookEndpointService } from '@settleflow/webhooks';

import { configureOpenApi } from '../../apps/api/src/openapi';
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

interface Access {
  readonly apiKeyId: string;
  readonly merchantId: string;
  readonly plaintext: string;
}

interface EndpointResponse {
  readonly id: string;
  readonly secret?: string;
  readonly status: 'active' | 'inactive';
  readonly subscriptions: readonly (
    'payment.captured.v1' | 'payment.created.v1' | 'payment.refunded.v1'
  )[];
  readonly url: string;
  readonly version: number;
}

describe('Webhook Endpoint Foundation with real PostgreSQL', () => {
  let app: INestApplication | undefined;
  let baseUrl = '';
  let database: PrismaDatabase | undefined;
  let merchantAccess: MerchantAccessService | undefined;
  let postgres: StartedPostgreSqlContainer | undefined;
  let sequence = 0;
  let webhooks: WebhookEndpointService | undefined;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('settleflow_webhook_endpoints_test')
      .withUsername('settleflow_webhook_endpoints_test')
      .withPassword('settleflow_webhook_endpoints_test_only')
      .start();
    await provisionTestRuntimeRole(postgres);
    await deployMigrations(postgres.getConnectionUri());

    process.env['API_HOST'] = '127.0.0.1';
    process.env['API_PORT'] = '3000';
    process.env['DATABASE_URL'] = testRuntimeDatabaseUrl(postgres);
    process.env['DEPENDENCY_READINESS_TIMEOUT_MS'] = '250';
    process.env['IDEMPOTENCY_LEASE_MS'] = '30000';
    process.env['IDEMPOTENCY_LOCK_TIMEOUT_MS'] = '5000';
    process.env['IDEMPOTENCY_REPLAY_TTL_HOURS'] = '168';
    process.env['IDEMPOTENCY_STATEMENT_TIMEOUT_MS'] = '10000';
    process.env['NODE_ENV'] = 'test';
    process.env['RABBITMQ_URL'] = 'amqp://unavailable:unavailable@127.0.0.1:1/unavailable';
    process.env['WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS'] = '["http://127.0.0.1:8080"]';
    process.env['WEBHOOK_ENDPOINT_LOCK_TIMEOUT_MS'] = '5000';
    process.env['WEBHOOK_ENDPOINT_STATEMENT_TIMEOUT_MS'] = '10000';
    process.env['WEBHOOK_KEYRING_PROVIDER'] = 'local';
    process.env['WEBHOOK_LOCAL_ACTIVE_KEY_ID'] = 'integration-v1';
    process.env['WEBHOOK_LOCAL_KEYS_JSON'] = JSON.stringify({
      'integration-v1': Buffer.alloc(32, 9).toString('base64url'),
    });
    process.env['WEBHOOK_URL_POLICY_MODE'] = 'development';

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
    merchantAccess = app.get(MerchantAccessService);
    webhooks = app.get(WebhookEndpointService);
  }, 120_000);

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
    if (postgres !== undefined) {
      await postgres.stop();
    }
  }, 120_000);

  async function issueKey(
    scopes: readonly ('webhooks:manage' | 'webhooks:read')[],
  ): Promise<Access> {
    if (database === undefined || merchantAccess === undefined) {
      throw new Error('Application services are unavailable');
    }
    sequence += 1;
    const merchant = await database.getClient().merchant.create({
      data: { code: `webhook-test-${String(sequence)}` },
    });
    const issued = await merchantAccess.issueApiKey({ merchantId: merchant.id, scopes });
    return {
      apiKeyId: issued.id,
      merchantId: merchant.id,
      plaintext: issued.plaintext,
    };
  }

  function createEndpoint(
    access: Access,
    path: string,
    requestId = `req_create_${String(sequence)}`,
    subscriptions: EndpointResponse['subscriptions'] = ['payment.created.v1'],
  ): Promise<Response> {
    return fetch(`${baseUrl}/v1/webhook-endpoints`, {
      body: JSON.stringify({
        subscriptions,
        url: `http://127.0.0.1:8080/${path}`,
      }),
      headers: {
        authorization: `Bearer ${access.plaintext}`,
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      method: 'POST',
    });
  }

  it('creates encrypted endpoint state and atomic audit while showing the secret once', async () => {
    if (database === undefined) {
      throw new Error('Database is unavailable');
    }
    const access = await issueKey(['webhooks:manage', 'webhooks:read']);
    const response = await createEndpoint(access, 'create-once', 'req_webhook_create', [
      'payment.refunded.v1',
      'payment.created.v1',
      'payment.captured.v1',
    ]);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('etag')).toMatch(/^"whe_[0-9A-HJKMNP-TV-Z]{26}\.v0"$/u);
    const created = (await response.json()) as EndpointResponse;
    expect(created).toMatchObject({
      status: 'active',
      subscriptions: ['payment.created.v1', 'payment.captured.v1', 'payment.refunded.v1'],
      url: 'http://127.0.0.1:8080/create-once',
      version: 0,
    });
    expect(created.id).toMatch(/^whe_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/u);

    const endpoint = await database.getClient().webhookEndpoint.findFirstOrThrow({
      include: { secrets: true, subscriptions: true },
      where: { merchantId: access.merchantId, publicId: created.id },
    });
    expect(endpoint.subscriptions.map((row) => row.eventType).sort()).toEqual([
      'payment.captured.v1',
      'payment.created.v1',
      'payment.refunded.v1',
    ]);
    expect(endpoint.secrets).toHaveLength(1);
    expect(endpoint.secrets[0]).toMatchObject({
      algorithm: 'aes-256-gcm',
      encryptionKeyId: 'integration-v1',
      lifecycle: 'CURRENT',
      secretVersion: 1,
    });
    expect(Buffer.from(endpoint.secrets[0]!.ciphertext).toString('utf8')).not.toContain('whsec_');
    expect(
      await database.getClient().auditEvent.findMany({ where: { merchantId: access.merchantId } }),
    ).toEqual([
      expect.objectContaining({
        action: 'webhook_endpoint.created',
        actorApiKeyId: access.apiKeyId,
        requestId: 'req_webhook_create',
        targetId: created.id,
      }),
    ]);

    const read = await fetch(`${baseUrl}/v1/webhook-endpoints/${created.id}`, {
      headers: { authorization: `Bearer ${access.plaintext}` },
    });
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody).not.toHaveProperty('secret');
    expect(readBody).not.toHaveProperty('encryptionKeyId');
  });

  it('uses descending keyset pagination with default/max bounds', async () => {
    const access = await issueKey(['webhooks:manage', 'webhooks:read']);
    for (const path of ['page-a', 'page-b', 'page-c']) {
      expect((await createEndpoint(access, path)).status).toBe(201);
    }
    const first = await fetch(`${baseUrl}/v1/webhook-endpoints?limit=2`, {
      headers: { authorization: `Bearer ${access.plaintext}` },
    });
    const firstBody = (await first.json()) as {
      readonly data: readonly EndpointResponse[];
      readonly nextCursor: string;
    };
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.data[0]!.id > firstBody.data[1]!.id).toBe(true);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await fetch(
      `${baseUrl}/v1/webhook-endpoints?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      { headers: { authorization: `Bearer ${access.plaintext}` } },
    );
    const secondBody = (await second.json()) as {
      readonly data: readonly EndpointResponse[];
      readonly nextCursor: null;
    };
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();
    expect(new Set([...firstBody.data, ...secondBody.data].map((item) => item.id)).size).toBe(3);

    const invalid = await fetch(`${baseUrl}/v1/webhook-endpoints?limit=101`, {
      headers: { authorization: `Bearer ${access.plaintext}` },
    });
    expect(invalid.status).toBe(400);
  });

  it('implements no-op PATCH, single-winner ETags, inactive rotation, and 24-hour overlap', async () => {
    if (database === undefined) {
      throw new Error('Database is unavailable');
    }
    const access = await issueKey(['webhooks:manage', 'webhooks:read']);
    const createdResponse = await createEndpoint(access, 'lifecycle');
    const created = (await createdResponse.json()) as EndpointResponse;
    const initialEtag = createdResponse.headers.get('etag')!;
    const initialAuditCount = await database.getClient().auditEvent.count({
      where: { merchantId: access.merchantId },
    });

    const missingPrecondition = await fetch(`${baseUrl}/v1/webhook-endpoints/${created.id}`, {
      body: JSON.stringify({ status: 'inactive' }),
      headers: {
        authorization: `Bearer ${access.plaintext}`,
        'content-type': 'application/json',
      },
      method: 'PATCH',
    });
    expect(missingPrecondition.status).toBe(428);
    expect(missingPrecondition.headers.get('content-type')).toContain('application/problem+json');
    await expect(missingPrecondition.json()).resolves.toMatchObject({
      code: 'precondition_required',
      status: 428,
    });

    const noOp = await fetch(`${baseUrl}/v1/webhook-endpoints/${created.id}`, {
      body: JSON.stringify({ status: 'active', subscriptions: ['payment.created.v1'] }),
      headers: {
        authorization: `Bearer ${access.plaintext}`,
        'content-type': 'application/json',
        'if-match': initialEtag,
      },
      method: 'PATCH',
    });
    expect(noOp.status).toBe(200);
    expect(noOp.headers.get('etag')).toBe(initialEtag);
    expect(
      await database.getClient().auditEvent.count({ where: { merchantId: access.merchantId } }),
    ).toBe(initialAuditCount);

    const concurrent = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetch(`${baseUrl}/v1/webhook-endpoints/${created.id}`, {
          body: JSON.stringify({ status: 'inactive' }),
          headers: {
            authorization: `Bearer ${access.plaintext}`,
            'content-type': 'application/json',
            'if-match': initialEtag,
          },
          method: 'PATCH',
        }),
      ),
    );
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 412]);
    const winner = concurrent.find((response) => response.status === 200)!;
    const stale = concurrent.find((response) => response.status === 412)!;
    await expect(stale.json()).resolves.toMatchObject({
      code: 'precondition_failed',
      status: 412,
    });
    expect((await winner.json()) as EndpointResponse).toMatchObject({
      status: 'inactive',
      version: 1,
    });
    const inactiveEtag = winner.headers.get('etag')!;

    const beforeRotation = Date.now();
    const rotation = await fetch(`${baseUrl}/v1/webhook-endpoints/${created.id}/secret-rotations`, {
      headers: { authorization: `Bearer ${access.plaintext}`, 'if-match': inactiveEtag },
      method: 'POST',
    });
    expect(rotation.status).toBe(200);
    expect(rotation.headers.get('cache-control')).toBe('no-store');
    const rotated = (await rotation.json()) as {
      readonly previousSecretExpiresAt: string;
      readonly secret: string;
      readonly version: number;
    };
    expect(rotated.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/u);
    expect(rotated.version).toBe(2);
    const overlap = new Date(rotated.previousSecretExpiresAt).getTime() - beforeRotation;
    expect(overlap).toBeGreaterThanOrEqual(24 * 60 * 60 * 1_000 - 2_000);
    expect(overlap).toBeLessThanOrEqual(24 * 60 * 60 * 1_000 + 2_000);

    const endpoint = await database.getClient().webhookEndpoint.findFirstOrThrow({
      include: { secrets: { orderBy: { secretVersion: 'asc' } } },
      where: { merchantId: access.merchantId, publicId: created.id },
    });
    expect(endpoint.status).toBe('INACTIVE');
    expect(endpoint.version).toBe(2);
    expect(endpoint.secrets.map((row) => row.lifecycle)).toEqual(['PREVIOUS', 'CURRENT']);
    expect(endpoint.secrets[0]?.overlapExpiresAt?.toISOString()).toBe(
      rotated.previousSecretExpiresAt,
    );
    expect(
      await database.getClient().auditEvent.findMany({
        orderBy: { occurredAt: 'asc' },
        select: { action: true, requestId: true },
        where: { merchantId: access.merchantId },
      }),
    ).toEqual([
      expect.objectContaining({ action: 'webhook_endpoint.created' }),
      expect.objectContaining({ action: 'webhook_endpoint.status_changed' }),
      expect.objectContaining({ action: 'webhook_endpoint.secret_rotated' }),
    ]);
  });

  it('enforces tenant/scope isolation, normalized uniqueness, and safe URL problems', async () => {
    const owner = await issueKey(['webhooks:manage', 'webhooks:read']);
    const other = await issueKey(['webhooks:read']);
    const manageOnly = await issueKey(['webhooks:manage']);
    const createdResponse = await createEndpoint(owner, 'tenant');
    const created = (await createdResponse.json()) as EndpointResponse;

    const foreign = await fetch(`${baseUrl}/v1/webhook-endpoints/${created.id}`, {
      headers: { authorization: `Bearer ${other.plaintext}` },
    });
    const missing = await fetch(`${baseUrl}/v1/webhook-endpoints/whe_01ARZ3NDEKTSV4RRFFQ69G5FAA`, {
      headers: { authorization: `Bearer ${owner.plaintext}` },
    });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    await expect(foreign.json()).resolves.toMatchObject({ code: 'webhook_endpoint_not_found' });
    await expect(missing.json()).resolves.toMatchObject({ code: 'webhook_endpoint_not_found' });

    const readForbidden = await fetch(`${baseUrl}/v1/webhook-endpoints/${created.id}`, {
      headers: { authorization: `Bearer ${manageOnly.plaintext}` },
    });
    const writeForbidden = await createEndpoint(other, 'scope-denied');
    expect(readForbidden.status).toBe(403);
    expect(writeForbidden.status).toBe(403);

    const canonicalOwner = await issueKey(['webhooks:manage']);
    const first = await createEndpoint(canonicalOwner, '');
    expect(first.status).toBe(201);
    const conflict = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
      body: JSON.stringify({
        subscriptions: ['payment.created.v1'],
        url: 'http://127.0.0.1:8080/',
      }),
      headers: {
        authorization: `Bearer ${canonicalOwner.plaintext}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: 'webhook_endpoint_url_conflict' });

    const prohibited = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
      body: JSON.stringify({
        subscriptions: ['payment.created.v1'],
        url: 'http://127.0.0.1:8081/internal',
      }),
      headers: {
        authorization: `Bearer ${owner.plaintext}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(prohibited.status).toBe(422);
    const problem = (await prohibited.json()) as Record<string, unknown>;
    expect(problem).toMatchObject({ code: 'webhook_endpoint_url_prohibited', status: 422 });
    expect(JSON.stringify(problem)).not.toContain('127.0.0.1');
  });

  it('enforces non-owner runtime and append-only audit database controls', async () => {
    if (database === undefined || postgres === undefined) {
      throw new Error('Dependencies are unavailable');
    }
    const currentUser = await database.getClient().$queryRaw<{ currentUser: string }[]>`
      SELECT current_user AS "currentUser"
    `;
    expect(currentUser).toEqual([{ currentUser: 'settleflow_app' }]);
    await expect(
      database.getClient().$executeRawUnsafe('CREATE TABLE forbidden_runtime_ddl(id int)'),
    ).rejects.toThrow();
    await expect(
      database.getClient().$executeRawUnsafe('UPDATE audit_events SET reason = reason'),
    ).rejects.toThrow();
    await expect(
      database.getClient().$executeRawUnsafe('DELETE FROM audit_events'),
    ).rejects.toThrow();
    await expect(database.getClient().$executeRawUnsafe('TRUNCATE audit_events')).rejects.toThrow();

    const ownerMutation = await postgres.exec([
      'psql',
      '--username',
      postgres.getUsername(),
      '--dbname',
      postgres.getDatabase(),
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      'UPDATE audit_events SET reason = reason;',
    ]);
    expect(ownerMutation.exitCode).not.toBe(0);
    expect(ownerMutation.stderr).toContain('audit events are append-only');
  });

  it('makes subscription/current-secret constraints and lifecycle audit atomic', async () => {
    if (database === undefined || webhooks === undefined) {
      throw new Error('Application services are unavailable');
    }
    const access = await issueKey(['webhooks:manage']);
    const createdResponse = await createEndpoint(access, 'constraint-boundary');
    const created = (await createdResponse.json()) as EndpointResponse;
    const endpoint = await database.getClient().webhookEndpoint.findFirstOrThrow({
      include: { secrets: true, subscriptions: true },
      where: { merchantId: access.merchantId, publicId: created.id },
    });

    await expect(
      database.getClient().$transaction((transaction) =>
        transaction.webhookEndpointSubscription.deleteMany({
          where: { endpointId: endpoint.id },
        }),
      ),
    ).rejects.toThrow();
    expect(
      await database.getClient().webhookEndpointSubscription.count({
        where: { endpointId: endpoint.id },
      }),
    ).toBe(1);

    const current = endpoint.secrets[0]!;
    await expect(
      database.getClient().webhookEndpointSecret.create({
        data: {
          algorithm: current.algorithm,
          authenticationTag: current.authenticationTag,
          ciphertext: current.ciphertext,
          encryptionKeyId: current.encryptionKeyId,
          endpointId: endpoint.id,
          id: randomUUID(),
          lifecycle: 'CURRENT',
          nonce: current.nonce,
          secretVersion: current.secretVersion + 1,
        },
      }),
    ).rejects.toThrow();

    const endpointCountBefore = await database.getClient().webhookEndpoint.count({
      where: { merchantId: access.merchantId },
    });
    await expect(
      webhooks.create({
        actorApiKeyId: randomUUID(),
        merchantId: access.merchantId,
        requestId: 'req_missing_audit_actor',
        subscriptions: ['payment.created.v1'],
        url: 'http://127.0.0.1:8080/audit-rollback',
      }),
    ).rejects.toThrow();
    expect(
      await database.getClient().webhookEndpoint.count({
        where: { merchantId: access.merchantId },
      }),
    ).toBe(endpointCountBefore);
  });

  it('publishes the exact OpenAPI route, scope, ETag, pagination, and problem contract', async () => {
    const response = await fetch(`${baseUrl}/docs/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      readonly paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const collection = document.paths['/v1/webhook-endpoints'];
    const member = document.paths['/v1/webhook-endpoints/{id}'];
    const rotation = document.paths['/v1/webhook-endpoints/{id}/secret-rotations'];
    expect(collection?.['post']?.['x-required-scopes']).toEqual(['webhooks:manage']);
    expect(collection?.['get']?.['x-required-scopes']).toEqual(['webhooks:read']);
    expect(member?.['get']?.['x-required-scopes']).toEqual(['webhooks:read']);
    expect(member?.['patch']?.['x-required-scopes']).toEqual(['webhooks:manage']);
    expect(rotation?.['post']?.['x-required-scopes']).toEqual(['webhooks:manage']);
    expect(member?.['patch']?.['responses']).toHaveProperty('428');
    expect(member?.['patch']?.['responses']).toHaveProperty('412');
  });
});
