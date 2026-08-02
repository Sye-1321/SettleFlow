# Ledger invariant failure and posting containment

## Purpose and trigger

Use this runbook when a named Ledger constraint/trigger rejects a posting, Ledger account provisioning is incomplete, a duplicate business reference or reversal conflict appears unexpectedly, a read-only invariant query finds a mismatch, or a future command path reports `ledger.post` rejection.

Treat a confirmed committed-data mismatch or evidence of mutation as a release-blocking financial incident. Environment-specific severity thresholds, incident system, communication owner, and paging destination are **To be decided** before capture/refund is enabled.

Required role: approved read-only database diagnostic access. Disabling a command path, changing a deployment, applying a forward migration, provisioning missing accounts, or authorizing a future reversal requires the environment's privileged operator/change role and an incident/change record. Those environment-specific identities are **To be decided**. Never use the migration owner as an application runtime identity.

## Safety rules

PostgreSQL Ledger rows are authoritative accounting evidence. Preserve the original request/public Ledger/event identifiers and database state.

Never:

- update, delete, resequence, replace, or truncate a Ledger account, transaction, or entry;
- set or clear `posted_at` manually, append an entry to a posted transaction, disable a Ledger trigger/constraint, or weaken a grant;
- retry only part of a failed financial transaction or treat a duplicate business reference as response replay;
- create an ad hoc offsetting posting, reversal, account, currency, or business type;
- patch a Payment Intent, idempotency snapshot, outbox row, audit event, settlement record, or webhook record to hide a mismatch;
- copy amounts, business references, API keys, credentials, connection URLs, entry bodies, raw SQL errors, or merchant-sensitive payloads into logs or tickets.

Corrections are new exact reversal transactions only after the command's privileged authorization, reason, idempotency, and atomic audit design is approved. This foundation exposes no operator reversal route.

## Diagnose

Record incident time, environment, deployed revision/migration, safe request ID, public `ltx_` identifier if available, bounded `ledger.post` outcome/error class, and the named database control. Correlate with the caller-owned Payment/idempotency/outbox identifiers without selecting their payloads.

For the local reference environment, first confirm the exact migration and runtime-role posture:

```shell
pnpm infra:ps
pnpm db:migrate:status
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at;"
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'settleflow_app' AND table_name LIKE 'ledger_%' ORDER BY table_name, privilege_type;"
```

Check account completeness without deriving balances or selecting merchant data beyond IDs/counts:

```shell
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT m.id AS merchant_id, count(a.id) AS account_count FROM merchants m LEFT JOIN ledger_accounts a ON a.merchant_id = m.id GROUP BY m.id HAVING count(a.id) <> 4 ORDER BY m.id;"
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT merchant_id FROM ledger_accounts GROUP BY merchant_id HAVING count(*) <> 4 OR count(*) FILTER (WHERE currency = 'ETB') <> 2 OR count(*) FILTER (WHERE currency = 'USD') <> 2 ORDER BY merchant_id;"
```

Run read-only integrity detectors that return identifiers, never entry bodies or amounts:

```shell
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT t.public_id FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.ledger_transaction_id = t.id GROUP BY t.id, t.public_id HAVING t.posted_at IS NULL OR count(e.id) < 2 OR coalesce(sum(e.amount_minor) FILTER (WHERE e.side = 'debit'), 0::numeric) <> coalesce(sum(e.amount_minor) FILTER (WHERE e.side = 'credit'), 0::numeric) ORDER BY t.public_id;"
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT DISTINCT t.public_id FROM ledger_transactions t JOIN ledger_entries e ON e.ledger_transaction_id = t.id JOIN ledger_accounts a ON a.id = e.account_id WHERE e.merchant_id <> t.merchant_id OR e.currency <> t.currency OR a.merchant_id <> t.merchant_id OR a.currency <> t.currency ORDER BY t.public_id;"
```

Expected output is zero rows. These queries are secondary incident detectors; successful output never replaces constraints/triggers or proves application atomicity by itself.

Interpretation:

- `accounts_not_provisioned`: no money command may proceed; confirm whether the merchant predates the migration or an authorized onboarding composition is missing.
- `ledger_transactions_balance_check`, minimum-count, currency/ownership, finalization, or reversal checks: treat as a code/migration defect; the whole caller transaction must have rolled back.
- business-reference/reversal unique conflict: confirm whether it is an expected concurrent loser; only Idempotency may replay a prior response.
- public-ID collision: the future coordinator may restart the whole transaction up to three times; repeated exhaustion is an incident.
- update/delete/truncate or late-entry rejection: determine what component attempted unauthorized mutation and disable it.
- a detector returning a committed public ID: stop all affected money command paths and escalate immediately.

## Contain and recover

1. Disable only the affected future capture/refund/reversal command path through the approved deployment control. The current Foundation is not composed into API/worker and requires no readiness change.
2. Preserve database, request/idempotency, outbox, and deployment evidence. Do not rerun or manually complete the failed statements.
3. Confirm through read-only queries that the rejected transaction left no partial Ledger or caller-owned effect. If atomicity is uncertain, keep the path disabled.
4. For missing accounts, use only the approved internal provisioning composition after its Merchant-onboarding/audit policy exists. Until then, escalate; do not insert rows manually.
5. Reproduce against a disposable restored copy with the same migrations and non-owner runtime role. Add a failing integration case before changing code or SQL.
6. Prepare a reviewed forward code/migration fix. Do not edit an already deployed migration file or downgrade by dropping controls after Ledger data exists.
7. If a committed accounting correction is required, wait for the separately authorized privileged reversal orchestration. The reversal must exactly invert the original and record the required audit/correlation evidence atomically.
8. Re-enable the command path only after all Ledger invariant, tenant, concurrency, permission, atomicity, migration, and regression gates pass.

## Validate and close

Before closure, prove:

- the account-completeness and integrity-detector queries return no rows;
- the migration history and runtime grants match [ADR-0020](../adr/0020-immutable-double-entry-ledger-foundation.md);
- the focused real-PostgreSQL Ledger suite passes, including upgrade/backfill, concurrent duplicate/reversal, rollback, immutability, and role tests;
- the full unit/integration/build/OpenAPI regression suite passes;
- no trigger/constraint/grant was disabled and no authoritative row was manually changed;
- affected commands, merchants, and customer impact are identified using safe IDs only; and
- root cause, approved recovery, reviewer evidence, timestamps, and follow-up work are recorded.

Escalate immediately if a committed mismatch exists, an invariant control is absent/disabled, the runtime role has unexpected mutation rights, rollback left a partial caller effect, a reversal differs from the original, a second reversal committed, or anyone changed/deleted evidence.

Owner: SettleFlow Ledger/Operations maintainers. Review cadence: after every Ledger schema, account, posting, reversal, permission, transaction-boundary, or recovery change and at least quarterly. Last exercised: 2026-08-02 through disposable PostgreSQL upgrade/backfill, failure, race, rollback, reversal, and permission integration tests; environment evidence link is **To be decided**.
