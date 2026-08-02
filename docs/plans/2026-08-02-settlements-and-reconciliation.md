# Implementation Plan: Settlements and Reconciliation

- **Status:** Approved
- **Owner:** SettleFlow Project
- **Created:** 2026-08-02
- **Last updated:** 2026-08-03
- **Related issue/PR:** To be decided
- **Related ADRs:** [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0004](../adr/0004-rabbitmq-outbox-inbox-and-message-delivery.md), [ADR-0006](../adr/0006-payment-and-settlement-lifecycle-state-ownership.md), [ADR-0007](../adr/0007-idempotency-key-concurrency-and-response-snapshots.md), [ADR-0008](../adr/0008-api-version-path-and-compatibility.md), [ADR-0010](../adr/0010-payment-currencies-and-amount-range.md), [ADR-0013](../adr/0013-problem-details-audit-and-retention-boundaries.md), [ADR-0016](../adr/0016-webhook-endpoint-api-ownership-and-subscriptions.md), [ADR-0018](../adr/0018-signed-webhook-delivery-contract.md), [ADR-0019](../adr/0019-webhook-delivery-reliability-and-lifecycle.md), [ADR-0020](../adr/0020-immutable-double-entry-ledger-foundation.md), and proposed [ADR-0021](../adr/0021-settlement-ledger-accounts-and-guarded-posting.md)

## Goal

Implement the specification-authorized P0 Settlement Processing and Reconciliation slice without moving real funds. The slice must:

- establish a Settlements-owned, merchant-scoped source of settlement lifecycle truth without adding `settlement_status` to Payments;
- select captured, positive, available, unbatched obligations safely under competing workers;
- snapshot refunds and fees into immutable batch evidence, include post-settlement refunds as future adjustments, and prevent duplicate membership;
- finalize each simulated settlement with one immutable balanced Ledger transaction and one `settlement.finalized.v1` outbox event in the same PostgreSQL transaction;
- accept a bounded, untrusted mock-provider CSV, stage its rows, classify a deterministic reconciliation report, and publish `reconciliation.completed.v1` atomically with report completion; and
- expose tenant-scoped settlement and reconciliation contracts, audit the required privileged actions, and prove INV-01 through INV-10 with real PostgreSQL/RabbitMQ race and failure tests.

The target public surface from specification Table 25 is:

- `POST /v1/settlement-runs`;
- `GET /v1/settlement-batches/{id}`;
- `POST /v1/reconciliation-imports`; and
- `GET /v1/reconciliation-imports/{id}/report`.

The project owner approved Gates 1 through 10 exactly as recorded below on 2026-08-03. Implementation remains blocked until proposed ADR-0021 is reviewed and Accepted; this approved plan cannot itself amend ADR-0020's closed Ledger chart and business-type decision.

### Non-goals

- No real payout, bank transfer, provider API, provider credential, card/bank data, or movement of funds.
- No real settlement export transmission, banking file, settlement confirmation from a rail, or `settlement.exported.v1` producer.
- No manual replay, manual reconciliation disposition, arbitrary correction, mutable Ledger repair, or public reversal API.
- No dashboard, rich operator search UI, customer frontend, Kafka, event sourcing, FX, tax, reserve, dispute, chargeback, or multi-region design.
- No partial capture, authorization flow, new Payment Intent command, or change to capture/refund money semantics.
- No Ledger read API or stored mutable balance.
- No automatic destructive retention job until its authorization, role, batching, referential-evidence, and audit contract is separately approved.
- No claim that `SETTLED` means a real merchant bank payout; the approved state represents finalization into simulated settlement clearing only.

## Specification traceability

- **Sections:** prioritized P0 scope; assumptions A-01 through A-05; actors and permissions; module ownership; money representation; separate payment/settlement lifecycles; Tables 13 through 16; FR-05 through FR-08 and FR-11 through FR-14; reconciliation workflow; runtime responsibilities; module dependencies; concurrency Table 19; data Tables 21 through 23; API Tables 24 and 25; reconciliation CSV Table 28; security Tables 29 and 30; reliability Tables 31 through 34; verification Tables 35 through 38; M3; risk register; OQ-02 and OQ-03; acceptance baseline; traceability appendix.
- **Requirement IDs:** FR-11 authorizes settlement batches; FR-12 authorizes mock-provider CSV reconciliation; FR-05, FR-07, FR-08, FR-13, and FR-14 apply to idempotency, outbox/inbox, correlation, health, and privileged audit. FR-06 and the Ledger rules apply to settlement postings. FR-03 and FR-04 remain Payments-owned inputs, not Settlement write authority.
- **Invariant IDs:** INV-01 through INV-06 govern every new Ledger posting/reversal; INV-07 must remain intact; INV-08 requires unique Payment membership; INV-09 requires one merchant/currency and exact batch totals; INV-10 prohibits duplicate settlement effects. The money, lifecycle-separation, audit-link, and asynchronous-integrity rules are also release-blocking.
- **Acceptance/release gates:** dual-worker settlement race; batch totals/items/Ledger agreement; post-settlement adjustment tests; deterministic golden reconciliation reports; malformed/duplicate/resource CSV cases; tenant isolation; OpenAPI/event schemas; migration from empty/prior; runtime-role permissions; no skipped financial integration tests.

### Authoritative behavior versus unresolved detail

The specification authorizes the capabilities and fixes these boundaries:

- Settlement is owned by Settlements, not Payments.
- Eligibility requires captured value, a positive settleable amount, and the availability time to have arrived.
- Selection uses `FOR UPDATE SKIP LOCKED`, and `settlement_batch_items.payment_intent_id` is unique.
- One batch contains one merchant and one currency.
- Post-settlement refunds create future adjustments without changing the Payment lifecycle meaning.
- Settlement fees and net amounts balance exactly to the gross debit.
- Reconciliation input is untrusted CSV with exact fields, limits, checksum, staging, deterministic matching, mutually exclusive buckets, per-currency totals, and item evidence.
- Settlement/reconciliation actions are auditable, and events are written through the transactional outbox.

The specification does not fix the fee values/rounding, cutoff instant, batch capacity, finalization/export meaning, public identifiers, exact request/response schemas, settlement execution actor, provider-reference format, reconciliation window, status normalization, duplicate-row winner, raw-row limits, event envelopes, or optional Webhook policy. The project owner approved the bounded choices in Gates 1 through 10 on 2026-08-03; implementation must not silently vary them.

## Evidence inspected

The clean baseline is `556de6a` (`feat: add payment capture and refunds`) on `main`, aligned with `origin/main`.

Inspection covered:

- the complete v1.0 `.docx` specification, governance, module boundaries, financial invariants, architecture notes, and accepted ADRs through ADR-0020;
- every existing implementation plan, with particular attention to the accepted Ledger and completed capture/refund plans;
- `prisma/schema.prisma` and all eight committed migrations;
- Payments capture/refund orchestration, exact amount validation, tenant row locking, deterministic provider boundary, idempotency completion, Ledger composition, and outbox construction;
- Ledger posting/reversal builders, closed chart, transaction-aware port, PostgreSQL deferred triggers, immutable records, and runtime grants;
- Eventing contracts, outbox relay, RabbitMQ topology, inbox processing, Webhook projection/delivery, worker lifecycle/readiness, and exact event bytes;
- Merchant API-key scope definitions and Operations audit implementation;
- Payment, Ledger, relay, Webhook, migration, readiness, permission, atomicity, and mandatory race tests; and
- README, API/event documentation, and all current operational runbooks.

## Existing behavior and constraints

