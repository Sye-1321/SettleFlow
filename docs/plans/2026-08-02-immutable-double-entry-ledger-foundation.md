# Implementation Plan: Immutable Double-Entry Ledger Foundation

- **Status:** Completed
- **Owner:** SettleFlow Project
- **Created:** 2026-08-02
- **Last updated:** 2026-08-02
- **Related issue/PR:** To be decided
- **Related ADRs:** [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0007](../adr/0007-idempotency-key-concurrency-and-response-snapshots.md), [ADR-0010](../adr/0010-payment-currencies-and-amount-range.md), [ADR-0013](../adr/0013-problem-details-audit-and-retention-boundaries.md), and [ADR-0020](../adr/0020-immutable-double-entry-ledger-foundation.md)

## Goal

Establish the specification-authorized, PostgreSQL-enforced accounting foundation that later capture/refund commands can call inside their existing explicit transaction. The completed Foundation must own a closed initial chart of accounts, create posted-only double-entry transactions, enforce INV-01 through INV-06 at the database boundary, prevent late mutation, and expose a transaction-aware Ledger application port without enabling any payment command or public Ledger endpoint.

Success is measurable only when a real PostgreSQL database proves:

- each valid posting has one merchant, one currency, at least two positive entries, and equal debit/credit totals;
- incomplete, unbalanced, mixed-currency, cross-merchant, duplicate-business, and malformed postings cannot commit;
- posted transactions cannot accept later entries and accounts/transactions/entries cannot be updated, deleted, or truncated;
- an exact linked reversal is the only correction representation;
- runtime-role permissions are sufficient for approved posting/provisioning and insufficient for mutation;
- all work participates in a caller-owned transaction so a later Payment/Refund state write, Ledger posting, outbox event, and Idempotency snapshot can roll back together.

ADR-0020 and all twelve bounded decisions were accepted before implementation at commit `71a869a`. Completion of this foundation creates no authority to enable capture/refund or bypass their separate unresolved gates.

### Non-goals

- No capture/refund controller, route, DTO, Payment Intent transition, Refund table, provider adapter, or new idempotency route.
- No Settlement, payout, reconciliation, fee, revenue, FX, tax, reserve, chargeback, balance, cash-management, or frontend behavior.
- No RabbitMQ topology, outbox producer/event contract, inbox, Webhook projection, or HTTP delivery change.
- No public `GET /v1/ledger/transactions/{id}` yet, despite its specification authorization; transport/scopes/representation remain a later contract milestone.
- No merchant self-service chart management or production merchant-onboarding workflow.
- No public/operator reversal or manual-repair endpoint. The schema and internal rule may support exact reversals, but privileged orchestration/audit remains deferred.
- No stored account balance, trial-balance projection, materialized view, cache, Redis, event sourcing, separate Ledger database/service, or asynchronous accounting.
- No dependency addition. The design reuses PostgreSQL, Prisma 7.9.1, the current `PrismaTransactionClient`, and pinned `ulid@3.0.2`.

## Specification traceability

- **Sections:** Product Scope and Prioritization; assumptions A-02/A-03; Domain Model and Financial Semantics; bounded modules; money representation; Ledger model and representative postings; Financial Invariants; FR-03 through FR-07; critical capture workflow; module dependency rules; PostgreSQL/Prisma baseline; data ownership/integrity/index/migration sections; security/tamper controls; telemetry/runbooks; verification/race/release gates; M1 Payments and Ledger milestone; Appendices A-C.
- **Requirement IDs:** FR-03 and FR-04 require one capture/refund Ledger transaction; FR-05 and INV-10 require no second effect; FR-06 directly requires immutable balanced posting in the domain transaction; FR-07 requires the same transaction's outbox intent. FR-11/FR-12 later consume Ledger concepts but are outside this milestone. FR-13 supplies correlation/operational expectations. FR-14 applies to future privileged recovery, not ordinary merchant postings, under ADR-0013.
- **Invariant IDs:** INV-01 through INV-06 are directly implemented and release-blocking. INV-07 through INV-10 remain preserved and are composed by later Payment/Settlement work.
- **Authorization evidence:** the specification assigns `ledger_accounts`, `ledger_transactions`, and `ledger_entries` to Ledger; defines capture/refund/correction postings; names the core entity constraints; mandates deferred balance/count/currency triggers, restricted roles, append-only evidence, and reversal-only correction; and includes Ledger in P0/M1 rather than as an optional feature.
- **Acceptance/release gates:** real PostgreSQL constraint, immutability, permission, migration, transaction, race, and failure evidence is mandatory. No in-memory substitute, skipped financial integration suite, trigger waiver, or application-only assertion can satisfy the gate.

No specification version change is required for the mandatory double-entry model. Accepted ADR-0020 refines previously unspecified identifiers, chart closure/provisioning, staging/finalization, business-reference shape, reversal depth, safe amount ceiling, and least-privilege implementation.

## Evidence inspected

The read-only design inspection covered:

- `AGENTS.md`, `PLANS.md`, `CONTRIBUTING.md`, and the plan/ADR templates;
- the authoritative v1.0 `.docx` specification, structurally extracted without editing it;
- [architecture overview](../architecture/README.md), [module boundaries](../architecture/module-boundaries.md), and [financial invariants](../architecture/financial-invariants.md);
- ADR-0001 through ADR-0019, with particular attention to ADR-0003, ADR-0007, ADR-0010, and ADR-0013;
- the committed [Payment Capture and Refund plan](2026-08-02-payment-capture-and-refunds.md);
- `prisma/schema.prisma`, all committed migrations through `20260802150000_signed_webhook_delivery_and_retries`, runtime-role provisioning SQL/tooling, and migration permission/immutability patterns;
- the current Payments, Idempotency, Eventing, Infrastructure, Operations, and Webhooks types/services/adapters;
- focused unit/integration/concurrency-relevant tests and root scripts.

The design inspection began at clean commit `8cd49e4`. Implementation began from clean commit `71a869a` on `main`, tracking `origin/main`, after ADR-0020 and this plan were accepted and committed.

## Existing behavior

