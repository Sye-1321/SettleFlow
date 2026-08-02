# ADR-0020: Immutable double-entry ledger foundation

- **Status:** Accepted
- **Date:** 2026-08-02
- **Decision owners:** SettleFlow Project owner and Ledger owner
- **Reviewers:** Project owner through the Ledger Foundation acceptance milestone; architecture, PostgreSQL, financial-controls, and security review remain required for implementation
- **Supersedes:** None
- **Superseded by:** None

## Context

SettleFlow cannot safely implement capture, refund, settlement, correction, or reconciliation behavior without an authoritative accounting record. FR-06 requires an immutable balanced ledger transaction to be committed in the same PostgreSQL transaction as the corresponding domain state and outbox event. INV-01 through INV-06 require positive entries, at least two entries, balanced debits and credits, one transaction currency, immutable posted evidence, and reversal-only corrections.

The repository currently has Payment Intent, Idempotency, Eventing, Webhook, and Operations persistence, but no Ledger module or ledger tables. The committed [Payment Capture and Refund plan](../plans/2026-08-02-payment-capture-and-refunds.md) correctly blocks those commands until a separately accepted and verified Ledger Foundation exists. A material decision is needed because Prisma cannot express PostgreSQL deferred constraint triggers, immutable-record triggers, or all required role permissions, and because account provisioning and posting identity are cross-cutting financial controls.

This ADR refines the authoritative specification without changing its financial semantics. The Project owner approved all twelve Ledger Foundation decisions on 2026-08-02. Acceptance establishes the implementation architecture but does not itself implement or enable any Ledger, capture, or refund route.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): Domain Model and Financial Semantics; Tables 12, 14, 15, 18, 19, 21, 22, 34-36, and 46; FR-03 through FR-07; M1 Payments and Ledger milestone; recorded PostgreSQL/Prisma baseline.
- [Financial invariants](../architecture/financial-invariants.md)
- [Module boundaries](../architecture/module-boundaries.md)
- [ADR-0003](0003-postgresql-prisma-and-financial-data-access.md)
- [ADR-0007](0007-idempotency-key-concurrency-and-response-snapshots.md)
- [ADR-0010](0010-payment-currencies-and-amount-range.md)
- [ADR-0013](0013-problem-details-audit-and-retention-boundaries.md)
- [Payment Capture and Refund plan](../plans/2026-08-02-payment-capture-and-refunds.md)

## Decision drivers

- Database-enforced INV-01 through INV-06 at PostgreSQL commit.
- One accounting transaction, not mutable balances or payment projections, as the authoritative value-movement record.
- Atomic composition with Payments, Idempotency, and Eventing without reversing module dependencies.
- Exact integer-minor-unit arithmetic and tenant/currency isolation.
- Durable duplicate prevention under idempotent retries and concurrent distinct keys.
- Append-only evidence, controlled reversal, least-privilege runtime access, and safe recovery.
- Reviewable Prisma models with narrow, justified, parameterized raw-SQL and migration boundaries.
- A chart of accounts sufficient for specification-authorized capture/refund postings without prebuilding Settlement or fee behavior.

## Considered options

### Option A: PostgreSQL-enforced, posted-only double-entry ledger behind a transaction-aware Ledger port

Ledger owns accounts, transactions, and entries. A caller supplies the existing Prisma transaction context and an opaque bounded business reference. The Ledger adapter stages a new transaction and all entries, finalizes it before the caller commits, and relies on deferred PostgreSQL constraint triggers to reject incomplete, unbalanced, or mixed-currency work at commit. Posted rows cannot be extended, updated, deleted, or truncated. Corrections use one exact linked reversal.

This option keeps the financial transaction local and atomic, matches module direction, and makes the database—not an application assertion—the final invariant authority.

### Option B: Enforce balance and immutability only in TypeScript

A pure posting builder is valuable, but application checks alone can be bypassed by defects, future adapters, migration scripts, or concurrent paths. This option contradicts FR-06 and INV-01 through INV-06 and is rejected.

### Option C: Persist mutable draft/posting states across transactions

Callers could create a draft, append entries, and later mark it posted. A crash or partial workflow would leave durable incomplete accounting state and require cleanup or repair semantics not authorized by the specification. It is rejected. Option A may use an uncommitted `posted_at` finalization step inside one transaction; no draft may commit or become externally observable.