- `PaymentIntent` stores captured/refunded projections plus `captured_at` and `available_at`; it has no settlement-status column. Capture currently sets `available_at = captured_at`.
- Capture/refund events are exact, versioned, JSON-safe, at-least-once contracts. `payment.captured.v1` includes `availableOn`; `payment.refunded.v1` includes the refund amount and cumulative refunded amount.
- Payment API representations still return `settlementStatus: "NOT_ELIGIBLE"`. ADR-0006 requires later API composition through a tenant-scoped Settlements read port.
- The Ledger chart contains only `provider_clearing` and `merchant_payable` per ETB/USD merchant. Business types are only `capture`, `refund`, and `reversal`. ADR-0020 explicitly requires approval before settlement accounts/types are added.
- A capture credits `merchant_payable`; every refund debits it. Thus its derived balance already reflects pre- and post-settlement refund obligations, but no approved settlement posting can clear that balance yet.
- Eventing and Webhooks support exactly `payment.created.v1`, `payment.captured.v1`, and `payment.refunded.v1`. Outbox, inbox, subscriptions, projection constraints, AMQP routing, and retained Webhook projections reject unknown event types.
- No Settlement or Reconciliation module/package, table, migration, API, worker, CSV fixture, report, event schema, or runbook exists.
- API-key scope validation already recognizes `settlements:read`, `settlements:write`, `reconciliation:read`, and `reconciliation:write`; no route consumes them.
- Operations audit is append-only but typed and validated only for Webhook endpoint lifecycle actions. The schema can store other 30-character public targets, but the service/repository contract must be generalized deliberately.
- The worker currently runs the outbox relay, three Webhook projection consumers, and Webhook delivery dispatcher. Its readiness and graceful shutdown know nothing about settlement/reconciliation work.
- The repository has no CSV parser dependency and no `examples/` fixtures directory.

## Approved decisions

### Gate 1: Settlement-owned lifecycle facts and Payment API composition

**Approved:** add one Settlements-owned `settlement_positions` record per captured Payment. Store immutable ownership/currency/payment identity plus monotonic captured/refunded/availability facts projected from committed Payment events. Derive public settlement state from Settlement-owned facts and records:

- no position, unavailable capture, or non-positive settleable amount: `NOT_ELIGIBLE`;
- positive unbatched position with `available_at <= database now`: `ELIGIBLE`;
- position linked to a non-finalized batch item: `BATCHED`;
- finalized batch item with no pending adjustment: `SETTLED`; and
- finalized batch item with one or more pending/batched post-settlement adjustments: `ADJUSTMENT_PENDING`.

After all adjustments finalize, the derived state returns to `SETTLED`. The project owner explicitly approved this necessary `ADJUSTMENT_PENDING -> SETTLED` completion even though Table 13 does not list it.

The API entrypoint composes a Payments read with a Settlements read port. Payments does not import Settlements or write Settlement tables. Capture responses may continue returning `NOT_ELIGIBLE` before the asynchronous position exists; later GETs expose the current Settlement-owned state. Batching revalidates the current Payment projections under a Payments-owned transaction-aware lock/read port, so event lag cannot settle stale value.

**Alternatives rejected:** a `settlement_status` column on `payment_intents`; Settlements writing Payments; using Webhook projection as financial truth; trusting an eventually consistent position without locked Payment revalidation.

### Gate 2: Execution, finalization, and simulated `SETTLED` meaning

The endpoint catalog provides `POST /v1/settlement-runs` but no run-read or finalization endpoint, while the runtime table says the worker runs Settlement jobs. The exact finalization/export policy is explicitly open.

**Approved essential slice:** execute one merchant/currency/cutoff run synchronously through a shared Settlements service invoked by the API. Create an immutable `settlement_run` even for a no-op. A run selects at most one bounded batch; inside one transaction it passes through `BATCHED`, posts the Ledger transaction, becomes `SETTLED`, writes audit/outbox/idempotency evidence, and returns the completed run/batch representation. No bank or external export call exists. A later scheduled worker may call the same service only after its system-actor/audit policy is approved.

Under this proposal `SETTLED` means “financially finalized into the simulated settlement-clearing account,” not “bank payout succeeded.” `settlement.exported.v1` and external export remain deferred.

**Alternative requiring a larger contract:** API creates an asynchronous run and the worker leases/processes it. This requires a new `GET /v1/settlement-runs/{id}` endpoint, pending/failed states, leases, and response polling not specified in Table 25.

The synchronous model and simulated-clearing meaning of `SETTLED` are approved. The larger asynchronous resource contract remains deferred and unauthorized.

### Gate 3: Identifiers, request contract, cutoff, ordering, and capacity

**Approved:** use internal UUIDs plus `str_<ULID>` Settlement Run, `stb_<ULID>` Settlement Batch, `sta_<ULID>` Settlement Adjustment, and `rec_<ULID>` Reconciliation Import identifiers. Reuse `ulid@3.0.2`, process-scoped monotonic factories, canonical uppercase ULIDs, unique database guards, and at most three whole-transaction collision attempts.

Proposed Settlement Run body:

```json
{
  "currency": "ETB",
  "cutoffDate": "2026-08-02"
}
```

- timezone is exactly `Africa/Addis_Ababa` under OQ-03's default;
- `cutoffDate` denotes the local business date, stored with the timezone and an exclusive next-local-midnight `cutoff_at` converted to UTC;
- the run is permitted only after that exclusive instant has passed;
- candidates require `available_at < cutoff_at`, positive current captured-minus-refunded value, and no existing batch item;
- deterministic candidate order is `(available_at, payment_intent_id)`;
- one batch claims at most 500 Payments and at most 500 adjustments; and
- aggregate gross, fee, adjustment, and net values must remain JSON-safe `BIGINT`; the run stops before an item that would exceed `Number.MAX_SAFE_INTEGER` and reports whether more eligible work remains.

Different idempotency keys may create later batches for the same cutoff if more work remains. Same key/fingerprint replays exactly; changed input conflicts. The prefixes, exclusive cutoff semantics, closed-date validation, 500-Payment/500-adjustment limits, deterministic ordering, and continuation behavior are approved.

### Gate 4: Fee policy and exact money arithmetic

OQ-02 defaults to a flat-plus-basis-point formula snapshotted per batch item but supplies no rate, flat amounts, rounding, small-payment behavior, or version source.

**Approved formula and closed policy:** calculate with `bigint` as `flat_minor + floor(item_gross_minor * basis_points / 10_000)`. Use immutable deployment-wide policy version `settlement_fee_v1`, provisioned through the database migration rather than mutable environment configuration:

| Currency | `flat_minor` | `basis_points` |
| -------- | -----------: | -------------: |
| ETB      |          600 |            200 |
| USD      |           25 |            200 |

Snapshot `fee_policy_version`, `flat_minor`, `basis_points`, and resulting `fee_minor` on every Payment batch item. Pre-settlement refunds reduce `item_gross_minor` before fee calculation. Items for which `fee_minor >= item_gross_minor` fail the whole run rather than being skipped, capped, or allowed to produce a non-positive net. No merchant may provide or modify its own fee policy through this slice, and any later pricing change requires a new immutable policy version.

Approved ETB golden vector: gross 120,000 minor, percentage fee `floor(120000 * 200 / 10000) = 2,400`, flat fee 600, total fee 3,000, and net 117,000.

### Gate 5: Post-settlement adjustments

**Approved:** a Settlements inbox consumer receives committed captured/refunded events on a dedicated durable queue. A refund whose public ID is already reflected in the finalized batch snapshot creates one positive immutable pending adjustment, unique by merchant and refund ID. Pre-batch refunds only refresh the position and reduce its future item gross.

For a later batch:

- lock all pending adjustments for the merchant/currency before selecting positive obligations;
- do not split an adjustment across batches;
- apply all locked pending adjustments only when Payment gross minus total adjustments minus fees is positive;
- otherwise create a no-op run and retain every adjustment/payment for a future cutoff;
- charge new item fees on new positive obligations only; do not reverse a fee from the original settled batch in this essential slice; and
- finalize adjustment membership and the new batch atomically.

Proposed totals are:

```text
paymentGrossMinor = sum(payment item gross)
adjustmentMinor   = sum(pending adjustment amounts)
grossMinor        = paymentGrossMinor - adjustmentMinor
feeMinor          = sum(payment item fee)
netMinor          = grossMinor - feeMinor
```

The settlement Ledger transaction debits `merchant_payable` by `grossMinor`, credits `fee_revenue` by `feeMinor` when non-zero, and credits `settlement_clearing` by `netMinor`. This is consistent with the refund Ledger debit already posted by Payments and does not double-post the refund.

All-or-nothing adjustment allocation, no original-fee reversal, positive-net deferral, the totals above, and completion back to `SETTLED` are approved.

### Gate 6: Ledger extension