- PostgreSQL is authoritative and Prisma is the routine client. `PrismaTransactionClient` is already the stable cross-module transaction-context type. Reviewed parameterized raw SQL is already used for concurrency/claim behavior that Prisma cannot express.
- Payments currently supports only merchant-scoped Payment Intent create/read. No capture/refund path, Refund model, Ledger module, or financial posting exists.
- Idempotency already uses a committed acquisition lease and a separate effect transaction. Its `complete` callback receives one Prisma transaction and retries approved transient failures as a whole. The Ledger port must compose inside that callback rather than opening or committing a second transaction.
- Eventing persists `payment.created.v1` through a transaction-aware port. Capture/refund will later use the same ownership pattern, but this Foundation creates no new event.
- `settleflow_app` is a provisioned non-owner login used by API and worker. Existing migrations revoke schema creation and table-wide defaults, then grant only bounded table operations. Audit and Webhook attempt evidence already use database triggers plus role denials for update/delete/truncate.
- Prisma currently has Merchant, API key, Payment Intent, Idempotency, Outbox/Inbox, Webhook, and Operations audit models. It has no account, transaction, entry, stored balance, Refund, settlement, or reconciliation model.
- The root workspace has no Ledger package, Jest project, build/typecheck/lint script entry, or Ledger runbook. The pinned infrastructure dependency already contains `ulid@3.0.2`; no new ID dependency is necessary.
- Existing database tests apply real migrations and exercise runtime-role permissions. No current test proves Ledger balance, entry-count, currency, reversal, late-append, or atomic financial rollback.

## Accepted implementation decisions

The Project owner explicitly accepted ADR-0020 and these bounded choices before implementation:

1. **Posted-only transaction representation:** approve an uncommitted `posted_at = NULL` staging row, entry inserts, and one trigger-guarded `posted_at` finalization inside the same PostgreSQL transaction. A deferred trigger prevents any unfinalized row from committing; there is no durable `DRAFT` state.
2. **Transaction identity:** approve internal UUID plus public `ltx_<ULID>`, strict 30-character pattern, the existing process-scoped monotonic ULID generator, and at most three whole-transaction collision attempts.
3. **Business identity:** approve case-sensitive 1-255 character `business_reference` and unique `(merchant_id, business_type, business_reference)`, with Ledger treating the reference as opaque so it never imports Payments/Refund types.
4. **Initial business types:** approve the closed `CAPTURE`, `REFUND`, and `REVERSAL` set only. Later Settlement/Reconciliation types require additive review.
5. **Closed chart:** approve merchant-owned `provider_clearing`/`DEBIT` and `merchant_payable`/`CREDIT` for ETB and USD—four accounts per merchant—with no platform-global, fee, cash, suspense, reserve, or settlement accounts.
6. **Provisioning:** approve migration backfill for existing merchants and an internal idempotent Ledger provisioning port that is not exposed or automatically composed. Missing accounts fail a posting; capture/refund never lazily creates them. Production onboarding/audit remains a later decision.
7. **Ledger amount ceiling:** approve positive `BIGINT` entries capped at `Number.MAX_SAFE_INTEGER`, while deferred aggregate checks sum as PostgreSQL `NUMERIC`. This follows ADR-0010's public exactness boundary rather than admitting the full positive signed-`BIGINT` range.
8. **Reversal strength:** approve a database-validated exact opposite entry set, one unique reversal per original, and prohibition on reversing a reversal. Reinstatement would be a new separately authorized business posting.
9. **Runtime permissions:** approve continued use of shared non-owner `settleflow_app`, with `SELECT/INSERT` on accounts/entries and guarded `SELECT/INSERT/UPDATE` on transactions solely for finalization; no separate Ledger database role or security-definer posting procedure in this milestone.
10. **No ordinary Operations audit row:** approve immutable Ledger/Idempotency/domain/outbox correlation as ordinary posting evidence. Future production account provisioning and every operator reversal/recovery remain privileged and require an atomic Operations audit design before exposure.
11. **No public Ledger read API in the Foundation:** approve schema/internal ports/tests/runbook only. The specification-authorized GET route waits for its own merchant-scope, representation, pagination, and OpenAPI contract review.
12. **Retention:** approve indefinite case-study retention and no cleanup/archive job. Posted/account evidence is forward-fixed or reversed, never purged or rewritten.

Rejecting any item pauses implementation so the ADR/plan can be revised. No default is silently inferred from code.

## Implemented design

### Module ownership and dependency direction

Create `@settleflow/ledger` as a pure bounded-domain package with no NestJS controller and no dependency on Payments, Eventing, Idempotency, Webhooks, Settlement, or Operations. It may depend on `@settleflow/infrastructure` for `PrismaTransactionClient`, the generated Prisma client, PostgreSQL error helpers, and the existing monotonic ULID adapter.

The package layers are:

- domain types for currency, side, account code, business type, posting command/result, reversal record, and safe errors;
- pure posting builders that turn semantic `CAPTURE`/`REFUND` inputs into the exact two-account debit/credit lines;
- application service that validates owned inputs, loads/proves provisioned accounts, generates the candidate `ltx_` ID, and delegates persistence;
- a transaction-aware repository implemented with Prisma plus the minimum reviewed parameterized SQL;
- an internal idempotent account-provisioning application port used by migration verification/test fixtures and future approved onboarding orchestration;
- no transport or deployment-specific code.

Payments will later depend only on an exported interface such as:

```ts
interface LedgerPostingPort {
  postCapture(
    transaction: PrismaTransactionClient,
    command: LedgerMoneyPostingCommand,
  ): Promise<LedgerPostingResult>;
  postRefund(
    transaction: PrismaTransactionClient,
    command: LedgerMoneyPostingCommand,
  ): Promise<LedgerPostingResult>;
}
```

`LedgerMoneyPostingCommand` carries `merchantId`, exact `currency`, positive `amountMinor: bigint`, opaque `businessReference`, bounded `requestId`, and authoritative `occurredAt`. It cannot carry arbitrary account IDs, arbitrary entry sides, client-supplied ledger IDs, metadata JSON, or payment state. Ledger owns the accounting mapping.

The internal reversal port accepts the original Ledger transaction identity and correlation context and constructs entries from the immutable original. It does not accept client-provided opposite entries. It is not composed into API/worker and cannot be reached without a later privileged/audited orchestration milestone.

### Identifiers

- Database primary keys: UUID generated by the application or Prisma convention already used by the repository.
- Ledger transaction public ID: `ltx_` plus uppercase 26-character Crockford ULID, strict regex `^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$`.
- Account and entry IDs remain internal UUIDs; API/event code must never serialize them.
- Reuse the infrastructure `MonotonicUlidGenerator`; create one process-scoped instance in the eventual composition root. A transaction attempt uses one candidate. A named unique violation rolls the whole caller transaction back before another attempt. No savepoint or statement-only collision retry is permitted.
- Three candidate collisions exhaust the command and produce a safe internal/service-unavailable outcome at the future HTTP boundary. They never return an existing transaction or mutate the Idempotency fingerprint/result.

