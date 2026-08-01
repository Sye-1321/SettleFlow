# ADR-0006: Payment and settlement lifecycle state ownership

- **Status:** Proposed
- **Date:** 2026-08-01
- **Decision owners:** SettleFlow project owner, Payments owner, and Settlements owner (approval pending)
- **Reviewers:** Financial/domain and architecture reviewers (To be decided)
- **Supersedes:** None
- **Superseded by:** None

## Context

The specification requires payment status to describe the customer-facing payment lifecycle and settlement status to describe batching and payment of the merchant obligation. Combining them permits invalid transitions and makes post-settlement refunds ambiguous. Specification baseline ADR-004, Table 13, FR-02 through FR-04, and the repository financial rules therefore require separate lifecycles.

The repository also assigns one writer to each table: Payments owns `payment_intents`, while Settlements owns batches, batch items, and adjustments. A physical `settlement_status` column on a Payments-owned row would either make Payments authoritative for settlement or invite Settlements to write another module's table. The conceptual data model's “separate settlement status” does not resolve that physical ownership question.

This ADR records the separate-lifecycle baseline and proposes an ownership interpretation before the Payment Intent create/read slice introduces durable state. It does not authorize capture, authorization, void, refunds, settlement processing, or their endpoints. The repeated partial-refund case is an implied clarification of FR-04 and Table 13; it needs owner confirmation but no new lifecycle state.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): Money representation; Separate payment and settlement lifecycles; Table 13; FR-02 through FR-04; Table 21; recorded baseline ADR-004; OQ-05.
- [Module boundaries](../architecture/module-boundaries.md)
- [Financial invariants](../architecture/financial-invariants.md)
- [Payment Request plan](../plans/2026-08-01-payment-request-domain.md)

## Decision drivers

- Preserve separate payment and settlement meanings.
- Give every authoritative state and table exactly one owning module.
- Keep tenant ownership and financial transitions database-enforced.
- Avoid a circular or direct cross-module write path.
- Make later capture/refund/settlement concurrency reviewable.
- Avoid treating predeclared states as implemented behavior.

## Considered options

### Option A: Separate owners and physical state, with API composition

Payments owns `payment_intents`, payment status, and captured/refunded projections. Settlements owns authoritative settlement progress in settlement-owned records. Before a settlement record exists, the public representation reports `not_eligible`; after settlement functionality exists, an authorized read composition obtains settlement state through a stable Settlements read port.

This preserves one writer per table and prevents a settlement process from mutating Payments persistence. It requires an explicit read-composition and recovery design before settlement work.

### Option B: Store both states on `payment_intents` and let Payments own both

Payments would keep a separate `settlement_status` column and expose commands that Settlements invokes to advance it. This follows a literal physical reading of the conceptual payment aggregate but makes Payments authoritative for another bounded module's lifecycle and creates synchronization/transaction questions around batch membership.

Not selected because ownership becomes misleading and settlement truth can diverge from settlement-owned batch records.

### Option C: Let Settlements update a `settlement_status` column on `payment_intents`

This keeps one row but creates a direct cross-module write. It violates the accepted table-ownership rule and is rejected.

### Option D: Combine payment and settlement states into one enum

This directly contradicts the specification and financial invariants and is rejected.

## Decision

The proposed decision is **Option A**.

- **Payments** is authoritative for the customer-facing payment lifecycle and owns `payment_intents`, `payment_status`, requested amount/currency, captured/refunded projections, and optimistic version.
- **Settlements** is authoritative for settlement lifecycle state and owns the records that establish `ELIGIBLE`, `BATCHED`, `SETTLED`, and `ADJUSTMENT_PENDING`.
- The Payment Intent create/read slice creates only payment status `CREATED`. Until a settlement-owned record exists, its API representation deterministically reports settlement status `NOT_ELIGIBLE`; this value is not a second writable state machine in Payments.
- A future settlement read model or table must be owned and written only by Settlements. Payments and the API may obtain it through a stable tenant-scoped read port. The exact read-composition and consistency contract is **To be decided before M3 settlement implementation** by the Payments and Settlements owners.
- The allowed payment states are `CREATED`, dormant P1 `AUTHORIZED`, `CAPTURED`, `PARTIALLY_REFUNDED`, `REFUNDED`, and `VOIDED`. Predeclaring `AUTHORIZED` does not authorize FR-15 or an endpoint; OQ-05 retains direct capture and defers authorization.
- The allowed payment transitions are:
  - creation -> `CREATED`;
  - `CREATED` -> `CAPTURED` for direct capture;
  - `CREATED` -> `AUTHORIZED` only after FR-15 is separately approved;
  - `CREATED` or `AUTHORIZED` -> `VOIDED` only when no capture posted;
  - `CAPTURED` -> `PARTIALLY_REFUNDED` when cumulative refund remains below capture;
  - another valid partial refund leaves `PARTIALLY_REFUNDED` unchanged;
  - `CAPTURED` or `PARTIALLY_REFUNDED` -> `REFUNDED` when cumulative refund equals capture.