ADR-0020 cannot be stretched implicitly. **Approved plan decision, pending formal ADR acceptance:** proposed [ADR-0021](../adr/0021-settlement-ledger-accounts-and-guarded-posting.md) extends the closed chart with `fee_revenue` (normal credit) and `settlement_clearing` (normal credit) for both ETB and USD, backfilling every existing merchant from four to eight accounts. It extends `ledger_business_type` with `settlement` and adds a fixed `postSettlement` builder/port using the Gate 5 posting. `adjustment` remains outside the Ledger enum because the source refund already posted and the future batch absorbs the debit; adding it requires a separately approved standalone adjustment posting.

The posting business reference is the `stb_<ULID>` batch ID. It participates in the Settlement-owned transaction and retains all ADR-0020 deferred balance, finalization, immutability, tenant/currency, business uniqueness, reversal, role, and retention controls.

There is no public reversal/correction endpoint. A failure before commit rolls back the run/batch/items/adjustments/Ledger/outbox/audit/snapshot. A discovered committed error blocks further settlement and requires a separately authorized, atomically audited Ledger reversal plus Settlement forward-correction design; batch/item evidence is never updated or deleted to conceal the error.

### Gate 7: Settlement actor and audit authorization

Table 25 assigns merchant scopes to Settlement/Reconciliation endpoints, while the actor table says platform operators trigger permitted runs and operator APIs use separate authentication. ADR-0013 classifies settlement execution and reconciliation import as privileged.

**Approved bounded v1 interpretation:** allow a merchant API key with the exact independent scope below to act only on its own merchant, and treat each scoped command as a privileged auditable action:

| Endpoint                                            | Required scope         |
| --------------------------------------------------- | ---------------------- |
| `POST /v1/settlement-runs`                          | `settlements:write`    |
| `GET /v1/settlement-batches/{id}`                   | `settlements:read`     |
| `POST /v1/reconciliation-imports`                   | `reconciliation:write` |
| `GET /v1/reconciliation-imports/{id}/report`        | `reconciliation:read`  |
| Existing `GET /v1/payment-intents/{id}` composition | `payments:read`        |

Write scopes do not imply read scopes. Merchant identity is derived only from the authenticated API key and is included in every database predicate; no merchant ID is accepted in a request. Atomically record `settlement.run_executed`, targeting the `str_<ULID>` run, or `reconciliation.import_created`, targeting the `rec_<ULID>` import, through Operations with actor API-key ID, stable reason `merchant_api_request`, timestamp, request ID, and bounded non-financial details.

**Alternative:** require the not-yet-designed separate platform-operator identity. That blocks public POST implementation until an Operator Authentication/RBAC ADR and module exist.

The project owner approved the merchant-key interpretation and exact scopes. Reads remain ordinary scoped reads and do not create audit rows. A future platform-operator API still requires its own authentication/RBAC ADR and does not weaken these tenant predicates.

### Gate 8: Reconciliation window, provider reference, and matching

The current deterministic provider stores no provider reference. **Approved reference contract:** for mock statements, `provider_ref` is the immutable `ltx_<ULID>` public Ledger transaction ID for capture, refund, or settlement. This uses existing durable evidence and requires no backfilled pseudo-provider identifier. `external_ref` fallback is permitted only after primary lookup fails and is scoped by merchant and event type: Payment external reference for capture, Refund external reference for refund, and the public batch/adjustment ID for settlement/adjustment.

The upload includes explicit UTC `periodStart` inclusive and `periodEnd` exclusive metadata; deriving the comparison window from the file would hide platform-only records at its edges. The recommended maximum window is 31 days. Platform records are snapshotted at Reconciliation processing under repeatable-read semantics and filtered by their authoritative occurrence time.

Approved provider statuses are `succeeded` and `failed`. Committed platform rows expect `succeeded`; a matched `failed` row becomes `status_mismatch`. Provider row arithmetic is exact:

- capture/refund/adjustment: `fee_minor = 0` and `net_minor = gross_minor`;
- settlement: `gross_minor = fee_minor + net_minor`;
- every required amount is a JSON-safe non-negative integer, with positive gross according to event type.

The `ltx_` mock provider reference, inclusive-start/exclusive-end UTC window capped at 31 days, fallback mapping, status enum, and per-event arithmetic are approved.

### Gate 9: CSV, import idempotency, and deterministic classification

**Approved limits and workflow:** strict UTF-8 RFC-4180-style CSV; exact Table 28 headers; maximum 10 MiB, 50,000 data rows, 16 KiB per logical row, 255 Unicode scalars for identifiers/references, no NUL/control characters outside permitted CSV line endings, and bounded parser time. Verify a maintained streaming CSV library's current Node 24/license/security compatibility and pin its exact version during implementation; do not write an ad hoc parser.

The API computes SHA-256 over exact uploaded bytes while parsing into a transactionally staged import. Unique `(merchant_id, content_sha256)` prevents a second import of identical bytes. `Idempotency-Key` fingerprints the checksum plus reconciliation window. Same key/body replays the stored 202/201 contract; a different key with the same checksum returns the existing merchant-owned import only if metadata is identical, otherwise `409 reconciliation_checksum_conflict`.

A worker claims staged imports with `FOR UPDATE SKIP LOCKED`, classifies in one repeatable-read transaction, writes results/summaries, marks complete, and inserts `reconciliation.completed.v1`. A transient database error rolls back the entire classification for retry. A deterministic parse/schema failure creates a failed import with bounded safe diagnostics and no partial final report.

Duplicate classification is approved as “first row by `row_number` is canonical; every later row with the same `provider_txn_id` is `duplicate_provider_row`.” The canonical row continues matching. Then classify each canonical provider row in this precedence:

1. `provider_only` when neither primary nor controlled fallback finds a platform record;
2. `currency_mismatch`;
3. `amount_mismatch` when any gross/fee/net value differs;
4. `status_mismatch`;
5. `matched_exact`.

Finally emit `platform_only` for every in-window platform record not consumed by one canonical provider row. Results are mutually exclusive. Counts and signed `unexplainedDifferenceMinor = providerNetMinor - platformNetMinor` are grouped by currency and must stay within the JSON-safe signed integer range; no currencies are summed together.

The limits, dependency policy, duplicate winner, checksum replay, asynchronous classification, bucket precedence, and signed-difference convention are approved.

### Gate 10: Events, RabbitMQ, and Webhook compatibility

**Approved exact `settlement.finalized.v1` body:**

```json
{
  "eventId": "evt_01K...",
  "eventType": "settlement.finalized.v1",
  "occurredAt": "2026-08-02T21:00:00.000Z",
  "requestId": "req_01K...",
  "merchantId": "11111111-1111-4111-8111-111111111111",
  "batchId": "stb_01K...",
  "cutoffAt": "2026-08-02T21:00:00.000Z",
  "grossAmountMinor": 120000,
  "feeAmountMinor": 3000,
  "netAmountMinor": 117000,
  "currency": "ETB",
  "itemCount": 12
}
```

**Approved exact `reconciliation.completed.v1` body:**

```json
{
  "eventId": "evt_01K...",
  "eventType": "reconciliation.completed.v1",
  "occurredAt": "2026-08-02T22:00:00.000Z",
  "requestId": "req_01K...",
  "merchantId": "11111111-1111-4111-8111-111111111111",
  "importId": "rec_01K...",
  "matchedExactCount": 188,
  "mismatchCount": 16,
  "unexplainedDifferenceMinorByCurrency": {
    "ETB": 40000,
    "USD": 0
  }
}
```

The Settlement body contains exactly the 12 fields shown. Amounts are non-negative JSON-safe integers, `grossAmountMinor = feeAmountMinor + netAmountMinor`, currency is exactly ETB/USD, and `itemCount` counts Payment batch items but excludes adjustment rows. The Reconciliation body contains exactly the nine top-level fields shown. Counts are non-negative JSON-safe integers; `mismatchCount` counts every non-`matched_exact` completed report result, including duplicate, provider-only, platform-only, currency, amount, and status mismatches; and the difference object always contains exactly ETB and USD signed JSON-safe integers calculated as provider net minus platform net. Both contracts reject additional fields.

Both retain the existing flat envelope, `evt_<ULID>`, exact JSON bytes, request correlation, schema version in event type/AMQP header, and no raw CSV rows, external references, idempotency/API keys, internal UUIDs, or secrets. AMQP metadata is exact: `messageId = eventId`; `type` and routing key equal `eventType`; `correlationId = requestId`; delivery is persistent UTF-8 `application/json` with schema version 1; and aggregate type/ID are `settlement_batch`/`batchId` or `reconciliation_import`/`importId`.