### Chart of accounts and account provisioning

The V1 chart is code-owned and database-constrained:

| Code                | Normal side | Merchant scope | Currency scope         | Authorized use               |
| ------------------- | ----------- | -------------- | ---------------------- | ---------------------------- |
| `provider_clearing` | `DEBIT`     | One merchant   | One ETB or USD account | Capture debit; refund credit |
| `merchant_payable`  | `CREDIT`    | One merchant   | One ETB or USD account | Capture credit; refund debit |

An account is classification, not a balance container. Opposite-side entries remain valid because refunds/reversals affect the same account differently. Normal side supports reporting and validation of the approved chart; it does not reject a reversal.

Migration behavior:

1. Create the account table, constraints, immutable triggers, and privileges.
2. For each existing merchant, insert the four approved `(code, currency, normal_side)` rows in deterministic order with `ON CONFLICT DO NOTHING`.
3. Assert through migration/integration evidence that every merchant has exactly one approved account per code/currency and no mismatched normal side.
4. Do not invoke a trigger on `merchants`, create a public endpoint, or create accounts from a capture/refund transaction.

The internal provisioning port runs the same deterministic set in its own caller-supplied transaction and returns the existing/new records. It cannot update account semantics. It exists for tests and later approved merchant lifecycle orchestration. Until that lifecycle is designed, any new production merchant must remain ineligible for money commands unless the approved operator path provisions and audits it.

### Posting rules

The pure builder produces fixed, ordered entries:

| Posting                  | Entry 1                                                                  | Entry 2                                             |
| ------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------- |
| Capture                  | debit `provider_clearing` for amount/currency                            | credit `merchant_payable` for same amount/currency  |
| Refund before settlement | debit `merchant_payable` for amount/currency                             | credit `provider_clearing` for same amount/currency |
| Reversal                 | original entry sequence/account/amount/currency with every side inverted | one output for every original entry                 |

Validation rejects zero, negative, over-range, malformed currency, unsupported currency, empty/control/trim-variant business reference, malformed request ID, missing/mismatched account, duplicate business effect, and any arbitrary side/account mapping. The application uses `bigint` from validation through persistence. It performs no `number` conversion or amount arithmetic.

Ledger stores no debit/credit total. Tests and future read models derive totals with PostgreSQL `SUM(bigint) -> numeric` or exact TypeScript `bigint` after bounded conversion. No cross-currency sum is exposed.

### Prisma models and PostgreSQL columns

#### `LedgerAccount`

| Field        | PostgreSQL shape | Controls                                 |
| ------------ | ---------------- | ---------------------------------------- |
| `id`         | UUID PK          | Internal only                            |
| `merchantId` | UUID             | FK to Merchant, update/delete `RESTRICT` |
| `code`       | `VARCHAR(64)`    | Closed lowercase code check              |
| `currency`   | `CHAR(3)`        | Uppercase format and ETB/USD allow-list  |
| `normalSide` | enum             | Exact code/normal-side cross-check       |
| `createdAt`  | `TIMESTAMPTZ`    | Immutable transaction timestamp          |

Constraints: unique `(merchant_id, code, currency)` and unique `(id, merchant_id, currency)` for entry ownership. There is no public ID, balance, name, hierarchy, status, version, or update timestamp.

#### `LedgerTransaction`

| Field               | PostgreSQL shape                         | Controls                                           |
| ------------------- | ---------------------------------------- | -------------------------------------------------- |
| `id`                | UUID PK                                  | Internal only                                      |
| `publicId`          | `VARCHAR(30)`                            | Globally unique strict `ltx_<ULID>` check          |
| `merchantId`        | UUID                                     | Restrictive Merchant FK                            |
| `currency`          | `CHAR(3)`                                | Uppercase ETB/USD check                            |
| `businessType`      | enum                                     | `CAPTURE`, `REFUND`, `REVERSAL` only               |
| `businessReference` | `VARCHAR(255)`                           | Case-sensitive, 1-255, trimmed/no controls         |
| `reversalOfId`      | UUID nullable                            | Unique composite same-merchant/currency self-FK    |
| `requestId`         | `VARCHAR(128)`                           | Existing canonical request-ID character policy     |
| `occurredAt`        | `TIMESTAMPTZ`                            | Authoritative command/reversal time                |
| `createdAt`         | `TIMESTAMPTZ`                            | Insert evidence                                    |
| `postedAt`          | `TIMESTAMPTZ` nullable while uncommitted | Must be non-null at commit; one guarded transition |

Constraints: unique `(merchant_id, business_type, business_reference)`, unique `reversal_of_id`, and unique `(id, merchant_id, currency)`. A cross-column check requires `reversal_of_id` exactly when type is `REVERSAL`. There is no durable status/draft, description, metadata, totals, external provider payload, or update timestamp.

#### `LedgerEntry`

| Field                 | PostgreSQL shape | Controls                                           |
| --------------------- | ---------------- | -------------------------------------------------- |
| `id`                  | UUID PK          | Internal only                                      |
| `ledgerTransactionId` | UUID             | Composite transaction ownership FK                 |
| `accountId`           | UUID             | Composite account ownership FK                     |
| `merchantId`          | UUID             | Repeated for tenant-proof composite FKs            |
| `entrySeq`            | `SMALLINT`       | 1..32767, unique per transaction                   |
| `side`                | enum             | `DEBIT` or `CREDIT`                                |
| `amountMinor`         | `BIGINT`         | `1..9007199254740991` named check                  |
| `currency`            | `CHAR(3)`        | Transaction/account currency through FKs + trigger |
| `createdAt`           | `TIMESTAMPTZ`    | Immutable transaction timestamp                    |

Constraints: unique `(ledger_transaction_id, entry_seq)`; composite restrictive FKs `(ledger_transaction_id, merchant_id, currency)` and `(account_id, merchant_id, currency)`. There is no public ID, balance, memo, update timestamp, soft delete, or arbitrary metadata.

### Migration and database-enforcement design

The migration is additive but must be hand-reviewed. Prisma schema declarations do not replace the SQL controls.

