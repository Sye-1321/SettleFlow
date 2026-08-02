# ADR-0021: Settlement ledger accounts and guarded posting

- **Status:** Proposed
- **Date:** 2026-08-03
- **Decision owners:** SettleFlow Project
- **Reviewers:** Financial, Ledger, database, and architecture owners
- **Supersedes:** None
- **Superseded by:** None

## Context

[ADR-0020](0020-immutable-double-entry-ledger-foundation.md) deliberately closes the v1 Ledger chart to merchant-owned `provider_clearing` and `merchant_payable` accounts for ETB and USD and permits only `capture`, `refund`, and `reversal` business types. It requires a later reviewed ADR before adding settlement accounts, business types, or posting behavior.

FR-11 and settlement Tables 13 through 16 authorize simulated Settlement processing. INV-09 requires each batch to contain one merchant and one currency and requires batch totals to agree with its items. A finalized batch must clear the merchant obligation, recognize the approved fee, and retain one immutable balanced Ledger transaction without claiming that money reached a bank account. The approved [Settlements and Reconciliation plan](../plans/2026-08-02-settlements-and-reconciliation.md) fixes the posting as:

```text
debit  merchant_payable     grossMinor
credit fee_revenue          feeMinor  (omit when zero)
credit settlement_clearing  netMinor

grossMinor = feeMinor + netMinor
```

Refunds already debit `merchant_payable` and credit `provider_clearing` in their Payments-owned transaction. A post-settlement refund therefore becomes Settlements-owned adjustment evidence consumed by a later batch; posting a second standalone Ledger adjustment would duplicate the accounting effect.

This ADR refines an extension point explicitly reserved by ADR-0020. It does not alter the specification's immutable double-entry baseline and does not require a specification version change. Although the project owner approved Gate 6 of the plan, the Ledger baseline remains unchanged until this ADR is reviewed and Accepted.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): FR-06, FR-11, money representation, settlement lifecycle and batching, Tables 13 through 16, and settlement concurrency/recovery rules
- [Financial invariants](../architecture/financial-invariants.md): INV-01 through INV-06 and INV-08 through INV-10
- [Module boundaries](../architecture/module-boundaries.md)
- [ADR-0003](0003-postgresql-prisma-and-financial-data-access.md)
- [ADR-0006](0006-payment-and-settlement-lifecycle-state-ownership.md)
- [ADR-0013](0013-problem-details-audit-and-retention-boundaries.md)
- [ADR-0020](0020-immutable-double-entry-ledger-foundation.md)
- [Settlements and Reconciliation plan](../plans/2026-08-02-settlements-and-reconciliation.md)

## Decision drivers

- Preserve INV-01 through INV-06 for every settlement posting.
- Represent the merchant obligation, fee revenue, and simulated settlement clearing explicitly rather than overloading provider accounts.
- Keep every account and transaction merchant- and currency-scoped.
- Preserve the closed chart, fixed posting builders, deferred database enforcement, immutable entries, and reversal-only correction model from ADR-0020.
- Commit Settlement state, Ledger evidence, audit, outbox, idempotency completion, and response snapshot atomically.
- Avoid double-posting post-settlement refunds.
- Provision existing and future merchants deterministically without runtime account customization.

## Considered options

### Option A: Extend the closed merchant chart and add a guarded settlement posting

Add `fee_revenue` and `settlement_clearing` for ETB and USD, add the `settlement` Ledger business type, and expose one transaction-aware `postSettlement` port that constructs only the approved balanced vector.

This keeps financial meaning explicit and extends ADR-0020 through the same database constraints, immutability rules, tenant isolation, and caller-owned transaction boundary.

### Option B: Reuse `provider_clearing` for settlement clearing and omit fee revenue

This would conflate provider capture/refund clearing with simulated merchant settlement and would either hide the fee or leave no account that balances the gross debit. It weakens auditability and is rejected.

### Option C: Use platform-global fee and clearing accounts

Platform-global accounts could model consolidated corporate books, but they introduce cross-tenant postings, ownership and permission rules, allocation evidence, and reconciliation semantics not authorized for this merchant-scoped v1 Ledger. They are deferred.

### Option D: Add a generic posting API or caller-selected accounts

A generic posting surface would let callers choose accounts, sides, or arbitrary entry vectors and could bypass the closed chart and approved financial behavior. It is rejected.

### Option E: Add an `adjustment` business type and post every post-settlement refund again

Payments already posts the refund. A second adjustment posting would duplicate the debit to the merchant obligation. Adjustment remains Settlements-owned membership evidence, not a separate Ledger effect, unless a future ADR defines a different accounting event.

## Decision

The proposed decision is **Option A**, with the following exact controls.

### Closed chart extension and provisioning

- Extend the approved account-code set with `fee_revenue` and `settlement_clearing`.
- Both new account codes have normal side `credit` and exist once per merchant and supported currency.
- Supported currencies remain exactly ETB and USD. Each merchant therefore has exactly eight approved accounts after migration: four account codes across two currencies.
- The owner migration idempotently backfills the four missing accounts for every existing merchant and updates the named closed-chart/normal-side constraints without changing existing account identity or entries.
- The existing internal provisioning port creates the same exact eight-account set for future authorized provisioning. Settlement posting never creates accounts lazily.
- There is no public chart, account, fee, or provisioning API and no merchant-defined account code.