The event milestone must:

- expand exact outbox constraints/serializer routing rather than permit arbitrary event JSON;
- publish settlement finalization on routing key `settlement.finalized.v1`;
- add a dedicated Settlements consumer queue bound to `payment.captured.v1` and `payment.refunded.v1`, with inbox deduplication, manual acknowledgement, poison DLQ, reconnection, readiness, and shutdown behavior consistent with ADR-0004;
- add event-specific durable queues/DLQs for new Webhook projections before producers are enabled;
- generalize Webhook subscription/projection storage from payment-only fields to exact discriminated settlement/reconciliation fields while retaining exact signed bytes and no historical fanout; and
- deploy consumers/topology before Settlement/Reconciliation producers.

The specification makes the reconciliation Webhook optional. The approved choice supports subscriptions for both new events through the existing signed-delivery pipeline. A durable Operations-only queue is deferred; publishing with no bound queue remains rejected because mandatory publication would retry forever.

## Approved design

### Ownership and dependency direction

- Add `@settleflow/settlements` and `@settleflow/reconciliation` packages. Both depend on Infrastructure and stable application ports; neither imports another module's repository or writes foreign tables.
- Settlements owns positions, runs, batches, batch items, adjustments, eligibility/finalization policy, and settlement read ports.
- Reconciliation owns imports, staged provider rows, results, summaries, classification, and report read ports.
- Payments exposes only a tenant-scoped transaction-aware revalidation/read port for Settlement; Settlements never mutates Payment Intent or Refund rows.
- Ledger exposes an approved `postSettlement` application port; Ledger remains independent of Settlements.
- Eventing owns outbox/inbox, identifiers, exact event contracts, topology, publisher confirms, and consumer delivery mechanics.
- Operations owns privileged audit rows. The API/worker composes module services and carries actor/request context; it contains no financial or reconciliation policy.
- Webhooks reacts only after committed new events and never participates in Settlement/Reconciliation transactions.

### Settlement lifecycle and eligibility

`settlement_positions` is the Settlement-owned factual projection. Event consumers apply only monotonic event facts and retain source event IDs through inbox records. Migration backfills existing captured/partially-refunded/refunded Payments because a newly declared RabbitMQ queue cannot receive historical publications.

Before batching, the service revalidates each candidate through Payments under the same PostgreSQL transaction:

- authenticated/run merchant matches the Payment tenant;
- currency matches the run;
- status is `captured` or `partially_refunded`;
- `captured_amount_minor > refunded_amount_minor`;
- `available_at < cutoff_at`;
- current captured/refunded values are not older than the Settlement position; and
- no batch item exists for the Payment.

A fully refunded Payment is `NOT_ELIGIBLE`. A pre-settlement partial refund reduces the item gross. A refund that commits after a batch has locked/revalidated the Payment waits for that transaction and then becomes a post-settlement adjustment. No combined Payment/Settlement state is written.

### Settlement transaction

The recommended synchronous run uses ADR-0007 acquisition before the financial transaction. Inside idempotency completion:

1. lock the merchant/currency Settlement stream to serialize adjustment allocation;
2. lock all pending adjustments for that stream in deterministic order;
3. select bounded position candidates with parameterized raw SQL `FOR UPDATE SKIP LOCKED` ordered by availability/internal ID;
4. lock/revalidate the candidate Payment rows through the Payments port and compute exact `bigint` item/fee totals;
5. create immutable run evidence; if no safe positive batch is possible, audit/complete a no-op response without Ledger/outbox writes;
6. insert a `BATCHED` batch, Payment items, and adjustment assignments;
7. call Ledger `postSettlement` with the batch ID as business reference;
8. finalize the batch/adjustments through guarded one-way updates;
9. persist one exact `settlement.finalized.v1` outbox event;
10. append the required Operations audit event and complete the stored response snapshot; and
11. commit everything or roll back everything.

No RabbitMQ, Webhook, CSV, file, DNS, HTTP, provider, telemetry-sink, or export call occurs in the transaction. Approved SQLSTATE deadlock/serialization retries restart the whole transaction no more than three times.

### Reconciliation import and classification

The API authenticates before reading the file, applies byte/time/row limits while streaming, computes the checksum, validates every exact field, and never logs row data. Staging and the import audit/idempotency response commit atomically. Raw values remain restricted Reconciliation evidence, not telemetry.

The worker performs deterministic classification against a repeatable, tenant-scoped platform snapshot through batched stable read ports. A result records only the necessary normalized comparison evidence plus links/public references; reports do not expose raw stored CSV values by default. Completion, summaries, results, and the outbox event commit together. The same baseline plus the same exact file/window produces the same ordered buckets/totals.

Mismatch discovery never updates a Payment, Refund, Settlement, Ledger, outbox, inbox, Webhook, or audit record. A corrected provider file creates a new import. Financial correction uses a separately approved reversal/forward-fix workflow.

## Database and migration design

The names and contracts below are the approved implementation baseline. Use Prisma for routine access and reviewed migration/parameterized SQL for enums, checks, composite ownership FKs, guarded immutability/finalization, claims, aggregation, and role grants Prisma cannot express safely.

### Settlements-owned tables

`settlement_streams`:

| Column        | Proposed contract       |
| ------------- | ----------------------- |
| `id`          | UUID primary key        |
| `merchant_id` | restrictive Merchant FK |
| `currency`    | exact ETB/USD `CHAR(3)` |
| `created_at`  | immutable timestamptz   |

Unique `(merchant_id, currency)`. Migration backfills two rows per existing merchant. The service locks this row to serialize one merchant/currency adjustment stream without serializing unrelated tenants/currencies.

`settlement_positions`:

| Column                                           | Proposed contract                                        |
| ------------------------------------------------ | -------------------------------------------------------- |
| `id`                                             | UUID primary key                                         |
| `payment_intent_id`                              | globally unique restrictive Payment FK                   |
| `payment_public_id`                              | exact `pi_<ULID>` snapshot for bounded reads/correlation |
| `merchant_id`, `currency`                        | repeated composite tenant/currency ownership             |
| `captured_amount_minor`, `refunded_amount_minor` | JSON-safe non-negative `BIGINT`, refunded <= captured    |
| `available_at`, `captured_at`                    | authoritative Payment-event timestamps                   |
| `last_event_id`, `last_event_occurred_at`        | monotonic projection evidence                            |
| `created_at`, `updated_at`                       | projection timestamps, not financial occurrence          |

Indexes support `(merchant_id, currency, available_at, payment_intent_id)` with the selective eligibility predicate proven by `EXPLAIN`. Backfill existing captured/refunded rows before enabling API composition. Guards prohibit tenant/payment/currency identity changes.

`settlement_runs`:

| Column                                        | Proposed contract                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `id`, `public_id`                             | UUID plus unique `str_<ULID>`                                                        |
| `merchant_id`, `currency`                     | one tenant/currency                                                                  |
| `cutoff_date`, `cutoff_timezone`, `cutoff_at` | exact business and UTC cutoff evidence                                               |
| `status`                                      | immutable terminal `completed` or `no_eligible_items` under the synchronous proposal |
| `batch_id`                                    | nullable unique restrictive FK to its batch                                          |
| `more_eligible`                               | bounded continuation indicator                                                       |
| `request_id`, `requested_by_api_key_id`       | correlation/actor evidence                                                           |
| `created_at`, `completed_at`                  | one transaction's authoritative timestamps                                           |

No failed financial row is created for a rolled-back run. Idempotency owns replay.

`settlement_batches`:

| Column                                                                             | Proposed contract                                                                |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `id`, `public_id`                                                                  | UUID plus unique `stb_<ULID>`                                                    |
| `merchant_id`, `currency`                                                          | one tenant/currency; composite ownership key                                     |
| `cutoff_date`, `cutoff_timezone`, `cutoff_at`                                      | immutable run snapshot                                                           |
| `status`                                                                           | guarded `batched -> settled` only                                                |
| `payment_gross_minor`, `adjustment_minor`, `gross_minor`, `fee_minor`, `net_minor` | positive/bounded arithmetic with exact named checks                              |
| `item_count`, `adjustment_count`                                                   | positive bounded counts matching child rows at commit                            |
| `ledger_transaction_id`                                                            | unique restrictive FK/public linkage to one posted Settlement Ledger transaction |
| `created_at`, `settled_at`                                                         | authoritative timestamps                                                         |

