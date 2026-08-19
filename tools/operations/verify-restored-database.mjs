import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

const REQUIRED_TRIGGERS = [
  'audit_events_reject_truncate_trigger',
  'audit_events_reject_update_delete_trigger',
  'ledger_accounts_reject_truncate_trigger',
  'ledger_accounts_reject_update_delete_trigger',
  'ledger_entries_guard_insert_trigger',
  'ledger_entries_integrity_trigger',
  'ledger_entries_reject_truncate_trigger',
  'ledger_entries_reject_update_delete_trigger',
  'ledger_transactions_guard_mutation_trigger',
  'ledger_transactions_integrity_trigger',
  'ledger_transactions_reject_truncate_trigger',
  'reconciliation_imports_guard_update_delete',
  'reconciliation_imports_reject_truncate',
  'reconciliation_provider_rows_reject_mutation',
  'reconciliation_provider_rows_reject_truncate',
  'reconciliation_results_reject_mutation',
  'reconciliation_results_reject_truncate',
  'reconciliation_summaries_reject_mutation',
  'reconciliation_summaries_reject_truncate',
  'settlement_adjustments_batch_integrity_trigger',
  'settlement_adjustments_guard_update_delete',
  'settlement_adjustments_reject_truncate',
  'settlement_batch_items_integrity_trigger',
  'settlement_batch_items_reject_mutation',
  'settlement_batch_items_reject_truncate',
  'settlement_batches_guard_update_delete',
  'settlement_batches_integrity_trigger',
  'settlement_batches_reject_truncate',
  'webhook_delivery_attempts_reject_truncate_trigger',
  'webhook_delivery_attempts_reject_update_delete_trigger',
  'webhook_endpoints_current_secret_required_trigger',
  'webhook_endpoints_subscription_required_trigger',
];

const REQUIRED_INDEXES = [
  'ledger_accounts_merchant_id_code_currency_key',
  'ledger_transactions_merchant_id_business_type_reference_key',
  'settlement_batch_items_payment_intent_id_key',
  'settlement_batch_items_position_id_key',
  'webhook_deliveries_endpoint_id_event_id_key',
  'webhook_endpoints_merchant_id_normalized_url_key',
];

const REQUIRED_CONSTRAINTS = [
  'audit_events_action_check',
  'ledger_entries_amount_minor_range_check',
  'ledger_transactions_reversal_shape_check',
  'settlement_batches_money_check',
  'settlement_positions_amounts_check',
  'webhook_endpoints_public_id_format_check',
];

const DEFERRED_TRIGGERS = [
  'ledger_entries_integrity_trigger',
  'ledger_transactions_integrity_trigger',
  'settlement_adjustments_batch_integrity_trigger',
  'settlement_batch_items_integrity_trigger',
  'settlement_batches_integrity_trigger',
  'webhook_endpoints_current_secret_required_trigger',
  'webhook_endpoints_subscription_required_trigger',
];