### Option D: Post the ledger asynchronously after the payment transaction

An event consumer could eventually create entries, but payment state and accounting evidence could diverge. This directly violates the atomicity rule and is rejected.

### Option E: Store mutable account balances or single-sided movements

Mutable balances or transfer-like records make correction, audit, and invariant proof weaker and contradict the double-entry model. They are rejected. Balances remain derived from immutable entries.

## Decision

The decision is **Option A** with the following exact controls. Project-owner approval covers the complete decision, including finalization, identifiers, business uniqueness, chart/provisioning, money bounds, reversal rules, runtime permissions, audit interpretation, API deferral, and retention.

### Ownership, scope, and tenant isolation

- Ledger owns `ledger_accounts`, `ledger_transactions`, and `ledger_entries`, its domain types, posting/reversal builders, Prisma adapter, database constraints, and invariant runbook.
- Ledger exposes transaction-aware application ports. Payments may call the posting port with a `PrismaTransactionClient`; Ledger never imports Payments, Refund, Eventing, HTTP, or NestJS controller internals.
- The Foundation adds no public API, OpenAPI path, RabbitMQ event, Webhook behavior, settlement logic, reconciliation behavior, or mutable balance.
- Every account and transaction carries `merchant_id` and `currency`. Every entry repeats them so composite foreign keys can prove that its account and transaction belong to the same merchant and currency.
- Internal UUIDs are primary keys. Only ledger transactions receive a public identifier. Accounts and entries have no public identifier in this milestone.

### Identifiers and business uniqueness

- Ledger transaction IDs use `ltx_<ULID>`: exactly 30 characters matching `^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$`.
- Reuse the pinned `ulid@3.0.2` infrastructure generator with one process-scoped monotonic factory and no more than three whole-posting identifier-collision attempts. Exhaustion fails closed; it never changes an existing transaction.
- A transaction stores a case-sensitive, trimmed, control-character-free `business_reference` of 1-255 characters supplied through the Ledger port. Ledger treats it as an opaque source-owned reference and does not import or validate Payment/Refund types.
- Unique `(merchant_id, business_type, business_reference)` prevents a second capture/refund/reversal posting for the same business effect. A duplicate is a domain conflict/invariant signal, not a successful implicit replay. The command-owning module remains responsible for ADR-0007 response replay.
- `business_type` initially permits only `CAPTURE`, `REFUND`, and `REVERSAL`. Settlement and reconciliation types require later approved migrations.

### Chart of accounts and provisioning

- The initial closed chart contains exactly two merchant-owned account codes per enabled currency:
  - `provider_clearing`, normal side `DEBIT`;
  - `merchant_payable`, normal side `CREDIT`.
- V1 currencies are exactly `ETB` and `USD`; therefore each existing merchant receives four accounts. Adding a currency or account code is a reviewed additive migration/ADR decision, not runtime merchant configuration.
- Account uniqueness is `(merchant_id, code, currency)`. Codes, currency, and normal side are immutable. There is no account balance, status, display name, hierarchy, or merchant-facing account-management API.
- The Ledger module provides an internal idempotent provisioning port, and the Foundation migration backfills missing approved accounts for existing merchants. It is not composed into a public API or worker job.
- A posting requires both approved accounts to exist and fails before writing a ledger transaction when provisioning is incomplete. It never creates accounts lazily in the financial command transaction.
- The production orchestration and privileged audit policy for future merchant provisioning are **To be decided before any production merchant-onboarding capability**. The current repository exposes no such onboarding surface.

### Money and posting model

- `amount_minor` is PostgreSQL `BIGINT`, strictly positive, and at most `9,007,199,254,740,991`. TypeScript uses `bigint` internally; no binary floating-point arithmetic is permitted.
- Each transaction and entry carries exactly one uppercase currency in `ETB` or `USD`. Aggregate debit/credit SQL uses PostgreSQL `NUMERIC` accumulation so summing multiple `BIGINT` entries cannot overflow.
- An account's normal side is classification metadata and does not forbid opposite-side entries; reversals necessarily post to the opposite side.
- Capture posts exactly: debit merchant `provider_clearing`, credit merchant `merchant_payable`.
- Refund-before-settlement posts exactly: debit merchant `merchant_payable`, credit merchant `provider_clearing`.
- No fee, settlement-clearing, revenue, suspense, cash, FX, tax, reserve, chargeback, or platform-global account is created by this Foundation.
- Authoritative balances are derived by summing entries by account/currency. The schema stores no balance, debit total, credit total, or generated balance projection.