Deferred constraints verify item/adjustment counts and totals at commit. Update/delete/truncate are rejected after finalization.

`settlement_batch_items`:

| Column                                                                           | Proposed contract                               |
| -------------------------------------------------------------------------------- | ----------------------------------------------- |
| `id`, `batch_id`, `payment_intent_id`                                            | UUIDs; global unique Payment membership         |
| `merchant_id`, `currency`                                                        | composite ownership with batch/position/Payment |
| `captured_amount_minor`, `refunded_amount_minor`, `gross_minor`                  | immutable selection snapshots                   |
| `fee_policy_version`, `flat_fee_minor`, `basis_points`, `fee_minor`, `net_minor` | exact immutable fee evidence                    |
| `available_at`, `created_at`                                                     | eligibility/claim evidence                      |

Named checks prove positive gross/net, non-negative fee, fee formula/range, captured-minus-refunded equality, supported currency, and bounds.

`settlement_adjustments`:

| Column                                                       | Proposed contract                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `id`, `public_id`                                            | UUID plus unique `sta_<ULID>`                                       |
| `merchant_id`, `currency`                                    | one tenant/currency                                                 |
| `payment_intent_id`, `original_batch_item_id`                | restrictive source links                                            |
| `refund_id`, `refund_public_id`                              | globally unique source Refund identity                              |
| `amount_minor`                                               | positive JSON-safe `BIGINT` equal to the source refund event amount |
| `status`                                                     | guarded `pending -> batched -> settled`                             |
| `batch_id`                                                   | nullable, set once, unique membership through the adjustment row    |
| `source_event_id`, `occurred_at`, `created_at`, `settled_at` | immutable source/finalization evidence                              |

No adjustment mutates the original batch/item/Ledger posting. Delete/truncate is prohibited; only exact lifecycle fields may advance.

### Reconciliation-owned tables

`reconciliation_imports`:

- UUID and unique `rec_<ULID>` public ID;
- merchant, exact SHA-256 bytes, byte/row counts, period start/end, status (`staged`, `completed`, `failed`), request/actor IDs;
- bounded safe failure code/row number, never a raw row or parser exception;
- created/completed/failed timestamps;
- unique `(merchant_id, content_sha256)` and tenant/status indexes.

`reconciliation_provider_rows`:

- import ID and one-based row number unique together;
- exact bounded provider transaction ID, merchant code, provider ref, optional external ref, event type, currency, gross/fee/net `BIGINT`, normalized status, occurred timestamp;
- restricted raw-value JSON or exact bounded raw fields required by the specification, with no formula execution or logging;
- immutable creation timestamp and indexes for deterministic duplicate/provider-ref matching.

`reconciliation_results`:

- UUID, import ID, nullable provider-row ID, result bucket, currency;
- stable platform record type/public reference and matched-by discriminator (`provider_ref`, `external_ref`, or none);
- platform/provider gross/fee/net snapshots needed to explain the bucket;
- bounded safe reason code and deterministic sort fields;
- unique provider-row result, unique platform-record consumption, and exact nullable-shape constraints.

`reconciliation_summaries`:

- import ID plus currency primary key;
- exact counts for every bucket;
- platform/provider gross/fee/net totals and signed unexplained difference, all JSON-safe;
- immutable completed timestamp and checks equating summary counts/totals to result rows through deferred validation.

Raw rows follow the specification's 90-day reference retention, but this slice records expiry metadata only unless a destructive job is separately approved. Import/results/summaries and settlement/Ledger records remain indefinite in the case-study environment.

### Ledger, Eventing, Webhook, Idempotency, and Operations changes

- Add the approved Ledger accounts/business type and backfill exact account sets; replace four-account assumptions with the approved eight-account contract.
- Extend idempotency normalized routes/result references for Settlement Run and Reconciliation Import without weakening existing digest/lease/snapshot checks.
- Extend outbox and inbox constraints with exact new event/consumer discriminators.
- Add Settlement consumer topology/inbox identities and new Webhook event routes/DLQs.
- Generalize `webhook_event_projections` through additive aggregate/discriminated fields; backfill existing Payment projections before making payment-specific columns nullable.
- Expand endpoint subscription checks only for approved new public Webhook events.
- Generalize Operations audit action/target/detail validation and preserve append-only runtime grants.
- Grant `settleflow_app` only required select/insert/guarded-update rights; deny delete/truncate and arbitrary update for all new financial, staging, report, and audit evidence.

### Migration sequencing and compatibility

1. Accept proposed ADR-0021. Gates 1 through 10 already fix the execution, fee, cutoff, adjustment, reconciliation, actor, event, and Webhook contracts for this plan.
2. Apply the Ledger chart/business-type extension and verify account backfill/permissions before Settlement code can become ready.
3. Add Settlement/Reconciliation tables, named constraints/triggers/indexes/grants, and historical Settlement-position backfill.
4. Deploy Eventing topology/serializer and Settlements/Webhook consumers before any new producer is enabled.
5. Deploy worker-compatible schema/code, then API composition/routes; verify mixed old/new API/worker behavior.
6. Enable Settlement runs only after position catch-up and every merchant has the approved chart. Enable Reconciliation only after platform read ports and golden fixtures pass.

Migrations must apply to an empty database and upgrade the complete `556de6a` history with existing Payment/Ledger/outbox/inbox/Webhook/audit evidence. Measure locks for enum/check replacement, account/position backfill, and projection alteration. After the first finalized batch/report, rollback is disable-and-forward-fix; never drop or rewrite evidence.

## API and contract impact

### Settlement API

- `POST /v1/settlement-runs`: `settlements:write`, exact JSON body, `Idempotency-Key`, request ID, approved 201 terminal run representation, safe no-op representation, and RFC 9457 problems.
- `GET /v1/settlement-batches/{id}`: `settlements:read`, tenant-safe 404, batch totals plus bounded item/adjustment page. Default limit 20, maximum 100, opaque cursor, deterministic item ordering.
- Existing `GET /v1/payment-intents/{id}` composes Settlement status through the stable port. Existing Payment mutation and Ledger behavior do not change.

### Reconciliation API

- `POST /v1/reconciliation-imports`: `reconciliation:write`, `multipart/form-data`, one CSV part plus exact window fields, `Idempotency-Key`, request ID, and approved 202 staged/201 failed-or-completed representation according to the approved workflow.
- `GET /v1/reconciliation-imports/{id}/report`: `reconciliation:read`, tenant-safe 404, bounded pending/failed behavior, per-currency summary, and mismatch cursor. Default limit 20, maximum 100; no unbounded raw-row response.

### Approved problem-code vocabulary

- Settlement: `invalid_settlement_request`, `settlement_cutoff_not_closed`, `settlement_batch_not_found`, `settlement_fee_policy_invalid`, `settlement_no_positive_net`, `settlement_run_conflict`, `settlement_invariant_violation`.
- Reconciliation: `invalid_reconciliation_request`, `reconciliation_file_too_large`, `reconciliation_row_limit_exceeded`, `reconciliation_csv_invalid`, `reconciliation_checksum_conflict`, `reconciliation_import_not_found`, `reconciliation_report_not_ready`, `reconciliation_import_failed`, `reconciliation_aggregate_overflow`.
- Shared: existing authentication, insufficient-scope, idempotency, service-unavailable, and internal-error contracts.

Problems never echo amounts, refs, file/row contents, SQL, constraints, credentials, hashes, or internal addresses. Map the approved vocabulary to ADR-0013 and existing RFC 9457 status/response conventions in OpenAPI before implementation; any new semantic or disclosure requires separate review.

## Affected modules and exact future files

This planning milestone creates only this file. Expected later changes are:

| Area/file                                                                                                                                                                                                                                              | Planned implementation                                                                                | Boundary/control                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `docs/adr/0021-settlement-ledger-accounts-and-guarded-posting.md` and `docs/adr/README.md`                                                                                                                                                             | Record the required Ledger chart/type/posting extension                                               | ADR must be Accepted before schema/code    |
| `prisma/schema.prisma`                                                                                                                                                                                                                                 | Add approved Settlement/Reconciliation relations/enums/models and Ledger extensions                   | One physical DB, explicit owners           |
| `prisma/migrations/<timestamp>_settlement_ledger_extension/migration.sql`                                                                                                                                                                              | Extend chart/business type/backfill/triggers/grants                                                   | Ledger-owned reviewed SQL                  |
| `prisma/migrations/<timestamp>_settlements_and_reconciliation/migration.sql`                                                                                                                                                                           | Add tables, constraints, position backfill, indexes, grants                                           | Empty/prior upgrade proof                  |
| `packages/modules/settlements/{package.json,tsconfig.build.json}`                                                                                                                                                                                      | New bounded package metadata                                                                          | Depends on Infrastructure and stable ports |
| `packages/modules/settlements/src/{index,settlement.types,settlement.errors,settlement-policy,settlement.service,prisma-settlement.repository}.ts`                                                                                                     | Lifecycle facts, selection, fees, adjustments, batch finalization/read port                           | Own tables only; reviewed claim SQL        |
| Matching `packages/modules/settlements/src/*.spec.ts`                                                                                                                                                                                                  | State, cutoff, fee, arithmetic, selection, adjustment, retry tests                                    | Pure/adapter proof                         |
| `packages/modules/reconciliation/{package.json,tsconfig.build.json}`                                                                                                                                                                                   | New bounded package metadata                                                                          | No cross-module writes                     |
| `packages/modules/reconciliation/src/{index,reconciliation.types,reconciliation.errors,csv-import,reconciliation-classifier,reconciliation.service,prisma-reconciliation.repository}.ts`                                                               | Bounded staging, matching, classification, report                                                     | Untrusted-file boundary                    |
| Matching `packages/modules/reconciliation/src/*.spec.ts`                                                                                                                                                                                               | Parser limits, golden classifications, arithmetic, idempotency tests                                  | Deterministic proof                        |
| `packages/modules/payments/src/{payments.types,payment-intent.service,prisma-payment-intent.repository,index}.ts` and tests                                                                                                                            | Remove hard-coded GET settlement truth and expose transaction-aware Settlement revalidation/read port | No Settlement write/import                 |
| `packages/modules/ledger/src/{ledger.types,ledger-posting,ledger.service,prisma-ledger.repository,index}.ts` and tests                                                                                                                                 | Approved accounts, settlement type, exact posting builder                                             | ADR-0020 controls preserved                |
| `packages/modules/eventing/src/{eventing.types,eventing.service,prisma-outbox.repository,rabbitmq-topology,rabbitmq-outbox.publisher,index}.ts` and tests                                                                                              | Exact new producer contracts/routes/topology                                                          | No generic arbitrary event                 |
| New `packages/modules/eventing/src/{settlement-finalized-event,reconciliation-completed-event}.contract.ts` and specs                                                                                                                                  | Exact JSON/AMQP validation                                                                            | Versioned compatibility                    |
| Eventing inbox/consumer files and tests                                                                                                                                                                                                                | Settlement lifecycle consumer queue, validation, dedupe, ack/DLQ                                      | Post-commit effects only                   |
| `packages/modules/webhooks/src/{webhook.types,webhook.validation,webhook-endpoint.service,prisma-webhook-endpoint.repository,prisma-webhook-projection.repository,payment-created-webhook-projection.service,webhook-delivery*.ts,index}.ts` and tests | Approved subscription/projection/signing compatibility                                                | Exact bytes/no historical fanout           |
| `packages/modules/operations/src/{operations.types,audit.service,prisma-audit.repository,index}.ts` and tests                                                                                                                                          | General privileged Settlement/Reconciliation audit contract                                           | Append-only owner                          |
| `apps/api/src/settlements/{settlement.controller,settlement.openapi,settlement-body.parser}.ts` and specs                                                                                                                                              | Scoped run/get transport                                                                              | Thin API adapter                           |
| `apps/api/src/reconciliation/{reconciliation.controller,reconciliation.openapi,reconciliation-upload}.ts` and specs                                                                                                                                    | Scoped bounded CSV/report transport                                                                   | No business policy in controller           |
| `apps/api/src/{app.module.ts,http/problem-details.filter.ts,config/environment.ts}` and tests                                                                                                                                                          | Compose modules, map approved problems/config                                                         | Existing API deployable only               |
| `apps/worker/src/{worker.module.ts,config/environment.ts,health/worker-health.service.ts,runtime/worker-runtime.service.ts}` and specs                                                                                                                 | Settlement consumer/import processor, lifecycle/readiness/shutdown/signals                            | Existing worker deployable only            |
| New worker signal services/specs                                                                                                                                                                                                                       | Bounded Settlement/Reconciliation observations                                                        | Telemetry non-authoritative                |
| `apps/{api,worker}/package.json`, root `package.json`, `pnpm-lock.yaml`, `jest.config.cjs`, `tsconfig.typecheck.json`                                                                                                                                  | Workspace edges/scripts/projects; pin reviewed CSV parser only if approved                            | No unrelated upgrade                       |
| `docs/api/openapi.json`, new `docs/api/{settlements,reconciliation}.md`, `docs/api/payment-intents.md`                                                                                                                                                 | Public contracts/composed state                                                                       | Drift-tested artifacts                     |
| New `docs/events/{settlement.finalized.v1,reconciliation.completed.v1}.schema.json` and `docs/events/README.md`                                                                                                                                        | Exact events/AMQP/Webhook policy                                                                      | Consumer-before-producer                   |
| `docs/architecture/{README,module-boundaries,financial-invariants,ledger-foundation}.md`                                                                                                                                                               | Accepted design and invariant traceability                                                            | No specification rewrite                   |
| New `docs/runbooks/{settlement-mismatch,reconciliation-unexplained-difference}.md` and `docs/runbooks/README.md`                                                                                                                                       | Safe diagnosis/containment/recovery                                                                   | No direct financial edits                  |
| `README.md`, `apps/{api,worker}/.env.example`                                                                                                                                                                                                          | Safe commands and approved non-secret settings                                                        | No credentials/real provider               |
| New `examples/reconciliation/*.csv` and expected report JSON                                                                                                                                                                                           | Synthetic golden/malformed/duplicate fixtures                                                         | No real data/formula execution             |
| New `test/integration/{settlements,reconciliation}.int-spec.ts`                                                                                                                                                                                        | Real DB/API/worker/race/failure proof                                                                 | Financial tests cannot be skipped          |
| Existing Payment/Ledger/Eventing/Webhook/migration integration suites                                                                                                                                                                                  | Regression, topology, permissions, composed status, compatibility                                     | Preserve every existing gate               |

No Compose service, deployable, real provider package, object store, frontend, payout adapter, or bank credential is expected.

## Failure, retry, and recovery behavior

| Scenario                                        | Safe state                                                   | Recovery                                                     | Required evidence       |
| ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------- |
| Same Settlement key/body                        | One run/batch/Ledger/outbox/audit effect                     | Stored logical replay                                        | API/integration test    |
| Same key, changed cutoff/currency               | Original effect only                                         | 409 idempotency conflict                                     | Contract test           |
| Dual runs for same merchant/cutoff              | Disjoint Payment items; serialized adjustments; exact totals | Whole transaction retry/new distinct run for remaining items | Mandatory race          |
| Worker/event lag                                | Position may be stale, but no stale financial batch          | Locked Payment revalidation or safe exclusion                | Lag/race test           |
| Refund before Settlement lock                   | Reduced item gross/fee                                       | Batch uses current projection                                | Deterministic race      |
| Refund after finalized batch                    | One pending adjustment per Refund                            | Future positive batch absorbs once                           | Consumer/race test      |
| Pending adjustments exceed positive obligations | No negative/zero-net batch                                   | Retain all evidence for later cutoff                         | Golden/no-op test       |
| Ledger/batch/outbox/audit/snapshot failure      | Entire Settlement effect rolls back                          | Retry exact key after safe transient recovery                | Crash-point suite       |
| Settlement event publish failure                | Finalized DB state plus pending outbox                       | Existing relay retry/lease recovery                          | Broker-outage test      |
| Duplicate Settlement consumer message           | One position/adjustment effect                               | Inbox no-op then ack                                         | RabbitMQ test           |
| Invalid Settlement message                      | No domain effect                                             | Immediate matching DLQ                                       | Poison test             |
| CSV too large/malformed/invalid encoding        | No staged valid report; bounded failed response/evidence     | Correct file and new import                                  | Resource/security tests |
| Same import key/file                            | One import/row set/report/event                              | Replay stored import response                                | API test                |
| Same checksum, changed window                   | No second ambiguous report                                   | Approved checksum conflict                                   | Contract test           |
| Reconciliation worker crash                     | Classification/report/outbox transaction rolls back          | Row becomes claimable on restart                             | Failure test            |
| Platform record changes during classification   | One repeatable snapshot                                      | Whole import transaction retry                               | Isolation test          |
| Duplicate provider rows                         | One deterministic canonical row, later duplicates bucketed   | No platform mutation                                         | Golden fixture          |
| Mismatch/unexplained difference                 | Completed immutable report, no auto-correction               | Inspect/runbook; corrected file is new import                | Golden/runbook test     |
| Aggregate overflow                              | No completed report/batch with unsafe JSON number            | Fail closed with stable error                                | Boundary test           |
| PostgreSQL unavailable                          | API/worker not ready; no partial state                       | Restore and retry exact key/reclaim work                     | Dependency test         |
| RabbitMQ unavailable                            | Settlement/report DB commit may retain outbox                | Worker unready; relay later                                  | Outage test             |
| Committed batch error discovered                | Preserve batch/Ledger/audit/event                            | Disable Settlement; approved reversal/forward fix only       | Incident exercise       |

