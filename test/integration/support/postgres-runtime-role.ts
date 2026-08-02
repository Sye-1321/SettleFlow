import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export const TEST_RUNTIME_ROLE = 'settleflow_app';
export const TEST_RUNTIME_PASSWORD = 'settleflow_app_test_only';

export async function provisionTestRuntimeRole(
  postgres: StartedPostgreSqlContainer,
): Promise<void> {
  const sql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_RUNTIME_ROLE}') THEN
        CREATE ROLE ${TEST_RUNTIME_ROLE} LOGIN PASSWORD '${TEST_RUNTIME_PASSWORD}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF;
    END
    $$;
    ALTER ROLE ${TEST_RUNTIME_ROLE} WITH LOGIN PASSWORD '${TEST_RUNTIME_PASSWORD}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT CONNECT ON DATABASE "${postgres.getDatabase()}" TO ${TEST_RUNTIME_ROLE};
    REVOKE CREATE ON SCHEMA public FROM ${TEST_RUNTIME_ROLE};
    GRANT USAGE ON SCHEMA public TO ${TEST_RUNTIME_ROLE};
  `;
  const result = await postgres.exec([
    'psql',
    '--username',
    postgres.getUsername(),
    '--dbname',
    postgres.getDatabase(),
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    sql,
  ]);
  if (result.exitCode !== 0) {
    throw new Error('Unable to provision the PostgreSQL runtime role for integration tests');
  }
}

export function testRuntimeDatabaseUrl(postgres: StartedPostgreSqlContainer): string {
  const url = new URL(postgres.getConnectionUri());
  url.username = TEST_RUNTIME_ROLE;
  url.password = TEST_RUNTIME_PASSWORD;
  return url.toString();
}