### Schema contract

`ledger_accounts` contains:

- internal UUID `id` primary key;
- UUID `merchant_id` with `ON DELETE RESTRICT`/`ON UPDATE RESTRICT` Merchant FK;
- bounded account `code`, uppercase three-character `currency`, and `normal_side` (`DEBIT`/`CREDIT`);
- immutable `created_at`;
- unique `(merchant_id, code, currency)` and supporting unique `(id, merchant_id, currency)` for composite ownership FKs.

`ledger_transactions` contains:

- internal UUID `id` primary key and unique public `public_id`;
- UUID `merchant_id`, uppercase `currency`, `business_type`, and `business_reference`;
- optional `reversal_of_id`, unique when present and constrained to the same merchant/currency;
- bounded `request_id`, immutable `occurred_at` and `created_at`, and `posted_at`;
- unique `(merchant_id, business_type, business_reference)` and supporting unique `(id, merchant_id, currency)`.

`ledger_entries` contains:

- internal UUID `id` primary key;
- `ledger_transaction_id`, `account_id`, repeated `merchant_id`, and repeated `currency`;
- one-based positive `entry_seq`, `side`, positive bounded `amount_minor`, and immutable `created_at`;
- unique `(ledger_transaction_id, entry_seq)`;
- composite restrictive FKs to the transaction and account using their ID, merchant, and currency keys.

No table has soft-delete, mutable description, stored balance, arbitrary metadata JSON, provider payload, secret, payment/refund columns, or public update timestamp.

### Commit-time enforcement and immutability

- Posting is an uncommitted three-step operation: insert `ledger_transactions` with `posted_at = NULL`; insert all entries; change only `posted_at` from `NULL` to the authoritative transaction timestamp. A deferred constraint trigger rejects any commit with `posted_at IS NULL`.
- A transaction-row deferred constraint trigger plus entry-row deferred constraint triggers are `DEFERRABLE INITIALLY DEFERRED`. At commit they prove at least two entries, equal debit/credit totals, entry currency equality, and the approved account/merchant/currency relationship.
- A `BEFORE INSERT` entry trigger rejects attempts to append an entry after its parent has been finalized. A transaction update trigger allows only the single uncommitted `posted_at: NULL -> timestamp` transition with every other column unchanged.
- `UPDATE`, `DELETE`, and `TRUNCATE` of entries are always rejected. After finalization, transaction `UPDATE` is rejected; transaction `DELETE` and `TRUNCATE` are always rejected. Account `UPDATE`, `DELETE`, and `TRUNCATE` are rejected.
- The runtime role receives only `SELECT/INSERT` on accounts and entries and `SELECT/INSERT/UPDATE` on transactions, where the update trigger limits the grant to finalization. It receives no delete/truncate privileges and remains a non-owner without schema creation.
- Constraint and immutability functions use reviewed migration SQL with fixed `search_path`, schema-qualified objects, stable named errors/constraints, and no dynamic SQL.
- A reversal transaction must share merchant/currency with a posted original, use `business_type = REVERSAL`, and reproduce the original entry sequence/accounts/amounts/currency with each side inverted. `reversal_of_id` is unique, so an original can be reversed at most once. Reversing a reversal is prohibited; reinstatement requires a separately authorized new business posting.

### Transactions, idempotency, concurrency, and recovery

