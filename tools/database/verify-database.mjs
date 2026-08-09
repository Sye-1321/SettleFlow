import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MODES = new Set(['invariants', 'migrations', 'permissions']);

export function validateDatabaseTarget(environment) {
  const required = ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_APP_USER'];
  for (const name of required) {
    const value = environment[name];
    if (typeof value !== 'string' || value.length === 0 || hasControlCharacters(value)) {
      throw new Error(`${name} must be a nonempty value without control characters`);
    }
  }
  if (environment.POSTGRES_DB !== 'settleflow')
    throw new Error('POSTGRES_DB must be exactly settleflow');
  if (environment.POSTGRES_APP_USER !== 'settleflow_app') {
    throw new Error('POSTGRES_APP_USER must be exactly settleflow_app');
  }
  return {
    appUser: environment.POSTGRES_APP_USER,
    database: environment.POSTGRES_DB,
    owner: environment.POSTGRES_USER,
  };
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function invariantSql() {
  return `
WITH entry_totals AS (
  SELECT lt.id,
         count(le.id) AS entry_count,
         count(DISTINCT le.currency) AS currencies,
         coalesce(sum(le.amount_minor) FILTER (WHERE le.side = 'debit'), 0) AS debits,
         coalesce(sum(le.amount_minor) FILTER (WHERE le.side = 'credit'), 0) AS credits
  FROM ledger_transactions lt
  LEFT JOIN ledger_entries le ON le.ledger_transaction_id = lt.id
  WHERE lt.posted_at IS NOT NULL
  GROUP BY lt.id
), chart AS (
  SELECT merchant_id, currency, count(DISTINCT code) AS account_count
  FROM ledger_accounts
  GROUP BY merchant_id, currency
)
SELECT
  (SELECT count(*) FROM entry_totals WHERE entry_count < 2 OR currencies <> 1 OR debits <> credits)
  + (SELECT count(*) FROM chart WHERE account_count <> 4)
  + (SELECT count(*) FROM payment_intents WHERE captured_amount_minor > amount_minor OR refunded_amount_minor > captured_amount_minor)
  + (SELECT count(*) FROM settlement_positions WHERE captured_amount_minor < 0 OR refunded_amount_minor < 0 OR refunded_amount_minor > captured_amount_minor)
  AS violations;
`;
}

export function permissionSql() {
  return `
WITH role_violations AS (
  SELECT count(*) AS count
  FROM pg_roles
  WHERE rolname = 'settleflow_app'
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
), forbidden_privileges AS (
  SELECT count(*) AS count
  FROM (VALUES
    ('audit_events', 'UPDATE'), ('audit_events', 'DELETE'), ('audit_events', 'TRUNCATE'),
    ('ledger_accounts', 'UPDATE'), ('ledger_accounts', 'DELETE'), ('ledger_accounts', 'TRUNCATE'),
    ('ledger_entries', 'UPDATE'), ('ledger_entries', 'DELETE'), ('ledger_entries', 'TRUNCATE'),
    ('ledger_transactions', 'DELETE'), ('ledger_transactions', 'TRUNCATE'),
    ('refunds', 'UPDATE'), ('refunds', 'DELETE'), ('refunds', 'TRUNCATE'),
    ('webhook_delivery_attempts', 'UPDATE'), ('webhook_delivery_attempts', 'DELETE'), ('webhook_delivery_attempts', 'TRUNCATE')
  ) AS required(table_name, privilege)
  WHERE has_table_privilege('settleflow_app', required.table_name, required.privilege)
), required_privileges AS (
  SELECT count(*) AS count
  FROM (VALUES
    ('audit_events', 'SELECT'), ('audit_events', 'INSERT'),
    ('ledger_accounts', 'SELECT'), ('ledger_accounts', 'INSERT'),
    ('ledger_entries', 'SELECT'), ('ledger_entries', 'INSERT'),
    ('ledger_transactions', 'SELECT'), ('ledger_transactions', 'INSERT'),
    ('webhook_delivery_attempts', 'SELECT'), ('webhook_delivery_attempts', 'INSERT')
  ) AS required(table_name, privilege)
  WHERE NOT has_table_privilege('settleflow_app', required.table_name, required.privilege)
)
SELECT (SELECT count FROM role_violations)
     + (SELECT count FROM forbidden_privileges)
     + (SELECT count FROM required_privileges)
     + CASE WHEN has_schema_privilege('settleflow_app', 'public', 'CREATE') THEN 1 ELSE 0 END
     + CASE WHEN has_schema_privilege('settleflow_app', 'public', 'USAGE') THEN 0 ELSE 1 END
  AS violations;
`;
}

function psql(target, sql) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '--username',
      target.owner,
      '--dbname',
      target.database,
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      sql,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? 'Database verification failed.\n');
    process.exitCode = result.status ?? 1;
    return undefined;
  }
  return result.stdout.trim();
}

function verifyMigrations(root, target) {
  const expected = readdirSync(resolve(root, 'prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const output = psql(
    target,
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name;`,
  );
  if (output === undefined) return false;
  const applied = output.split(/\r?\n/u).filter(Boolean);
  if (JSON.stringify(expected) !== JSON.stringify(applied)) {
    process.stderr.write('Applied migration history does not exactly match prisma/migrations.\n');
    return false;
  }
  return true;
}

function verifyZero(target, sql, label) {
  const output = psql(target, sql);
  if (output !== '0') {
    process.stderr.write(`${label} verification reported ${output ?? 'an execution failure'}.\n`);
    return false;
  }
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2];
  if (mode === undefined || !MODES.has(mode))
    throw new Error('Expected mode: migrations, permissions, or invariants');
  const root = process.cwd();
  const environmentPath = resolve(root, '.env');
  if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);
  const target = validateDatabaseTarget(process.env);
  const passed =
    mode === 'migrations'
      ? verifyMigrations(root, target)
      : mode === 'permissions'
        ? verifyZero(target, permissionSql(), 'Permission')
        : verifyZero(target, invariantSql(), 'Financial invariant');
  if (!passed) process.exitCode = 1;
  else process.stdout.write(`Database ${mode} verification passed.\n`);
}