### Settlement business type and posting port

- Extend PostgreSQL/Prisma `ledger_business_type` with exactly `settlement`.
- Do not add an `adjustment` business type in this milestone.
- Ledger owns a transaction-aware `postSettlement` application port. Settlements supplies merchant ID, ETB/USD currency, `stb_<ULID>` batch business reference, request/occurrence correlation, and exact `grossMinor`, `feeMinor`, and `netMinor` values.
- The port accepts no caller-selected account, side, entry sequence, arbitrary metadata, or independent transaction/commit.
- `grossMinor` and `netMinor` are positive JSON-safe integer minor-unit values. `feeMinor` is a non-negative JSON-safe integer and `grossMinor = feeMinor + netMinor` must hold exactly before any insert.
- Post exactly two entries when `feeMinor` is zero: debit `merchant_payable` by gross and credit `settlement_clearing` by net.
- Post exactly three entries when `feeMinor` is positive: debit `merchant_payable` by gross, credit `fee_revenue` by fee, and credit `settlement_clearing` by net.
- Use `business_type = settlement` and the immutable `stb_<ULID>` batch ID as `business_reference`. Existing unique `(merchant_id, business_type, business_reference)` protection prevents a second Ledger effect for one batch.
- The Ledger public transaction ID remains `ltx_<ULID>` under ADR-0020. Account and entry identifiers remain internal.

### Transaction, concurrency, permissions, and recovery

- `postSettlement` participates in the caller's explicit PostgreSQL transaction and never commits or retries independently.
- The Settlement run, batch/items/adjustments, Ledger transaction/entries, Operations audit, outbox event, idempotency completion, and response snapshot commit or roll back together.
- The orchestrator locks and revalidates Settlement/Payment facts before calling Ledger. Ledger inserts the transaction and fixed entries in deterministic sequence and uses ADR-0020's single uncommitted `posted_at` finalization.
- ADR-0020's deferred balance/count/currency/ownership triggers, immutability triggers, exact reversal rules, and business uniqueness apply unchanged to `settlement`.
- `settleflow_app` retains only the existing minimum account read/internal-provisioning insert, transaction/entry insert, and guarded transaction-finalization rights required by the fixed ports. It receives no account mutation through Settlement execution, arbitrary transaction update, delete, truncate, schema creation, or direct trigger bypass.
- Deadlock or serialization recovery retries the whole Settlement command transaction under the approved bound. No partial Ledger sequence is retried.
- Failure before commit leaves no run, finalized batch, posting, audit, event, or response snapshot. A discovered committed error stops further affected settlement and requires the separately authorized exact ADR-0020 reversal plus a forward Settlement correction; no row is edited or deleted.

### Audit, retention, and observability

- The privileged `settlement.run_executed` Operations audit record is the command audit. Do not create a redundant ordinary-posting audit row in Ledger.
- Ledger settlement records and entries are retained indefinitely. This ADR authorizes no archive, purge, deletion, or mutable repair.
- Emit the existing bounded `ledger.post` span and safe settlement outcome/invariant/duplicate signals without amounts, business references, entries, SQL, or credentials in logs or metric labels.
- No Ledger read API, payout/export behavior, provider integration, reconciliation mutation, manual reversal API, or mutable balance is added.

## Consequences

### Positive

- The Ledger expresses merchant obligation clearance, fee recognition, and simulated settlement clearing explicitly.
- Settlement remains one balanced immutable merchant/currency transaction protected by PostgreSQL at commit.
- Fixed account selection prevents Settlements from constructing arbitrary Ledger entries.
- Existing merchants and future authorized provisioning receive one deterministic closed chart.
- Post-settlement refunds are not double-posted.

### Negative

- Every existing merchant gains four accounts, and all exact four-account assumptions must become exact eight-account assumptions.
- PostgreSQL enum/check replacement and account backfill require measured migration and compatibility sequencing.
- Merchant-scoped `fee_revenue` is a v1 subledger classification rather than a platform-wide corporate accounting model.
- A zero-fee settlement has two entries while a positive-fee settlement has three, increasing invariant test cases.

### Risks and mitigations

- **Incorrect chart backfill:** use deterministic idempotent owner SQL, exact per-merchant/currency count checks, and empty/prior migration tests.
- **Existing posting regression:** retain capture/refund vectors unchanged and run all Ledger/Payments financial tests.
- **Fee or clearing account used with the wrong side:** closed code/normal-side checks plus the fixed builder and golden database tests.
- **Duplicate settlement effect:** batch business-reference uniqueness, caller idempotency, competing-run tests, and one atomic transaction.
- **Refund counted twice:** exclude `adjustment` from Ledger and prove the settlement debit uses the already refund-reduced obligation.
- **Runtime role bypass:** named grants/revocations, trigger enforcement, negative direct-SQL tests, and non-owner execution.
- **Committed accounting error:** disable Settlement, preserve evidence, and use only an approved exact reversal/forward correction.