1. Fail clearly if `settleflow_app` is not provisioned, following committed migration convention.
2. Create Ledger enums/tables in FK-safe order with all named local checks and unique constraints.
3. Add restrictive Merchant/account/transaction FKs. Use reviewed raw SQL for composite and deferrable timing Prisma cannot express.
4. Create one schema-qualified assertion function that, for an affected transaction, proves:
   - the transaction exists and is finalized at commit;
   - entry count is at least two;
   - debit and credit `NUMERIC` sums are equal;
   - every entry currency equals the transaction currency;
   - account/entry/transaction merchant and currency agree;
   - a reversal exactly mirrors one posted, non-reversal original with inverted sides.
5. Attach `DEFERRABLE INITIALLY DEFERRED` constraint triggers to transaction insert/finalization and entry insert. The transaction trigger is essential so zero-entry transactions cannot escape an entry-only trigger.
6. Add ordinary `BEFORE` triggers that:
   - reject an entry insert when the parent `posted_at` is already set;
   - reject every entry update/delete and entry truncate;
   - permit only a transaction's single `posted_at NULL -> authoritative timestamp` update with all other fields byte-equivalent;
   - reject every transaction delete/truncate and every post-finalization update;
   - reject every account update/delete/truncate.
7. Backfill four approved accounts per existing merchant idempotently. Do not rewrite any existing Payment, Idempotency, Outbox, Webhook, or Audit row.
8. Revoke all Ledger-table privileges from `settleflow_app`, then grant only approved operations. Revoke update/delete/truncate explicitly and retain no ownership/schema-create capability.
9. Do not add the candidate account-history covering index until an explain-plan/measured read requirement exists. The unique transaction/sequence and business/public-key indexes are sufficient for this Foundation.

Every function sets a fixed safe search path or uses fully qualified object names. Error messages remain stable enough for database tests but must not be exposed to future API clients. No dynamic SQL or unsafe interpolation is permitted.

### Transaction and finalization flow

A later capture/refund command composes the Foundation as follows:

1. API authenticates/authorizes/validates before Idempotency acquisition.
2. Idempotency acquires ownership in its existing short transaction.
3. The effect transaction locks/verifies the Idempotency row, then locks the merchant-owned Payment Intent.
4. Payments rechecks state, amount, currency, and cumulative projections.
5. Ledger verifies provisioned accounts in deterministic `(code, currency)` order, generates one candidate `ltx_` ID for this whole transaction attempt, and builds exact entries.
6. Ledger inserts an unfinalized transaction, inserts entries in ascending `entry_seq`, then performs the one guarded finalization update.
7. Payments writes its transition/Refund; Eventing writes one outbox event; Idempotency writes the response snapshot/result. Exact relative order may follow the accepted capture/refund plan, but all use the same transaction.
8. PostgreSQL evaluates deferred Ledger constraints at commit. Any failure rolls back everything.
9. Only after commit may the API return and the relay publish. Ledger performs no network operation.

The Foundation's focused integration tests use an outer Prisma transaction in place of Payments to prove this behavior. It must not add a standalone auto-committing repository method that later callers could accidentally use inside a money command.

### Idempotency, uniqueness, and concurrency

- ADR-0007 remains the command/replay authority. Ledger never receives raw Idempotency keys or writes `idempotency_keys`.
- `(merchant_id, business_type, business_reference)` guarantees one Ledger transaction for the source business effect even when two distinct Idempotency keys race.
- A same-reference duplicate causes one transaction to win and the other whole command transaction to roll back. It does not return the winner automatically because only Idempotency owns exact response replay.
- Ordinary posting does not lock account rows for a balance update because no balance exists. Restrictive FKs and immutable account metadata are sufficient. Entry order is deterministic to reduce deadlocks.
- A future reversal reads/locks the original in a deterministic manner; unique `reversal_of_id` establishes a single winner if two privileged commands race.
- Use current `READ COMMITTED` for composed capture/refund unless evidence forces `SERIALIZABLE`. Retry only existing approved deadlock/serialization SQLSTATEs, and restart the entire effect transaction at most three times.
- Ledger public-ID collision is a named outcome that also requires whole-transaction rollback/retry. It is not classified as a database availability failure until the third candidate is exhausted.
- Lock/statement timeout values remain inherited from the future accepted capture/refund orchestration. The Foundation performs no wait loop or lease management.

### Reversal and correction boundary

The schema and assertion function make a correction representable only as a new transaction whose entries are the exact original set with sides swapped. Original evidence remains unchanged. The following fail:

- update/delete/truncate/late-entry attempts on the original;
- a reversal with a different account, amount, currency, sequence, merchant, entry count, or same side;
- a second reversal of the same original;
- a reversal whose original is itself a reversal;
- a cross-merchant/currency reversal reference.

No operator transport or automatic reversal is included. Before a reversal command is exposed, a later plan must define separate operator authentication/authorization, mandatory reason, atomic Operations audit, error contract, response/idempotency policy, and runbook. Direct SQL remains prohibited.

### Alternatives rejected

- Application-only balance/immutability checks.
- Async Ledger consumer or a second database transaction after Payment commit.
- Mutable account balances or Payment projections as accounting truth.
- Durable draft/failed Ledger rows.
- Arbitrary entry arrays supplied by Payments.
- Merchant-configurable chart/accounts or lazy provisioning during capture/refund.
- Global provider-clearing account in this tenant-isolated case-study model.
- Full signed-`BIGINT` values exposed through JavaScript JSON without a separate string contract.
- Cascading deletes, soft deletion, retention purge, owner-role runtime access, RLS introduced only for Ledger, or a new dedicated database/service.
- Prisma-only migrations that omit deferred triggers/role controls, and unrestricted raw SQL.
- Automatically treating a duplicate business reference as a successful replay.
- Reversal chains or manual row repairs.

## Affected modules and files

The implementation changes these areas:

| Module/file area                                                                       | Ownership or change                                                        | Boundary impact                                      |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `docs/adr/0020-immutable-double-entry-ledger-foundation.md` and `docs/adr/README.md`   | Record approval/status and index                                           | Accepted at implementation baseline                  |
| This plan                                                                              | Record implementation evidence/deviations                                  | Remains the execution record                         |
| `packages/modules/ledger/package.json`, `tsconfig.build.json`                          | Add workspace-owned Ledger package                                         | Depends only on Infrastructure/domain-safe libraries |
| `packages/modules/ledger/src/ledger.types.ts`                                          | Stable posting/provisioning/reversal port and records                      | No Payment/HTTP/Prisma row leakage                   |
| `packages/modules/ledger/src/ledger.errors.ts`                                         | Named validation, provisioning, duplicate, collision, and invariant errors | Future API maps through owning command module        |
| `packages/modules/ledger/src/ledger-posting.ts` and spec                               | Pure capture/refund/reversal posting builders                              | Exact golden debit/credit mappings                   |
| `packages/modules/ledger/src/ledger.service.ts` and spec                               | Validate, generate ID, orchestrate repository within supplied transaction  | Does not open/commit caller financial transaction    |
| `packages/modules/ledger/src/prisma-ledger.repository.ts` and spec                     | Ledger-owned routine Prisma/parameterized SQL                              | No cross-module table writes                         |
| `packages/modules/ledger/src/index.ts`                                                 | Export only approved ports/types                                           | Keeps adapter internals private                      |
| `prisma/schema.prisma`                                                                 | Add Ledger enums/models and Merchant relations                             | Physical shared DB, logical Ledger ownership         |
| `prisma/migrations/<timestamp>_immutable_double_entry_ledger_foundation/migration.sql` | Tables/checks/FKs/triggers/backfill/grants                                 | Reviewed PostgreSQL-specific financial controls      |
| `package.json`                                                                         | Add clean/build/lint/typecheck/test Ledger script participation            | No production dependency addition                    |
| `pnpm-lock.yaml`                                                                       | Add local workspace importer only if pnpm requires it                      | No third-party version change                        |
| `tsconfig.typecheck.json` and `jest.config.cjs`                                        | Include Ledger source/project                                              | Boundary and unit verification                       |
| `test/integration/ledger-foundation.int-spec.ts`                                       | Real PostgreSQL migrations, constraints, roles, races, rollback            | Release-blocking financial evidence                  |
| `test/integration/support/*` if necessary                                              | Reuse/extend runtime-role and disposable prior-migration helpers           | No production behavior                               |
| `README.md`                                                                            | Document status, commands, limits, and no public Ledger route              | Must not imply capture/refund is enabled             |
| `docs/runbooks/ledger-invariant-failure.md`, runbook index                             | Stop/preserve/diagnose/forward-fix guidance                                | Never recommends row mutation                        |
| Architecture/schema notes or ERD, if present at implementation                         | Trace accepted physical design and invariants                              | No boundary/invariant weakening                      |

The Foundation should not change `apps/api/**`, `apps/worker/**`, OpenAPI, payment/event/Webhook code, Compose, environment variables, or any public contract. A new app composition dependency belongs to the later accepted capture/refund milestone.

## API and integration impact

- **REST/OpenAPI:** None. No endpoint, scope, DTO, problem code, response, or OpenAPI artifact changes.
- **Payments:** No behavior change. Later capture/refund orchestration consumes the Ledger port after its remaining gates are accepted.
- **Idempotency:** No schema/code change. The Foundation defines business-key defense in depth but does not acquire/replay keys.
- **Eventing/RabbitMQ/Webhooks:** None. No new event, route, queue, consumer, projection, or signature content.
- **Settlement/Reconciliation:** None. Future modules may add account/business types and read ports through their own ADR/migration.
- **Compatibility:** Additive internal tables/package only. Existing API/worker binaries remain compatible because no current path reads/writes Ledger.
- **Future Ledger GET:** Explicitly deferred. It must be merchant-scoped, authorize `ledger:read`, hide internal IDs, and decide entry/account representation before implementation.

## Database and migration impact

The migration must support both:

1. a fresh empty database applying the entire history with `settleflow_app` provisioned at the documented point; and
2. an upgrade from commit `8cd49e4`/migration `20260802150000_signed_webhook_delivery_and_retries` containing representative merchants, Payment Intents, Idempotency, Outbox/Inbox, Webhook, attempt, and audit evidence.

It is additive to existing tables except for Prisma Merchant relation metadata. The account backfill reads Merchant IDs and inserts authorized Ledger-owned rows; it does not modify Merchant Access data. It must be bounded and measured. The case-study dataset is small, but the migration notes must record locks, row counts, expected duration, and a large-merchant forward strategy.

All constraints/functions/triggers/grants receive stable names. `ON DELETE RESTRICT` is the default. The migration must not:

- alter Payment/Idempotency/Eventing/Webhook/Audit constraints;
- install a broad default privilege or grant table ownership;
- create mutable balance columns or a history covering index without evidence;
- disable existing triggers;
- introduce destructive data cleanup or seed synthetic financial postings;
- use a runtime API connection as migration owner.

Prisma validation alone cannot prove trigger/permission behavior. Integration tests inspect `pg_constraint`, `pg_trigger`, `pg_proc`, `information_schema.role_table_grants`, and actual success/failure under owner and runtime roles.

## Transaction boundaries and concurrency

### Foundation posting transaction

- **Start/end:** supplied by the caller; Ledger neither starts an independent commit nor commits.
- **Isolation:** `READ COMMITTED` baseline; no serializable default without measured predicate requirement.
- **Lock order when composed:** Idempotency row -> Payment Intent row -> immutable Ledger account reads -> Ledger transaction -> Ledger entries -> caller's remaining domain/outbox/snapshot rows as accepted by the capture/refund plan.
- **Network:** none inside the transaction.
- **Uniqueness:** public ID, merchant/business type/reference, account code/currency, entry sequence, and reversal link.
- **Deferred checks:** finalization, minimum entry count, balance, currency, ownership, and exact reversal at commit.
- **Retries:** caller restarts the whole transaction for approved `40P01`/`40001` outcomes and named public-ID collisions. No partial statement retry.
- **Failure:** any exception or commit-time trigger error rolls back all Ledger rows and all caller writes.

### Account provisioning transaction

Provisioning is separate from money commands. It inserts all four approved accounts for one merchant using one transaction and conflict-safe uniqueness. Parallel provisioning converges on one row per key. It never changes an existing account's code/currency/normal side; a mismatch is an incident, not an upsert update.

### Reversal transaction

Deferred until privileged orchestration is approved. Its future lock order begins with Idempotency/operator command ownership, then original Ledger transaction, then original entries in sequence order, followed by new reversal transaction/entries and atomic Operations audit/outbox if required. Unique reversal ownership resolves concurrency. No mutation of the original is ever part of recovery.

## Security and privacy