function requiredEnvironment(name, expected) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name}_required`);
  if (expected !== undefined && value !== expected) throw new Error(`${name}_invalid`);
  return value;
}

export function expectedMigrations(root) {
  return readdirSync(resolve(root, 'prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export const verificationQueries = Object.freeze({
  asynchronousEvidence: `
    SELECT
      (SELECT count(*) FROM webhook_deliveries d
         LEFT JOIN webhook_event_projections p ON p.event_id = d.event_id
         WHERE p.event_id IS NULL OR p.merchant_id <> d.merchant_id)
      + (SELECT count(*) FROM inbox_messages i
         LEFT JOIN webhook_event_projections p ON p.event_id = i.message_id
         WHERE i.consumer_name LIKE 'webhook-projection.%'
           AND (p.event_id IS NULL OR p.payload_sha256 <> i.payload_sha256))
      + (SELECT count(*) FROM webhook_delivery_attempts a
         LEFT JOIN webhook_deliveries d ON d.id = a.delivery_id
         WHERE d.id IS NULL)
      AS violations`,
  chart: `
    WITH expected AS (
      SELECT m.id AS merchant_id, c.currency, a.code, a.normal_side
      FROM merchants m
      CROSS JOIN (VALUES ('ETB'::char(3)), ('USD'::char(3))) c(currency)
      CROSS JOIN (VALUES
        ('provider_clearing'::varchar(64), 'debit'::ledger_entry_side),
        ('merchant_payable'::varchar(64), 'credit'::ledger_entry_side),
        ('fee_revenue'::varchar(64), 'credit'::ledger_entry_side),
        ('settlement_clearing'::varchar(64), 'credit'::ledger_entry_side)
      ) a(code, normal_side)
    )
    SELECT
      (SELECT count(*) FROM expected e LEFT JOIN ledger_accounts a
        ON a.merchant_id = e.merchant_id AND a.currency = e.currency
       AND a.code = e.code AND a.normal_side = e.normal_side WHERE a.id IS NULL)
      + (SELECT count(*) FROM ledger_accounts a LEFT JOIN expected e
        ON a.merchant_id = e.merchant_id AND a.currency = e.currency
       AND a.code = e.code AND a.normal_side = e.normal_side WHERE e.merchant_id IS NULL)
      AS violations`,
  ledger: `
    WITH totals AS (
      SELECT t.id, t.merchant_id, t.currency, t.posted_at,
             count(e.id) AS entry_count,
             count(DISTINCT e.currency) AS currencies,
             coalesce(sum(e.amount_minor) FILTER (WHERE e.side = 'debit'), 0) AS debits,
             coalesce(sum(e.amount_minor) FILTER (WHERE e.side = 'credit'), 0) AS credits,
             count(*) FILTER (WHERE e.merchant_id <> t.merchant_id OR e.currency <> t.currency
               OR a.id IS NULL OR a.merchant_id <> t.merchant_id OR a.currency <> t.currency) AS ownership_errors
      FROM ledger_transactions t
      LEFT JOIN ledger_entries e ON e.ledger_transaction_id = t.id
      LEFT JOIN ledger_accounts a ON a.id = e.account_id
      GROUP BY t.id
    )
    SELECT count(*) AS violations FROM totals
    WHERE posted_at IS NULL OR entry_count < 2 OR currencies <> 1
       OR debits <> credits OR ownership_errors <> 0`,
  paymentAndSettlement: `
    WITH refund_totals AS (
      SELECT p.id, p.refunded_amount_minor, coalesce(sum(r.amount_minor), 0) AS recorded
      FROM payment_intents p LEFT JOIN refunds r ON r.payment_intent_id = p.id GROUP BY p.id
    ), item_totals AS (
      SELECT b.id, count(i.id) AS item_count, coalesce(sum(i.gross_minor), 0) AS payment_gross,
             coalesce(sum(i.fee_minor), 0) AS fee_total
      FROM settlement_batches b LEFT JOIN settlement_batch_items i ON i.batch_id = b.id GROUP BY b.id
    ), adjustment_totals AS (
      SELECT b.id, count(a.id) AS adjustment_count, coalesce(sum(a.amount_minor), 0) AS adjustment_total
      FROM settlement_batches b LEFT JOIN settlement_adjustments a ON a.batch_id = b.id GROUP BY b.id
    )
    SELECT
      (SELECT count(*) FROM payment_intents
       WHERE captured_amount_minor > amount_minor OR refunded_amount_minor > captured_amount_minor)
      + (SELECT count(*) FROM refund_totals WHERE refunded_amount_minor <> recorded)
      + (SELECT count(*) FROM settlement_positions
         WHERE captured_amount_minor < refunded_amount_minor)
      + (SELECT count(*) FROM settlement_batches b
         JOIN item_totals i ON i.id = b.id JOIN adjustment_totals a ON a.id = b.id
         LEFT JOIN ledger_transactions l ON l.id = b.ledger_transaction_id
         WHERE b.item_count <> i.item_count OR b.adjustment_count <> a.adjustment_count
            OR b.payment_gross_minor <> i.payment_gross
            OR b.adjustment_minor <> a.adjustment_total
            OR b.gross_minor <> i.payment_gross - a.adjustment_total
            OR b.fee_minor <> i.fee_total OR b.net_minor <> b.gross_minor - b.fee_minor
            OR l.id IS NULL OR l.business_type <> 'settlement' OR l.posted_at IS NULL
            OR l.merchant_id <> b.merchant_id OR l.currency <> b.currency)
      AS violations`,
  reconciliation: `
    WITH result_totals AS (
      SELECT i.id AS import_id, c.currency,
        count(r.id) FILTER (WHERE r.bucket = 'matched_exact') AS matched_exact_count,
        count(r.id) FILTER (WHERE r.bucket = 'provider_only') AS provider_only_count,
        count(r.id) FILTER (WHERE r.bucket = 'platform_only') AS platform_only_count,
        count(r.id) FILTER (WHERE r.bucket = 'currency_mismatch') AS currency_mismatch_count,
        count(r.id) FILTER (WHERE r.bucket = 'amount_mismatch') AS amount_mismatch_count,
        count(r.id) FILTER (WHERE r.bucket = 'status_mismatch') AS status_mismatch_count,
        count(r.id) FILTER (WHERE r.bucket = 'duplicate_provider_row') AS duplicate_provider_row_count,
        coalesce(sum(r.provider_gross_minor), 0) AS provider_gross_minor,
        coalesce(sum(r.provider_fee_minor), 0) AS provider_fee_minor,
        coalesce(sum(r.provider_net_minor), 0) AS provider_net_minor,
        coalesce(sum(r.platform_gross_minor), 0) AS platform_gross_minor,
        coalesce(sum(r.platform_fee_minor), 0) AS platform_fee_minor,
        coalesce(sum(r.platform_net_minor), 0) AS platform_net_minor
      FROM reconciliation_imports i
      CROSS JOIN (VALUES ('ETB'::char(3)), ('USD'::char(3))) c(currency)
      LEFT JOIN reconciliation_results r ON r.import_id = i.id AND r.currency = c.currency
      WHERE i.status = 'completed'
      GROUP BY i.id, c.currency
    )
    SELECT
      (SELECT count(*) FROM reconciliation_imports i
       WHERE (i.status = 'completed') <> EXISTS (
         SELECT 1 FROM reconciliation_summaries s WHERE s.import_id = i.id))
      + (SELECT count(*) FROM result_totals r
         LEFT JOIN reconciliation_summaries s
           ON s.import_id = r.import_id AND s.currency = r.currency
         WHERE s.import_id IS NULL OR s.matched_exact_count <> r.matched_exact_count
            OR s.provider_only_count <> r.provider_only_count
            OR s.platform_only_count <> r.platform_only_count
            OR s.currency_mismatch_count <> r.currency_mismatch_count
            OR s.amount_mismatch_count <> r.amount_mismatch_count
            OR s.status_mismatch_count <> r.status_mismatch_count
            OR s.duplicate_provider_row_count <> r.duplicate_provider_row_count
            OR s.provider_gross_minor <> r.provider_gross_minor
            OR s.provider_fee_minor <> r.provider_fee_minor
            OR s.provider_net_minor <> r.provider_net_minor
            OR s.platform_gross_minor <> r.platform_gross_minor
            OR s.platform_fee_minor <> r.platform_fee_minor
            OR s.platform_net_minor <> r.platform_net_minor
            OR s.unexplained_difference_minor <> r.provider_net_minor - r.platform_net_minor)
      AS violations`,
  runtimePermissions: `
    WITH expected(table_name, privilege_type) AS (VALUES
      ('api_keys', 'INSERT'), ('api_keys', 'SELECT'), ('api_keys', 'UPDATE'),
      ('audit_events', 'INSERT'), ('audit_events', 'SELECT'),
      ('idempotency_keys', 'INSERT'), ('idempotency_keys', 'SELECT'), ('idempotency_keys', 'UPDATE'),
      ('inbox_messages', 'INSERT'), ('inbox_messages', 'SELECT'),
      ('ledger_accounts', 'INSERT'), ('ledger_accounts', 'SELECT'),
      ('ledger_entries', 'INSERT'), ('ledger_entries', 'SELECT'),
      ('ledger_transactions', 'INSERT'), ('ledger_transactions', 'SELECT'), ('ledger_transactions', 'UPDATE'),
      ('merchants', 'INSERT'), ('merchants', 'SELECT'), ('merchants', 'UPDATE'),
      ('outbox_events', 'INSERT'), ('outbox_events', 'SELECT'), ('outbox_events', 'UPDATE'),
      ('payment_intents', 'INSERT'), ('payment_intents', 'SELECT'), ('payment_intents', 'UPDATE'),
      ('reconciliation_imports', 'INSERT'), ('reconciliation_imports', 'SELECT'), ('reconciliation_imports', 'UPDATE'),
      ('reconciliation_provider_rows', 'INSERT'), ('reconciliation_provider_rows', 'SELECT'),
      ('reconciliation_results', 'INSERT'), ('reconciliation_results', 'SELECT'),
      ('reconciliation_summaries', 'INSERT'), ('reconciliation_summaries', 'SELECT'),
      ('refunds', 'INSERT'), ('refunds', 'SELECT'),
      ('settlement_adjustments', 'INSERT'), ('settlement_adjustments', 'SELECT'), ('settlement_adjustments', 'UPDATE'),
      ('settlement_batch_items', 'INSERT'), ('settlement_batch_items', 'SELECT'),
      ('settlement_batches', 'INSERT'), ('settlement_batches', 'SELECT'), ('settlement_batches', 'UPDATE'),
      ('settlement_fee_policies', 'SELECT'),
      ('settlement_positions', 'INSERT'), ('settlement_positions', 'SELECT'), ('settlement_positions', 'UPDATE'),
      ('settlement_runs', 'INSERT'), ('settlement_runs', 'SELECT'),
      ('settlement_streams', 'INSERT'), ('settlement_streams', 'SELECT'), ('settlement_streams', 'UPDATE'),
      ('webhook_deliveries', 'INSERT'), ('webhook_deliveries', 'SELECT'), ('webhook_deliveries', 'UPDATE'),
      ('webhook_delivery_attempts', 'INSERT'), ('webhook_delivery_attempts', 'SELECT'),
      ('webhook_endpoint_secrets', 'INSERT'), ('webhook_endpoint_secrets', 'SELECT'), ('webhook_endpoint_secrets', 'UPDATE'),
      ('webhook_endpoint_subscriptions', 'DELETE'), ('webhook_endpoint_subscriptions', 'INSERT'),
      ('webhook_endpoint_subscriptions', 'SELECT'),
      ('webhook_endpoints', 'INSERT'), ('webhook_endpoints', 'SELECT'), ('webhook_endpoints', 'UPDATE'),
      ('webhook_event_projections', 'INSERT'), ('webhook_event_projections', 'SELECT')
    ), actual AS (
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'settleflow_app' AND table_schema = 'public'
    ), difference AS (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    )
    SELECT (SELECT count(*) FROM difference)
      + CASE WHEN has_schema_privilege('settleflow_app', 'public', 'CREATE') THEN 1 ELSE 0 END
      + CASE WHEN has_schema_privilege('settleflow_app', 'public', 'USAGE') THEN 0 ELSE 1 END
      + (SELECT count(*) FROM pg_roles WHERE rolname = 'settleflow_app'
         AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls))
      AS violations`,
});

export async function verifyRestoredDatabase(client, root) {
  const expected = expectedMigrations(root);
  const migrations = await client.query(
    'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
  );
  if (
    JSON.stringify(migrations.rows.map((row) => row.migration_name)) !== JSON.stringify(expected)
  ) {
    throw new Error('recovery_migration_history_invalid');
  }
  const triggers = await client.query(
    `SELECT tgname, tgdeferrable, tginitdeferred FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[])`,
    [REQUIRED_TRIGGERS],
  );
  const found = new Map(triggers.rows.map((row) => [row.tgname, row]));
  for (const name of REQUIRED_TRIGGERS) {
    const trigger = found.get(name);
    if (trigger === undefined) throw new Error('recovery_trigger_inventory_invalid');
    if (DEFERRED_TRIGGERS.includes(name) && (!trigger.tgdeferrable || !trigger.tginitdeferred)) {
      throw new Error('recovery_deferred_trigger_invalid');
    }
  }
  const indexes = await client.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])",
    [REQUIRED_INDEXES],
  );
  if (
    JSON.stringify(indexes.rows.map((row) => row.indexname).sort()) !==
    JSON.stringify([...REQUIRED_INDEXES].sort())
  ) {
    throw new Error('recovery_index_inventory_invalid');
  }
  const constraints = await client.query(
    'SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])',
    [REQUIRED_CONSTRAINTS],
  );
  if (
    JSON.stringify(constraints.rows.map((row) => row.conname).sort()) !==
    JSON.stringify([...REQUIRED_CONSTRAINTS].sort())
  ) {
    throw new Error('recovery_constraint_inventory_invalid');
  }
  const projectionPayloads = await client.query(
    'SELECT payload_bytes, payload_sha256 FROM webhook_event_projections',
  );
  for (const row of projectionPayloads.rows) {
    const actual = createHash('sha256').update(row.payload_bytes).digest();
    if (!actual.equals(row.payload_sha256)) {
      throw new Error('recovery_projection_payload_hash_invalid');
    }
  }
  for (const [name, sql] of Object.entries(verificationQueries)) {
    const result = await client.query(sql);
    if (String(result.rows[0]?.violations) !== '0') {
      throw new Error(`recovery_${name}_verification_failed`);
    }
  }
  return {
    checkCount: Object.keys(verificationQueries).length + 5,
    migrationCount: expected.length,
  };
}

async function main() {
  requiredEnvironment('SETTLEFLOW_RECOVERY_MODE', 'true');
  requiredEnvironment('POSTGRES_APP_USER', 'settleflow_app');
  requiredEnvironment('POSTGRES_DB', 'settleflow');
  const owner = requiredEnvironment('POSTGRES_USER');
  const databaseUrl = requiredEnvironment('MIGRATION_DATABASE_URL');
  const parsed = new URL(databaseUrl);
  if (
    parsed.username !== owner ||
    parsed.hostname !== 'postgres' ||
    decodeURIComponent(parsed.pathname.replace(/^\//u, '')) !== 'settleflow'
  ) {
    throw new Error('recovery_database_target_invalid');
  }
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const result = await verifyRestoredDatabase(client, process.cwd());
    process.stdout.write(
      `Restored database passed ${result.checkCount} recovery checks across ${result.migrationCount} migrations.\n`,
    );
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(
      `Recovery verification failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
    );
    process.exitCode = 1;
  });
}
