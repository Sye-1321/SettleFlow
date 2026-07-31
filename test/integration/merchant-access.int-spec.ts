import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaDatabase } from '@settleflow/infrastructure';
import { ApiKeyUnavailableError, MerchantAccessService } from '@settleflow/merchant-access';

import { configureOpenApi } from '../../apps/api/src/openapi';

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
        env: { ...process.env, DATABASE_URL: databaseUrl },
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

describe('Merchant Access with real PostgreSQL and HTTP', () => {
  let app: INestApplication | undefined;
  let baseUrl = '';
  let database: PrismaDatabase | undefined;
  let merchantAccess: MerchantAccessService | undefined;
  let postgres: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('settleflow_merchant_access_test')
      .withUsername('settleflow_merchant_access_test')
      .withPassword('settleflow_merchant_access_test_only')
      .start();
    await deployMigrations(postgres.getConnectionUri());

    process.env['API_HOST'] = '127.0.0.1';
    process.env['API_PORT'] = '3000';
    process.env['DATABASE_URL'] = postgres.getConnectionUri();
    process.env['DEPENDENCY_READINESS_TIMEOUT_MS'] = '250';
    process.env['NODE_ENV'] = 'test';
    process.env['RABBITMQ_URL'] = 'amqp://unavailable:unavailable@127.0.0.1:1/unavailable';

    const { AppModule } = await import('../../apps/api/src/app.module.js');
    app = await NestFactory.create(AppModule, { abortOnError: false, logger: false });
    configureOpenApi(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    database = app.get(PrismaDatabase);
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

  async function createMerchant(code: string): Promise<string> {
    if (database === undefined) {
      throw new Error('Database is unavailable');
    }
    const merchant = await database.getClient().merchant.create({ data: { code } });
    return merchant.id;
  }

  it('keeps health and documentation public while protecting the API entrypoint', async () => {
    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);
    const openApi = await fetch(`${baseUrl}/docs/openapi.json`);
    const missing = await fetch(`${baseUrl}/api/v1`);
    const wrong = await fetch(`${baseUrl}/api/v1`, {
      headers: {
        authorization: `Bearer sf_test_${'a'.repeat(12)}.${'a'.repeat(43)}`,
      },
    });

    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
    expect(openApi.status).toBe(200);
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    await expect(missing.json()).resolves.toEqual(await wrong.json());

    const document = (await openApi.json()) as {
      readonly components?: { readonly securitySchemes?: Record<string, unknown> };
      readonly paths: Record<string, { readonly get?: { readonly security?: unknown } }>;
    };
    expect(document.components?.securitySchemes).toHaveProperty('merchantApiKey');
    expect(document.paths['/api/v1']?.get?.security).toEqual([{ merchantApiKey: [] }]);
    expect(document.paths['/health/live']?.get?.security).toBeUndefined();
  });

  it('authenticates the owning merchant while persisting no plaintext secret', async () => {
    if (database === undefined || merchantAccess === undefined) {
      throw new Error('Application services are unavailable');
    }
    const merchantId = await createMerchant('merchant-auth');
    const issued = await merchantAccess.issueApiKey({
      merchantId,
      scopes: ['payments:read'],
    });

    const stored = await database.getClient().apiKey.findUniqueOrThrow({
      where: { id: issued.id },
    });
    expect(stored.prefix).toBe(issued.prefix);
    expect(stored.secretHash).not.toContain(issued.plaintext);
    expect(JSON.stringify(stored)).not.toContain(issued.plaintext);

    await expect(merchantAccess.authenticate(issued.plaintext)).resolves.toEqual({
      apiKeyId: issued.id,
      merchantId,
      scopes: ['payments:read'],
    });
    const response = await fetch(`${baseUrl}/api/v1`, {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: 'settleflow-api',
      status: 'available',
      version: 'v1',
    });
  });

  it('fails closed after key disablement, revocation, rotation, or merchant disablement', async () => {
    if (database === undefined || merchantAccess === undefined) {
      throw new Error('Application services are unavailable');
    }
    const merchantId = await createMerchant('merchant-lifecycle');

    const disabled = await merchantAccess.issueApiKey({ merchantId, scopes: ['ledger:read'] });
    await expect(merchantAccess.disableApiKey(disabled.id)).resolves.toBe(true);
    await expect(merchantAccess.authenticate(disabled.plaintext)).resolves.toBeUndefined();

    const revoked = await merchantAccess.issueApiKey({ merchantId, scopes: ['ledger:read'] });
    await expect(merchantAccess.revokeApiKey(revoked.id)).resolves.toBe(true);
    await expect(merchantAccess.authenticate(revoked.plaintext)).resolves.toBeUndefined();

    const original = await merchantAccess.issueApiKey({ merchantId, scopes: ['ledger:read'] });
    const replacement = await merchantAccess.rotateApiKey({ apiKeyId: original.id });
    await expect(merchantAccess.authenticate(original.plaintext)).resolves.toBeUndefined();
    await expect(merchantAccess.authenticate(replacement.plaintext)).resolves.toMatchObject({
      apiKeyId: replacement.id,
      merchantId,
    });

    await database.getClient().merchant.update({
      data: { status: 'DISABLED' },
      where: { id: merchantId },
    });
    await expect(merchantAccess.authenticate(replacement.plaintext)).resolves.toBeUndefined();
  });

  it('allows exactly one concurrent rotation winner', async () => {
    if (database === undefined || merchantAccess === undefined) {
      throw new Error('Application services are unavailable');
    }
    const merchantId = await createMerchant('merchant-rotation-race');
    const original = await merchantAccess.issueApiKey({
      merchantId,
      scopes: ['webhooks:read'],
    });

    const outcomes = await Promise.allSettled([
      merchantAccess.rotateApiKey({ apiKeyId: original.id }),
      merchantAccess.rotateApiKey({ apiKeyId: original.id }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(ApiKeyUnavailableError);
    }

    const activeKeys = await database.getClient().apiKey.count({
      where: { merchantId, status: 'ACTIVE' },
    });
    expect(activeKeys).toBe(1);
  });

  it('enforces the closed scope vocabulary and state checks in PostgreSQL', async () => {
    if (database === undefined) {
      throw new Error('Database is unavailable');
    }
    const merchantId = await createMerchant('merchant-db-checks');
    await expect(
      database.getClient().$executeRawUnsafe(
        `INSERT INTO api_keys (id, merchant_id, prefix, secret_hash, scopes)
         VALUES (gen_random_uuid(), $1::uuid, 'sf_test_abcdefghijkl',
           'scrypt:v1:16384:8:1:aaaaaaaaaaaaaaaaaaaaaa:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           ARRAY['unsupported:scope'])`,
        merchantId,
      ),
    ).rejects.toThrow();
    await expect(
      database.getClient().$executeRawUnsafe(
        `INSERT INTO api_keys (id, merchant_id, prefix, secret_hash, scopes)
         VALUES (gen_random_uuid(), $1::uuid, 'sf_test_abcdefghijkm',
           'scrypt:v1:16384:8:1:aaaaaaaaaaaaaaaaaaaaaa:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           ARRAY[]::text[])`,
        merchantId,
      ),
    ).rejects.toThrow();
    await expect(
      database.getClient().$executeRawUnsafe(
        `INSERT INTO api_keys (id, merchant_id, prefix, secret_hash, scopes, status)
         VALUES (gen_random_uuid(), $1::uuid, 'sf_test_abcdefghijkn',
           'scrypt:v1:16384:8:1:aaaaaaaaaaaaaaaaaaaaaa:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           ARRAY['payments:read'], 'revoked')`,
        merchantId,
      ),
    ).rejects.toThrow();
  });
});
