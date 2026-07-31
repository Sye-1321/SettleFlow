import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaDatabase } from '@settleflow/infrastructure';

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
        env: { ...process.env, DATABASE_URL: databaseUrl },
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
  }, 120_000);

  afterAll(async () => {
    if (postgres !== undefined) {
      await postgres.stop();
    }
  }, 120_000);

  it('applies the empty migration history repeatedly without an application table', async () => {
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
    expect(tables.stdout.trim().split(/\r?\n/)).toEqual(['_prisma_migrations']);
    expect(appliedMigrations.exitCode).toBe(0);
    expect(appliedMigrations.stdout.trim()).toBe('1');
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