- `post` participates in the caller's explicit PostgreSQL transaction and never commits independently. The caller's payment/refund mutation, Ledger posting, Eventing outbox row, and Idempotency completion/snapshot succeed or roll back together.
- Ledger performs no network, DNS, RabbitMQ, HTTP, logging-sink, or provider call inside the transaction.
- The command orchestrator locks the Idempotency row and Payment Intent before calling Ledger. Ledger reads the two immutable account rows in deterministic code order and inserts the transaction then entries in increasing sequence order. It maintains no mutable balance row, so ordinary posting requires no account balance lock.
- ADR-0007 owns command-key acquisition, lease takeover, fingerprinting, and replay. Ledger's business uniqueness is defense in depth against different-key duplicate effects.
- Approved deadlock/serialization retries restart the entire command transaction through the orchestrator. Ledger never retries a partial insert/finalization sequence. A public-ID collision also retries the whole effect transaction within the approved three-candidate bound.
- Commit-time invariant failure rolls back every domain, ledger, outbox, and snapshot write. It is an internal financial-control incident: stop the affected command path, preserve correlation/public IDs and database evidence, and forward-fix code/migration behavior. Never patch or delete entries.
- Reversal orchestration is deferred. When authorized, it must lock/read the original, create the exact opposite posting, and record the privileged actor/reason through Operations atomically. This Foundation creates no manual reversal endpoint.

### Prisma and raw-SQL boundary

- Prisma models and generated types support routine inserts/selects and relations.
- Hand-reviewed migration SQL is required for deferrable constraint triggers, immutable/finalization triggers, composite deferred FKs where Prisma cannot express timing, exact checks, role grants/revocations, and any conditional/backfill statements.
- The Ledger adapter may use parameterized Prisma operations and `$queryRaw`/`$executeRaw` only where exact transaction/finalization semantics cannot be expressed clearly. `$queryRawUnsafe`, `$executeRawUnsafe`, string interpolation, cross-module Prisma writes, and database-owner runtime connections are prohibited.
- Every raw-SQL site documents the Prisma limitation, remains in the Ledger-owned adapter/migration, and has real PostgreSQL positive, negative, concurrency, and permission tests.

### Audit, retention, and observability

- Ordinary capture/refund postings do not duplicate Operations `audit_events`; Payment/Refund, Idempotency, immutable Ledger, and outbox correlation are the durable evidence under ADR-0013.
- Account provisioning beyond migration/test fixtures and every future manual reversal/recovery command are privileged. Their actor, reason, target, and correlation policy must be approved before exposure.
- Ledger records are retained indefinitely in the case-study environment. No purge, archive, mutation, or manual repair is authorized.
- Emit a `ledger.post` span and bounded outcome/invariant/duplicate/retry counters without amounts, raw entries, business references, SQL, or idempotency material as labels/log fields. Ledger invariant failure uses a stop-and-preserve-evidence runbook.

## Consequences

### Positive

- PostgreSQL prevents committed incomplete, unbalanced, mixed-currency, cross-tenant, mutable, or duplicate-business-effect postings.
- Payment state, ledger evidence, outbox intent, and response replay can share one atomic transaction without Ledger depending on Payments.
- No mutable balance can drift from accounting entries.
- A small closed chart supports the exact specification capture/refund examples without inventing Settlement/fee behavior.
- Immutable public transaction identifiers support API/event correlation while internal UUIDs remain private.

### Negative

- The migration requires substantial reviewed PostgreSQL trigger, permission, and backfill SQL beyond Prisma's schema language.
- `posted_at` finalization adds one guarded update within each posting transaction.
- Deferred triggers may execute repeated aggregate checks for multi-row inserts and must be measured.
- A closed chart and ETB/USD allow-list require additive migrations for future currencies/account types.
- The shared runtime role cannot cryptographically enforce TypeScript module ownership; boundaries, grants, triggers, and review work together.

### Risks and mitigations

- **Late entry changes a posted transaction:** reject entry insert after `posted_at`; also deny update/delete/truncate and prove with owner/runtime-role negative tests.
- **Zero-entry transaction escapes an entry trigger:** attach a deferred check to the transaction insert as well as entries.
- **Aggregate overflow:** use `NUMERIC` in trigger sums while constraining each entry to exact bounded `BIGINT`.
- **Cross-merchant or cross-currency entry:** redundant ownership columns plus composite foreign keys and deferred validation.
- **Duplicate command with a different key:** unique business reference rejects a second Ledger effect; Idempotency remains the replay owner.
- **Provisioning drift:** closed account-code/normal-side checks, idempotent backfill, exact row-count tests, and fail-closed posting.
- **Migration lock/runtime risk:** additive tables avoid existing hot-table rewrites; measure merchant-account backfill, use deterministic conflict handling, and test prior-version upgrade.
- **Trigger or raw-SQL defect:** named functions/constraints, database review, migration-from-empty/prior, negative tests, permission tests, and no release waiver.
- **Correction abused as mutation:** one exact opposite reversal, unique link, no reversal chains, future privileged audit, and no public command in this milestone.