## Implementation notes

- Extend the Prisma enum and Ledger account/business types only after this ADR becomes Accepted.
- Use reviewed migration SQL for PostgreSQL enum evolution, named chart/normal-side constraint replacement, backfill, grants/revocations, and any ADR-0020 trigger updates Prisma cannot express.
- Keep raw SQL confined to the Ledger-owned migration/adapter and parameterized under ADR-0003.
- Update provisioning and chart validation atomically so a worker/API cannot become Settlement-ready while any merchant lacks the complete account set.
- Deploy the Ledger extension and verify it before enabling Settlement producers or routes.

## Affected requirements and invariants

- **Requirements:** FR-06 immutable double-entry accounting, FR-11 settlement batches, FR-05 idempotency, FR-07 transactional outbox, FR-08 correlation, and FR-14 privileged audit.
- **Invariants:** INV-01 through INV-06 apply directly to the settlement posting. INV-08 through INV-10 are protected through unique batch membership, exact batch/Ledger totals, one batch business reference, and caller-owned atomicity. INV-07 remains unchanged.
- **Module boundary:** Settlements calls the Ledger application port; Ledger does not import Settlements or write Settlement tables.

## Impact assessment

- **Affected modules and dependency direction:** Ledger chart, types, provisioning, fixed posting builder/service/adapter; Settlements later consumes the port. Dependency remains Settlements to Ledger only.
- **Financial invariants and money representation:** Positive/bounded integer minor units, one ETB/USD currency, balanced two/three-entry posting, immutable evidence, and reversal-only correction.
- **Database schema, migration, locking, and transaction boundaries:** Additive enum value, constraint replacement, four-account-per-merchant backfill, existing deferred triggers/grants extended, and one caller-owned transaction.
- **Idempotency, outbox/inbox, retries, and partial failure:** No new Ledger idempotency or messaging store. Business uniqueness is defense in depth; whole Settlement command retries and commits all evidence atomically.
- **API, event, webhook, or CSV compatibility:** No Ledger API or direct event. It enables the separately approved Settlement API/event implementation only after acceptance.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** No new credential or outbound boundary. Authenticated merchant identity must reach Ledger through the Settlement command and every account predicate.
- **Observability, alerting, and runbooks:** Extend Ledger invariant/posting signals and Settlement incident guidance without logging amounts or entry contents.
- **Production dependencies and supply-chain impact:** No new dependency; reuse PostgreSQL, Prisma, and existing ULID infrastructure.

## Verification

- Apply the extension migration to an empty database and upgrade the full prior migration history with existing merchants, Ledger transactions, entries, and runtime-role grants.
- Prove every merchant has exactly `provider_clearing`, `merchant_payable`, `fee_revenue`, and `settlement_clearing` for ETB and USD with exact normal sides and no duplicates.
- Prove existing capture, refund, and reversal postings remain byte-for-byte/accounting compatible.
- Prove approved two-entry zero-fee and three-entry positive-fee settlement vectors commit with exact totals and one `settlement` transaction.
- Reject negative/unsafe amounts, zero/non-positive gross or net, `gross != fee + net`, wrong currency, missing/wrong-tenant accounts, arbitrary accounts/sides, duplicate batch reference, imbalance, mixed currency, and unfinalized posting.
- Prove transaction/entry/account update, delete, truncate, arbitrary finalization, and direct runtime-role bypass fail while the guarded posting succeeds.
- Race the same batch/business reference and force public-ID/deadlock/serialization failures; prove one committed posting and whole-transaction recovery only.
- Inject failure after every Settlement/Ledger/audit/outbox/idempotency boundary and prove no partial commit.
- Run Prisma validation/generation, formatting, lint, type-check, Ledger/Payments/Settlement unit and real PostgreSQL integration tests, migration/status checks, builds, documentation links, and `git diff --check`.

## Rollout and recovery

Do not implement or enable Settlement posting until this ADR is Accepted. Apply the additive Ledger extension first, backfill and verify all account sets, validate mixed-version API/worker compatibility, and prove runtime permissions before enabling Settlement consumers or routes.

Before any settlement posting exists, an unused faulty extension may be corrected through a reviewed migration. After the first settlement posting, preserve all accounts, transactions, and entries; disable Settlement execution and forward-fix. Never rename/reassign populated accounts, remove the enum value, mutate entries, rewrite batch references, or drop financial evidence. Corrections use an approved exact reversal and linked forward Settlement transaction.

## Documentation and traceability

Index this Proposed ADR in [the ADR register](README.md). The approved [Settlements and Reconciliation plan](../plans/2026-08-02-settlements-and-reconciliation.md) records the fee policy, settlement transaction, migration order, APIs, events, reconciliation behavior, and required evidence. If this ADR is Accepted and implemented, update Ledger architecture/schema documentation, invariant matrices, account provisioning guidance, Settlement runbooks, and the plan's verification record.