No recovery deletes/reassigns a batch item, edits a posted Ledger row, changes a completed report bucket, alters a provider row, clears an outbox/inbox record, or invents a second provider effect.

## Security and privacy

- Authenticate and check scope before idempotency, file consumption, or resource disclosure. Every query/lock includes merchant ID in the database predicate.
- Resolve the merchant-code CSV field against the authenticated merchant through a stable Merchant Access read; never accept an arbitrary target merchant.
- Enforce byte, row, field, time, encoding, formula, and aggregate limits before resource exhaustion. CSV content is untrusted even in the mock environment.
- Never log/raw-return CSV rows, amounts, external/provider references, content checksums, request bodies, idempotency keys/hashes, API keys, response snapshots, Ledger entries, SQL, or internal IDs.
- Telemetry may include safe public run/batch/import/event IDs, merchant ID, request ID, state/outcome code, counts, and duration; amounts and CSV content are not labels/log fields.
- Formula-neutralize any later CSV export; this slice returns JSON reports and does not execute spreadsheet formulas.
- Preserve the non-owner `settleflow_app` runtime, schema-creation denial, restricted table grants, fixed-search-path trigger functions, parameterized SQL, and owner-only migrations.
- Require financial/domain, database, security, and architecture review before implementation. A production payout/provider adapter needs a new threat model and ADR.

## Observability and operations

- Trace spans: `settlement.consume`, `settlement.eligibility`, `settlement.finalize`, `ledger.post`, `reconciliation.stage`, `reconciliation.classify`, `outbox.persist`.
- Counters: run outcomes, Payment claims, adjustment creation/application, batch finalization/failure, dual-claim conflicts, reconciliation imports/completions/failures, bucket counts, duplicate rows, inbox dedupe, and whole-transaction retries.
- Gauges: eligible positions, pending adjustments, Settlement runs in flight, oldest staged reconciliation import, unexplained-mismatch report count. IDs/currency are not unbounded metric labels.
- Histograms: Settlement batch duration/item count and reconciliation stage/classification duration/row count. The reference Settlement workload is 10 merchants x 500 candidates; reconciliation is 50,000 rows.
- Structured logs use stable event/code plus safe public IDs/request ID/merchant ID; no financial amounts or file data.
- API readiness continues to require its current dependencies. Worker readiness must reflect active Settlement consumer/processor registration if those responsibilities are enabled; telemetry and merchant Webhooks never decide financial success.
- Add Settlement mismatch and Reconciliation unexplained-difference runbooks. Production alert thresholds, incident contacts, and mismatch materiality remain **To be decided** by Operations.

## Test strategy

- **Unit:** lifecycle derivation; cutoff/timezone boundaries; deterministic candidate ordering; fee formula/rounding; JSON-safe overflow; adjustment classification/allocation; Settlement posting vectors; event contracts; CSV tokenization/limits; row arithmetic; provider-ref/fallback matching; duplicate precedence; mutually exclusive buckets; signed differences; cursor codecs; error mapping; signal redaction.
- **Database:** every model/check/FK/index/trigger/grant; position backfill; eight-account chart; settlement Ledger balance/count/currency; batch child totals/counts; unique Payment/adjustment membership; guarded lifecycle updates; append-only report/audit; runtime-role negative update/delete/truncate; exact outbox/inbox discriminators; query plans.
- **Integration:** authenticated Settlement run and batch read; composed Payment settlement status; pre/post-settlement refunds; atomic batch/Ledger/outbox/audit/snapshot; staged CSV and completed report; exact summaries/items/events; tenant isolation; scopes; API problems; worker readiness/shutdown; RabbitMQ/Webhook exact bytes.
- **Concurrency:** two workers/runs for the same merchant/cutoff; same/distinct idempotency keys; refund versus batch lock; duplicate refund events; adjustment versus batch; duplicate checksums/import claims; serialization/deadlock whole retries. Prove INV-08/09/10 repeatedly with real PostgreSQL.
- **Failure injection:** each insert/finalization boundary, Ledger rejection, audit/outbox/snapshot failure, crash before/after commit, broker outage, consumer before ack, CSV parse limit, classification rollback, report event failure, process restart.
- **Contract:** committed OpenAPI; exact event JSON Schemas/AMQP metadata/Webhook headers; sample CSV and expected report; no undocumented route/state/field; existing Payment contracts unchanged except approved composed status.
- **Security:** foreign merchant/missing equivalence; invalid scopes/credentials; multipart ambiguity; oversized/slow/malformed/BOM/UTF-8/control/quoted-newline/duplicate/formula payloads; SQL parameterization; permission tests; telemetry/problem/artifact scans.
- **Performance:** `EXPLAIN` candidate/import queries; 10 x 500 Settlement run; 50,000-row reconciliation within documented CPU/memory/time; no unbounded arrays/query parameters; publish/consumer catch-up.
- **Regression:** all current Payment, Ledger, Eventing, Webhook, readiness, OpenAPI, migration, build, and documentation gates stay green.

## Verification commands for implementation

Commands are planned, not run by this documentation-only milestone. New focused scripts are **To be defined** during implementation and must not be reported as passed before they exist.

```shell
git status --short --branch
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm infra:up
pnpm infra:ps
pnpm db:provision-runtime-role
pnpm prisma:validate
pnpm prisma:generate
pnpm db:migrate:apply
pnpm db:migrate:status
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:ledger
pnpm test:payments
pnpm test:event-contract
pnpm test:webhooks
pnpm test
pnpm test:integration
pnpm build
pnpm openapi:check
git diff --check
git status --short --branch
```

Future focused gates:

- `pnpm test:settlements` — **To be defined**;
- `pnpm test:reconciliation` — **To be defined**;
- repeated dual-worker/refund-adjustment races — **To be defined**;
- 500-item Settlement and 50,000-row reconciliation performance commands — **To be defined**;
- CSV fixture/schema and Markdown-link validation commands — **To be defined** if not added to an existing script.

## Documentation impact

- Update README setup/demo/limitations and exact API/worker commands.
- Add Settlement/Reconciliation API guides, OpenAPI, event schemas, synthetic CSV/golden report, and safe problem examples.
- Update architecture ownership/lifecycle/Ledger notes and invariant traceability only after decisions are accepted.
- Extend Eventing/Webhook documentation for exact routing/subscriptions and consumer-before-producer rollout.
- Add/index Settlement mismatch and Reconciliation unexplained-difference runbooks with read-only queries and prohibited direct edits.
- Record approved fee/cutoff/reference/import policy, migration rollout, performance environment/results, retention limitation, and explicit simulated-clearing/no-payout meaning.

## Rollback and forward recovery

Before any batch/report exists, disable new routes/consumers and remove unused additive schema only through a reviewed migration. After the first financial/report evidence:

- disable Settlement execution or Reconciliation ingestion independently while preserving reads and existing queues/evidence;
- let database transactions roll back, broker deliveries redeliver, and approved leases/claims recover naturally;
- retain positions, runs, batches, items, adjustments, Ledger, imports, rows, results, summaries, audit, idempotency, outbox, inbox, Webhook deliveries, and attempts;
- use additive forward migrations and consumer-before-producer event versioning;
- correct accounting only through a separately authorized exact reversal/new posting linked to preserved Settlement evidence; and
- create a new import for corrected provider input rather than editing a completed report.

Never roll back by dropping populated tables, changing item membership, deleting mismatches, rewriting a cutoff/fee snapshot, mutating Ledger entries, or purging queues.

## Risks and assumptions

| Risk/assumption                                            | Impact                                          | Mitigation/validation                                                     | Owner/deadline                                    |
| ---------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| ADR-0020 closed chart/type excludes Settlement             | No valid fee/clearing posting                   | Accept proposed ADR-0021 and prove all invariant/permission controls      | Ledger/project owner before migration             |
| Merchant-key privileged execution                          | Tenant escape or over-broad financial action    | Approved independent scopes, tenant predicates, audit, security tests     | Project/security owners before route enablement   |
| Approved cutoff/simulated-finalization semantics           | Boundary defect or misleading `SETTLED`         | Addis Ababa boundary vectors and explicit no-payout contracts             | Settlement owner before schema                    |
| Approved `settlement_fee_v1` may not fit future pricing    | Financial incompatibility if silently mutated   | Immutable policy snapshots/new version only and golden vectors            | Product/financial owner before future policy      |
| Eventual position is stale                                 | Over-settlement after refund                    | Locked Payments revalidation and race tests                               | Payments/Settlement owners before implementation  |
| Historical events cannot populate a new queue              | Existing captures never eligible                | Deterministic migration backfill plus consumer deployment ordering        | Database/Eventing owners before enablement        |
| Approved full-only adjustments may strand obligations      | Delayed merchant Settlement                     | Positive-net deferral metrics/runbook and exact Ledger proofs             | Financial/Settlement owners before enablement     |
| Aggregates exceed safe JSON/BIGINT range                   | Rounding/serialization loss or overflow         | `bigint`/NUMERIC accumulation, bounded batches, fail closed               | Settlement/Reconciliation owners before API       |
| Controlled fallback reference becomes ambiguous            | Wrong platform record may be matched            | Merchant/event scoping, primary-first matching, uniqueness/golden tests   | Reconciliation/Ledger owners before import schema |
| Reconciliation matching contract is mock-provider-specific | Poor fit for a future real provider             | Preserve approved `ltx_` contract; require new adapter/ADR for rails      | Product/Reconciliation owner before provider work |
| Streaming CSV package/version is not yet selected          | Resource, parser, or supply-chain vulnerability | Gate 9 limits plus current compatibility/security review and abuse corpus | Security owner before dependency install          |
| New approved events do not fit current Webhook projection  | DLQ/backlog if producers deploy first           | Exact additive projection and consumer-before-producer rollout            | Eventing/Webhooks owners before producers         |
| Long claim/classification transactions                     | Lock pressure and timeouts                      | Bounded 500/50k workloads, plans, timeouts, measured tests                | Database owner before release                     |
| Completed mismatch has no disposition API                  | Operator cannot record closure in product       | Safe report/runbook now; audited disposition remains deferred             | Operations owner before production-like release   |
| Retention deletion is not implemented                      | Staging growth                                  | Expiry metadata/storage metrics; approved bounded job later               | Operations/Data owner before sustained deployment |

## Deferred work

- Real payout/export delivery, bank confirmation, provider APIs/secrets, and unknown remote outcomes.
- Scheduled/operator-wide Settlement orchestration beyond the approved synchronous merchant-scoped runs.
- `settlement.exported.v1`, payout states, settlement file transmission, and banking format.
- Partial adjustment consumption, negative payout/merchant collection, original fee reversal, fee tiers, negotiated merchant pricing, FX, tax, and reserves unless separately approved.
- Manual replay, mismatch disposition, report deletion, correction APIs, batch cancellation/reopen, and public Ledger reads.
- Production platform-operator authentication/RBAC beyond the approved bounded merchant-key interpretation.
- Destructive raw-row retention execution, dashboards, reconciliation export, settlement list/search, and advanced recovery automation.

## Implementation order

1. Accept proposed ADR-0021; Gates 1 through 10 and their exact decisions are approved and recorded here.
2. Add contract-first unit tests and JSON/OpenAPI/CSV fixtures for identifiers, cutoff, fee, adjustment, matching, buckets, and events.
3. Implement the Ledger chart/business-type/posting extension and prove all existing/new Ledger invariants before Settlement code.
4. Add Settlement/Reconciliation schema, position/account backfills, guarded constraints, indexes, and least-privilege grants; prove empty/prior migrations.
5. Extend Eventing topology/contracts and Webhook projection/subscription compatibility; deploy consumers before producers.
6. Implement pure Settlement policies and transaction-aware repository/service, then mandatory real-PostgreSQL dual-worker/refund races.
7. Implement the Settlement API, idempotency/audit composition, Payment GET state composition, OpenAPI, and runbook.
8. Implement bounded CSV staging/parser tests and Reconciliation matching/classification against stable read ports.
9. Add the worker import processor, completion outbox/audit behavior, report API, fixtures, and Reconciliation runbook.
10. Run all failure, security, permission, performance, migration, contract, event/Webhook, regression, build, documentation, and Git hygiene gates.
11. Record exact results/deviations here and mark Completed only when every approved gate passes. Commit/push remain separate user actions.

## Execution checklist

- [x] Clean baseline, governance, complete specification, architecture, invariants, ADRs, schema/migrations, code, tests, plans, and runbooks inspected.
- [x] FR-11/FR-12 authorization and P0/non-goal boundary recorded.
- [x] Material contradictions and missing decisions identified.
- [x] Gates 1 through 10 approved and exact decisions recorded.
- [ ] Proposed ADR-0021 reviewed and Accepted before Ledger/schema/application implementation.
- [ ] Ledger extension, Settlement/Reconciliation schema, and migrations implemented/verified.
- [ ] API/worker/event/Webhook implementations completed in approved scope.
- [ ] Financial, concurrency, failure, security, permission, performance, and regression tests pass.
- [ ] Documentation, examples, OpenAPI, event schemas, and runbooks updated.
- [ ] Commands/results/deviations recorded below.

## Verification record

| Command/review                                    | Result            | Date/evidence                                                                                                                           |
| ------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline status/HEAD                              | Pass              | 2026-08-02: clean `## main...origin/main` at `556de6a`                                                                                  |
| Authoritative specification/repository inspection | Pass              | Complete v1.0 specification plus governance, architecture, ADRs, schema/migrations, modules, tests, plans, docs, and runbooks inspected |
| Specification authorization                       | Pass with blocker | FR-11/FR-12 authorize the slice; Gates 1-10 were approved on 2026-08-03; proposed ADR-0021 must become Accepted before code             |
| Implementation verification                       | Not run           | Documentation-only planning milestone; no implementation/dependency/migration/API change authorized                                     |
| Plan formatting, links, and diff checks           | Pass              | 2026-08-02: Prettier, 11 local links, `git diff --check`, and untracked whitespace/final-LF checks passed                               |
| Gate approval and proposed ADR documentation      | Pass              | 2026-08-03: targeted Prettier, local-link resolution, changed-file whitespace, and `git diff --check` passed                            |

## Definition of done

Planning approval is recorded when this plan, proposed ADR-0021, and the ADR index are the only worktree changes; every requirement/invariant and committed constraint is traced; the remaining ADR-acceptance blocker is explicit; formatting/links/whitespace pass; and Git status is recorded without implementation, dependency, migration, commit, or push activity.

Implementation is complete only after ADR-0021 is Accepted; Settlement-owned state composes without a Payments column; every finalized batch is one merchant/currency, contains unique revalidated Payments, snapshots exact fees/refunds/adjustments, has one balanced immutable Ledger posting and exact outbox/audit/idempotency evidence; dual workers cannot duplicate membership; post-settlement refunds become one future adjustment; reconciliation produces deterministic mutually exclusive per-currency evidence from bounded untrusted CSV; all new events are consumer-safe and Webhook-compatible under the approved choice; INV-01 through INV-10 and all security/recovery gates pass with real dependencies; and no real payout/provider, manual replay, dashboard, or unrelated work enters scope.