## Impact assessment

- **Affected modules and dependency direction:** Adds Ledger only. Payments may later call its transaction-aware port; Ledger does not depend on Payments.
- **Financial invariants and money representation:** Directly implements INV-01 through INV-06; preserves INV-07 through INV-10. Positive JSON-safe `BIGINT` entries, one ETB/USD currency, and derived balances only.
- **Database schema, migration, locking, and transaction boundaries:** Three Ledger tables, enums/checks/composite FKs, deferred and immutable triggers, a bounded account backfill, restricted grants, and one caller-owned transaction.
- **Idempotency, outbox/inbox, retries, and partial failure:** No new idempotency/outbox table; business uniqueness is defense in depth. Whole command retries only; no partial posting or broker dependency.
- **API, event, webhook, or CSV compatibility:** None in the Foundation. Existing contracts are unchanged; future captured/refunded events may expose `ltx_` IDs after separate approval.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** No public route or secret. Future read/command adapters must derive merchant identity from authenticated context and include it in predicates.
- **Observability, alerting, and runbooks:** Adds Ledger posting/invariant signals and an invariant-failure runbook; telemetry excludes money/body/business-reference data.
- **Production dependencies and supply-chain impact:** No new external dependency; reuse PostgreSQL, Prisma 7.9.1, and the pinned ULID infrastructure package.

## Verification

- Apply the migration to an empty PostgreSQL database and upgrade a disposable database at committed migration `20260802150000_signed_webhook_delivery_and_retries` with existing merchants/data.
- Validate/generate Prisma and inspect the final schema, named checks, foreign keys, functions, triggers, privileges, and dependency order.
- Prove valid two-entry capture/refund/reversal goldens commit with exact amounts/currencies and derived balances.
- Prove zero/negative/over-range entries, one entry, imbalance, mixed currency, cross-merchant account use, unknown account code, missing provisioning, duplicate business reference, and malformed public ID fail.
- Prove zero-entry and unfinalized transactions fail specifically at commit; prove balance/currency/count triggers are deferred until constraint timing/commit.
- Prove append-after-post, transaction/entry/account update/delete/truncate fail both as migration owner and `settleflow_app`; prove allowed inserts/finalization work only as intended.
- Prove exact opposite one-time reversal succeeds while same-side, changed amount/account/currency, second reversal, reversal chain, and original mutation fail.
- Run same-business-reference and forced-public-ID collision races; prove one committed transaction and no partial entries.
- Inject errors after transaction insert, each entry, finalization, caller state/outbox/snapshot, and before commit; prove all-or-nothing rollback.
- Run module-boundary, lint, type-check, unit, real PostgreSQL integration, build, documentation/link, and whitespace checks. Financial database tests may not use an in-memory substitute or be skipped for release.

## Rollout and recovery

Accept this ADR before schema/application work. Apply the additive Ledger migration and account backfill while capture/refund routes remain absent. Verify every existing merchant has exactly the approved account set and that the runtime role passes positive/negative permission tests before composing Ledger into a money command.

Before any ledger posting exists, faulty application wiring can be disabled and an unused additive schema can be removed only through a reviewed migration. After the first posting, preserve all Ledger rows and use forward fixes. Disable the affected command surface on invariant or mapping failure; do not relax triggers, reassign business references, update/delete entries, synthesize balances, or use direct SQL repair. A future correction uses the approved reversal/audit path.

## Documentation and traceability

Index this Accepted ADR in [the ADR register](README.md). The companion [Immutable Double-Entry Ledger Foundation plan](../plans/2026-08-02-immutable-double-entry-ledger-foundation.md) records the approved design, exact future files, migration/test sequencing, and verification commands. During implementation, update the financial architecture, schema notes/ERD, root setup, Ledger examples, invariant matrix, and runbook without enabling capture/refund until their remaining gates are accepted.