- There is no HTTP authentication surface in the Foundation. Future callers derive `merchantId` from trusted authenticated/request context, never body/path data.
- Every Ledger account/transaction/entry query includes merchant ownership where it could expose or choose a record. Composite FKs prevent a cross-tenant/currency posting even if an application predicate is defective.
- The shared runtime role remains non-owner, `NOINHERIT`, `NOBYPASSRLS`, without database/schema creation. Ledger grants are explicit and narrow; update/delete/truncate negative tests run against the actual role.
- The staging finalization update is protected by a trigger that compares every immutable column; the role's SQL `UPDATE` grant is not general mutation authority.
- No secrets, API keys, idempotency keys/digests, raw payment/refund requests, response snapshots, provider data, or Webhook data enter Ledger rows.
- Structured logs/traces may use request ID, merchant ID, and public `ltx_` ID as fields, not metric labels. Do not log business references, amounts, entry arrays, account internal IDs, SQL, database messages, or raw Prisma errors.
- Pure builder inputs are bounded before persistence. Database checks remain authoritative against direct/malformed writes.
- Review every raw SQL statement for parameter binding, fixed identifiers/search path, module ownership, timeout/lock impact, and SQLSTATE handling.
- Account provisioning and reversal are financially privileged capabilities. No public/operator surface may be composed until authentication, authorization, reason, and atomic audit controls are approved.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario                     | Expected safe state                           | Retry/recovery                                        | Evidence                                |
| ------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| Missing approved account                          | No Ledger or caller effect commits            | Fail closed; provision through approved separate path | Unit + real DB test                     |
| Zero/negative/over-range entry                    | No transaction commits                        | Correct caller/builder; never coerce                  | Check + service tests                   |
| Zero/single entry                                 | Commit rejected                               | Roll back whole caller transaction                    | Deferred-trigger test                   |
| Debit/credit mismatch                             | Commit rejected                               | Stop affected command path; forward-fix code          | Deferred-trigger/runbook test           |
| Mixed/cross-currency or cross-merchant account    | Commit rejected                               | Treat as invariant/security defect                    | FK/trigger negative test                |
| Unfinalized transaction                           | Commit rejected                               | Transaction rolls back; no cleanup row                | Commit-timing test                      |
| Entry append after posting                        | Original unchanged; insert rejected           | New authorized transaction/reversal only              | Owner/runtime negative test             |
| Account/transaction/entry update/delete/truncate  | Evidence unchanged; statement rejected        | No manual repair; forward-fix/reversal                | Trigger + privilege test                |
| Same business reference race                      | Exactly one Ledger transaction commits        | Losing whole command maps to conflict/replay owner    | Concurrent integration test             |
| Same command key replay                           | Ledger not re-entered after completion        | ADR-0007 snapshot replay                              | Later composed test                     |
| Public `ltx_` collision                           | No partial posting                            | Roll back and retry whole transaction, maximum three  | Forced-ID integration test              |
| Deadlock/serialization error                      | No partial posting                            | At most three whole-transaction retries by caller     | Injected SQLSTATE/race test             |
| Crash/error after transaction or any entry insert | No committed Ledger/caller effect             | Rollback; repeat through Idempotency ownership        | Failure-point tests                     |
| Crash after database commit before HTTP response  | Complete immutable posting remains            | ADR-0007 replay; no Ledger repeat                     | Later composed test                     |
| Second/same-side/altered/cross-tenant reversal    | Original unchanged; commit rejected           | Investigate privileged command; never mutate          | Reversal constraint tests               |
| PostgreSQL unavailable                            | No effect                                     | Future API returns safe 503; readiness fails          | Existing readiness + later command test |
| RabbitMQ unavailable                              | Outside Foundation; no transaction dependency | Future outbox remains pending                         | Existing relay evidence                 |
| Trigger/migration invariant defect                | Affected command surface disabled             | Preserve IDs/evidence; forward-fix migration/code     | Runbook exercise                        |

No recovery path drops constraints, disables triggers, edits/resequences entries, changes sides/amounts/currency, deletes a duplicate, recalculates a stored balance, or reuses a business reference for a different effect.

## Observability and operations

- Define/emit `ledger.post` span around future posting service use. Include bounded outcome/business type and correlation IDs; exclude amounts, business references, and entry bodies.
- Counters: successful Ledger transactions by bounded business type, invariant failures by stable class, duplicate business-reference conflicts, missing-account failures, ID-collision retries/exhaustion, and whole-transaction retries as owned by the coordinator.
- Optional timing histogram: Ledger posting duration without merchant/business/public IDs as labels.
- No readiness change in the Foundation because it creates no composed runtime responsibility; API/worker already require PostgreSQL for their current work.
- Add a Ledger invariant-failure runbook: disable affected command path, capture request/public Ledger/event IDs, inspect named constraints/migration/metrics, preserve evidence, test a forward fix/reversal in a disposable restore, and never patch production entries.
- Define an account-provisioning completeness query for operators/tests. It reports counts/IDs only and does not derive or expose merchant balances.
- Alert thresholds/destinations remain Operations-owned and **To be decided** before a production-like capture/refund release. Correctness failures are release/command-path blockers regardless of threshold.
- Existing database backup/restore exercises must later add invariant validation after restore. Ledger records remain authoritative even if telemetry is unavailable.

## Test strategy

- **Unit:** exact capture/refund debit-credit goldens; exact reversal inversion; amount/currency/business-reference/request-ID/public-ID validation; account mapping; missing/mismatched provisioning; no arbitrary entries; monotonic prefix/pattern and collision-bound behavior; error redaction.
- **Database constraints/migrations:** empty and committed-prior upgrade; four-account backfill/idempotency; all checks/FKs/uniques; zero/single/unbalanced/mixed/cross-tenant failures; unfinalized commit; late append; exact/invalid reversals; role grants; owner/runtime update/delete/truncate negatives; no balance column; no unexpected existing-table rewrite.
- **Integration with real dependencies:** use PostgreSQL Testcontainers and actual owner/runtime URLs. Valid posting and caller marker commit together; injected failures at every stage roll both back. RabbitMQ is unnecessary for the Foundation-focused suite because no Eventing behavior changes.
- **Contract:** internal TypeScript port shape and fixed posting golden vectors. No OpenAPI/event contract change; run OpenAPI drift check as regression evidence.
- **Concurrency/race:** parallel account provisioning; same/different merchant business references; forced public-ID collision; future reversal single-winner; repeated race runs. Later capture/refund suite owns 50-request same/distinct-key proof.
- **Failure injection/recovery:** errors after transaction insert, entry 1, entry 2, finalization, caller marker, and before commit; database outage; deadlock/serialization classification; invariant-runbook tabletop.
- **Security:** tenant predicates, composite cross-tenant failure, runtime-role least privilege, owner trigger protection, SQL parameterization/search path, log/error scans, no secret/body/reference leakage.
- **Performance:** measure deferred-trigger queries and account backfill. Explain transaction-by-public/business reference and entries-by-transaction lookups. Do not add the account-history covering index without measured need.
- **Regression:** all current API, worker, Merchant Access, Payment Intent, Eventing, Operations, Webhook, integration, build, readiness, and OpenAPI tests stay green.
- **Documentation/link checks:** Prettier/Markdown formatting, local-link resolution, invariant/ADR/plan traceability, `git diff --check`, complete diff inspection, and Git status.