- The settlement transitions remain `NOT_ELIGIBLE -> ELIGIBLE -> BATCHED -> SETTLED -> ADJUSTMENT_PENDING`. No payment transition implies a settlement transition unless the owning module's approved command and invariants establish it.
- Capture/refund later require a payment row lock and atomic payment, ledger, and outbox writes. No generic status setter is permitted.

This proposed physical ownership refines an implementation detail left open by the conceptual data model. Approval must confirm that returning derived `NOT_ELIGIBLE` and later composing a settlement-owned state satisfies the specification; otherwise the ADR must be revised before a migration is created.

## Consequences

### Positive

- Payment and settlement truth cannot be collapsed or written by the wrong module.
- Batch membership and settlement progress remain aligned with Settlements-owned records.
- The initial Payment Intent slice can represent `NOT_ELIGIBLE` without prebuilding settlement tables.
- Later post-settlement refunds can change payment projections and create a settlement adjustment without inventing a combined state.

### Negative

- A later Payment Intent read may require bounded composition with a settlement read port.
- The draft Payment Request plan's proposed `payment_intents.settlement_status` column must be revised if this ADR is accepted.
- Eventual read-model synchronization and availability behavior require a later settlement design.

### Risks and mitigations

- **Derived state mistaken for authority:** Document the owning record and expose one typed read port.
- **Stale settlement projection:** Define freshness and recovery before M3; never use an API projection to post financial entries.
- **Unauthorized dormant state:** Command-specific services and database checks prevent writing `AUTHORIZED` before FR-15 approval.
- **Repeated partial-refund ambiguity:** Treat it as remaining in `PARTIALLY_REFUNDED`; obtain specification-owner confirmation before refund implementation.

## Implementation notes

- The first Payment Intent migration should not add an authoritative `settlement_status` column if this ADR is accepted.
- The create/read API may serialize `settlementStatus: "not_eligible"` while no settlement record can exist.
- Payment status and projections require named database checks; later transitions require real PostgreSQL concurrency tests.
- Every payment query/mutation includes authenticated `merchant_id` in its predicate.
- Exact settlement read-model schema, composition, and transition transactions are outside the Payment Intent create/read milestone.

## Affected requirements and invariants

- **Requirements:** FR-02 through FR-04 and deferred FR-15.
- **Invariants:** INV-07 through INV-09 directly depend on lifecycle separation; INV-10 protects every transition from duplicate effects.
- **Acceptance:** Lifecycle, negative-transition, concurrency, tenant-isolation, and later settlement-race evidence are release-blocking.

## Impact assessment

- **Affected modules and dependency direction:** Payments owns payment state; Settlements owns settlement state; API composition uses stable application/read ports only.
- **Financial invariants and money representation:** No money rule changes; projections remain integer minor units in one currency.
- **Database schema, migration, locking, and transaction boundaries:** Payment status belongs to `payment_intents`; settlement schema is deferred; capture/refund row locks remain mandatory.
- **Idempotency, outbox/inbox, retries, and partial failure:** Later payment transitions still use idempotency and atomic outbox writes; settlement consumers require inbox protection.
- **API, event, webhook, or CSV compatibility:** Payment representations keep separate `paymentStatus` and `settlementStatus` fields.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Merchant-owned payment reads remain tenant-scoped; no new sensitive field is introduced.
- **Observability, alerting, and runbooks:** Later read-model lag and invalid-transition signals require monitoring.
- **Production dependencies and supply-chain impact:** None.

## Verification

- Prove creation writes only `CREATED` payment state and returns derived `not_eligible` settlement state.
- Prove no Settlements adapter imports or writes Payments persistence.
- Add exhaustive allowed/forbidden payment-transition unit tests and database checks.
- Run capture/refund row-lock and cumulative-refund concurrency tests when those commands are implemented.
- Prove post-settlement refund behavior with adjustment ownership during M3.
- Run architecture dependency checks, migration-from-empty/prior, tenant-isolation tests, and `git diff --check`.

## Rollout and recovery

This proposed ADR creates no runtime state. Once payment rows exist, lifecycle corrections use forward-compatible migrations and command-specific forward fixes; they never rewrite posted ledger or audit evidence. A different physical settlement ownership choice requires revising this Proposed ADR before acceptance or superseding it after acceptance.

## Documentation and traceability

If accepted, update the [ADR index](README.md), Payment Request plan, architecture ownership table, Prisma design, OpenAPI descriptions, lifecycle tests, and future settlement plan. Record specification-owner confirmation of the repeated partial-refund interpretation and physical state ownership.
