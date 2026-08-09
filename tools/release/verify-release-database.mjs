import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

import pg from 'pg';

const { Client } = pg;

function hasUnsafeControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function expectedMigrations(root) {
  return readdirSync(resolve(root, 'prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const invariantSql = `
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

const permissionSql = `
WITH role_violations AS (
  SELECT count(*) AS count FROM pg_roles
  WHERE rolname = 'settleflow_app'
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
), forbidden_privileges AS (
  SELECT count(*) AS count FROM (VALUES
    ('audit_events', 'UPDATE'), ('audit_events', 'DELETE'), ('audit_events', 'TRUNCATE'),
    ('ledger_accounts', 'UPDATE'), ('ledger_accounts', 'DELETE'), ('ledger_accounts', 'TRUNCATE'),
    ('ledger_entries', 'UPDATE'), ('ledger_entries', 'DELETE'), ('ledger_entries', 'TRUNCATE'),
    ('ledger_transactions', 'DELETE'), ('ledger_transactions', 'TRUNCATE'),
    ('refunds', 'UPDATE'), ('refunds', 'DELETE'), ('refunds', 'TRUNCATE'),
    ('webhook_delivery_attempts', 'UPDATE'), ('webhook_delivery_attempts', 'DELETE'), ('webhook_delivery_attempts', 'TRUNCATE')
  ) AS required(table_name, privilege)
  WHERE has_table_privilege('settleflow_app', required.table_name, required.privilege)
), required_privileges AS (
  SELECT count(*) AS count FROM (VALUES
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

function requireEnvironment(name, expected) {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || hasUnsafeControlCharacter(value)) {
    throw new Error(`${name} is required and must be safe`);
  }
  if (expected !== undefined && value !== expected) throw new Error(`${name} must be ${expected}`);
  return value;
}

const databaseUrl = requireEnvironment('MIGRATION_DATABASE_URL');
requireEnvironment('POSTGRES_DB', 'settleflow');
requireEnvironment('POSTGRES_APP_USER', 'settleflow_app');
const expectedOwner = requireEnvironment('POSTGRES_USER');
if (new URL(databaseUrl).username !== expectedOwner)
  throw new Error('Migration URL is not the declared owner');

const client = new Client({ connectionString: databaseUrl });
try {
  await client.connect();
  const migrations = await client.query(
    'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
  );
  const applied = migrations.rows.map((row) => row.migration_name);
  if (JSON.stringify(applied) !== JSON.stringify(expectedMigrations(process.cwd()))) {
    throw new Error('Applied migration history does not exactly match prisma/migrations');
  }
  for (const [label, sql] of [
    ['permission', permissionSql],
    ['financial invariant', invariantSql],
  ]) {
    const result = await client.query(sql);
    if (String(result.rows[0]?.violations) !== '0') throw new Error(`${label} verification failed`);
  }
  process.stdout.write(
    'Release database migration, permission, and invariant verification passed.\n',
  );
} finally {
  await client.end();
}