### Required database cases

At minimum, the focused integration suite must prove:

1. exact ETB and USD capture/refund postings commit separately;
2. zero-entry, single-entry, unbalanced, mixed-currency, and unfinalized transactions fail at commit rather than being reported successful;
3. zero/negative/unsafe amounts and malformed IDs/references fail through named constraints;
4. cross-merchant and cross-currency account composition fails;
5. the same business reference cannot create a second effect, including concurrent attempts;
6. committed entries cannot be appended/updated/deleted/truncated and transactions/accounts cannot be mutated;
7. one exact reversal succeeds, and every altered/double/chained reversal fails;
8. all failure points roll back a caller-owned sentinel/domain/outbox-style marker with the Ledger rows;
9. `settleflow_app` can provision/insert/finalize/read only the approved shapes and cannot bypass controls;
10. migration backfill is exact for zero, one, and multiple merchants and does not affect unrelated records.

## Verification commands for implementation

Exact commands, subject to adding the focused Ledger scripts described above:

```powershell
git status --short --branch
pnpm install --frozen-lockfile
pnpm infra:up
pnpm db:provision-runtime-role
pnpm prisma:validate
pnpm prisma:generate
pnpm db:migrate:apply
pnpm db:migrate:status
pnpm exec jest --selectProjects ledger --runInBand
pnpm exec node --experimental-vm-modules ./node_modules/jest/bin/jest.js --selectProjects integration --runInBand test/integration/ledger-foundation.int-spec.ts
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm openapi:check
git diff --check
git status --short --branch
```

Migration-from-prior and empty-database proof must use disposable Testcontainers/databases, not `db:reset` against the developer's named volume. Add and document a focused `test:ledger` script during implementation; until then it is **To be defined**, not passed. Capture/refund race commands remain in their later plan and cannot be claimed by this Foundation.

## Documentation impact

Implementation documentation:

- retain ADR-0020's owner-approved Accepted status and accurate ADR index;
- update this plan's checklist/evidence/deviations;
- update README with the implemented internal Foundation, exact verification commands, lack of public route, and continued capture/refund exclusion;
- add/index the Ledger invariant-failure runbook and account-provisioning completeness query;
- update architecture/schema/ERD notes with actual columns, constraints, triggers, permissions, and port boundary;
- add posting/reversal golden examples containing synthetic values only;
- update the Payment Capture and Refund plan to reference the accepted/verified Foundation before its own implementation starts;
- do not update OpenAPI/events/Webhooks until an authorized consumer milestone actually changes those contracts.

## Rollback or forward-recovery strategy

Before any posting exists and while no application path imports Ledger, a defective additive migration can be corrected in a disposable environment. Production-like rollout should still favor a new reviewed forward migration rather than editing migration history.

After any Ledger transaction exists:

- disable future posting/reversal command composition if an invariant/mapping defect appears;
- leave all account/transaction/entry rows, IDs, business references, and correlation evidence intact;
- do not roll back by dropping tables/constraints/triggers, deleting rows, changing entries, or restoring Payment projections alone;
- build and verify a forward fix against a restored copy;
- correct an accounting effect only through an approved exact reversal/new business transaction with future privileged audit;
- validate INV-01 through INV-06 and related Payment/outbox correlation after database restore.

No automatic downgrade can preserve unknown future posted rows, so the post-data recovery policy is forward-only.

## Risks and assumptions

| Risk or assumption                                                   | Impact                                                   | Mitigation/validation                                                                                       | Owner/deadline                             |
| -------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Shared runtime role cannot enforce TypeScript module ownership alone | Another adapter could attempt Ledger writes              | Explicit grants/triggers, boundary checks, reviews, Ledger-only repository imports                          | Architecture/DB / implementation review    |
| Finalization update is too permissive                                | Posted transaction mutation                              | Trigger compares every other field and permits one null-to-set transition only                              | DB reviewer / migration review             |
| Entry-only trigger misses zero-entry transaction                     | Invalid transaction could commit                         | Deferred trigger on transaction insert/finalization as well as entries                                      | DB reviewer / constraint tests             |
| Deferred aggregate trigger repeats work per row                      | Command latency/lock duration                            | Small posting shape, inspect trigger plans/timing, optimize without weakening commit check                  | Ledger/DB / before route enablement        |
| Future work needs values above the accepted JSON-safe ceiling        | Internal range/contract mismatch                         | Retain ADR-0010-aligned ceiling; require superseding ADR and string contract for any expansion              | Project owner / future milestone           |
| Merchant-scoped provider clearing may not fit future reporting       | Future platform-level reports may expect global clearing | Retain the accepted tenant model; later reporting may aggregate through authorized read models              | Financial reviewer / future milestone      |
| Existing/future merchant misses accounts                             | Money command fails                                      | Exact backfill, completeness query, fail closed, later audited onboarding orchestration                     | Merchant/Ledger owners / before capture    |
| Account chart expansion is needed for Settlement/fees                | Closed checks block later posting                        | Additive ADR/migration; do not precreate unauthorized accounts                                              | Settlement/Ledger owners / later milestone |
| Opaque business reference lacks a cross-module FK                    | Source deletion/link defect might not be DB-enforced     | Source financial rows use RESTRICT/immutability; unique bounded reference and integration correlation tests | Architecture/DB / ADR acceptance           |
| Public-ID collision inside caller transaction                        | Partial retry could corrupt command                      | Named error, full rollback, outer whole-transaction retry, forced collision tests                           | Ledger/Payments / integration              |
| Exact reversal trigger is complex                                    | False accept/reject of correction                        | Pure golden builder plus database positive/negative matrix and independent review                           | Financial/DB / before acceptance           |
| Prohibiting reversal chains limits operational recovery              | Reinstatement needs new authorized business posting      | Explicit owner choice; later superseding ADR if chains are required                                         | Project/Operations / ADR acceptance        |
| No public Ledger read in Foundation                                  | Spec endpoint remains incomplete                         | Separate contract milestone after schema stability                                                          | API/Ledger / before v1 release             |
| Indefinite retention grows storage                                   | Operational cost                                         | Measure volume/storage; no deletion until approved retention mechanism                                      | Operations / production review             |
| No dedicated Ledger role/security-definer function                   | Least privilege relies on shared role + triggers         | Runtime permission tests; revisit only with a superseding data-access ADR                                   | Security/DB / ADR acceptance               |

## Implementation order

1. Obtain explicit approval for ADR-0020 and all twelve decisions; update only ADR status/reviewer traceability as authorized.
2. Keep capture/refund routes absent. Reconfirm clean main and prior migration baseline; update this plan to `Approved`.
3. Add the Ledger workspace package, pure types/builders/errors, Jest/TypeScript/boundary wiring, and exhaustive unit goldens.
4. Add Prisma Ledger enums/models/relations without generating a migration from an owner-connected shared development database.
5. Create/review the migration: tables/checks/FKs first, deferred/finalization/immutability/reversal functions and triggers, account backfill, then runtime grants.
6. Generate/validate Prisma and implement the Ledger repository/application/provisioning ports with documented parameterized raw-SQL exceptions only.
7. Add focused real-PostgreSQL migration/constraint/permission/atomicity/race tests, including prior-version and empty-database paths.
8. Add runbook/schema/README documentation without adding routes, app composition, or public contracts.
9. Run the complete verification matrix and independent financial/DB/security review; inspect all generated/migration SQL and query plans.
10. Record exact commands/results/deviations in this plan. Keep ADR/plan implementation changes uncommitted until owner review; do not enable capture/refund here.

## Execution checklist

- [x] Authoritative specification, invariants, boundaries, current schema/patterns/tests, and capture/refund prerequisite inspected.
- [x] Proposed ADR and detailed Foundation design drafted.
- [x] ADR-0020 and all material decisions approved.
- [x] Plan accepted with owner decisions recorded.
- [x] Ledger module, schema, migration, and runtime permissions implemented.
- [x] INV-01 through INV-06 unit/database/integration/permission/race gates pass.
- [x] Migration-from-empty/prior and account-backfill evidence passes.
- [x] Security, raw-SQL, module-boundary, and financial-controls reviewed against the accepted baseline.
- [x] Runbook/schema/README documentation updated.
- [x] Complete commands/results/deviations recorded.

## Verification record

| Command or review                                       | Result | Date/evidence                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implementation baseline/status                          | Pass   | 2026-08-02: clean `main` at accepted commit `71a869a`, tracking `origin/main`; no commit or push during implementation                                                                                                                                                               |
| Authoritative specification/repository review           | Pass   | 2026-08-02: full structural specification read plus ADR/invariant/boundary/schema/permission/pattern review; no `.docx` change                                                                                                                                                       |
| Frozen install and dependency scope                     | Pass   | 2026-08-02: all 11 workspace projects already up to date; lockfile adds only the local Ledger importer and no third-party dependency                                                                                                                                                 |
| Compose/PostgreSQL/RabbitMQ health                      | Pass   | 2026-08-02: pinned PostgreSQL 18.4 and RabbitMQ 4.3.4 containers healthy; `pg_isready` and broker ping passed                                                                                                                                                                        |
| Prisma validate/generate/migration status               | Pass   | 2026-08-02: Prisma 7.9.1 validation/generation passed; additive migration applied locally; all seven migrations reported up to date                                                                                                                                                  |
| Focused Ledger unit tests                               | Pass   | 2026-08-02: 2 suites, 17 tests; exact posting vectors, bounded inputs, reversal, provisioning, transaction-port, and observer isolation                                                                                                                                              |
| Focused real-PostgreSQL Ledger integration              | Pass   | 2026-08-02: 1 suite, 6 tests; populated-prior upgrade/backfill, exact postings, incomplete chart, rollback/races, deferred checks, immutability, reversal, tenant scope, and grants                                                                                                  |
| Full unit regression                                    | Pass   | 2026-08-02: 34 suites and 158 tests passed across all nine Jest projects                                                                                                                                                                                                             |
| Full integration regression                             | Pass   | 2026-08-02: final clean rerun passed 9 suites/55 tests. An initial run exposed three timing-sensitive pre-existing Payment/Webhook failures; both suites passed immediately in isolation, then the unchanged full rerun passed                                                       |
| Formatting, lint, type-check, production build, OpenAPI | Pass   | 2026-08-02: Prettier, zero-warning ESLint, strict TypeScript, API/worker/package builds, and committed OpenAPI drift check passed                                                                                                                                                    |
| Query-plan review                                       | Pass   | 2026-08-02: merchant account lookup uses `ledger_accounts_merchant_id_code_currency_key`; transaction entry aggregation uses `ledger_entries_transaction_id_entry_seq_key`                                                                                                           |
| Changed-document formatting and local links             | Pass   | 2026-08-02: targeted Prettier passed and all 47 local links across the six changed Markdown files resolve                                                                                                                                                                            |
| Final diff/whitespace/scope/status                      | Pass   | 2026-08-02: `git diff --check` and all 14 untracked-file whitespace checks passed; no app file or Ledger reverse-domain import changed; HEAD remains `71a869a`; changes are unstaged and uncommitted                                                                                 |
| Implementation discoveries                              | Closed | Removed an unsupported `posted_at = created_at` draft check after real PostgreSQL proved Prisma timestamps differ; retained guarded `transaction_timestamp()` finalization. Added four-account completeness enforcement and aligned account code to planned `VARCHAR(64)` plus check |

## Definition of done

Implementation is complete because ADR-0020 was explicitly Accepted; the closed account chart and Ledger package/schema/migration exist; real PostgreSQL proves INV-01 through INV-06, tenant isolation, exact reversal, duplicate defense, immutability, runtime least privilege, migration compatibility, races, and rollback; repository quality gates pass; documentation/runbooks match behavior; no public Ledger/capture/refund/event/settlement/reconciliation/unrelated work entered scope; and no known correctness or security blocker remains.
