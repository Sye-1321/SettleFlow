# Implementation Plan: Payment Capture and Refund Processing

- **Status:** Completed
- **Owner:** SettleFlow Project
- **Created:** 2026-08-02
- **Last updated:** 2026-08-02
- **Related issue/PR:** To be decided
- **Related ADRs:** [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0004](../adr/0004-rabbitmq-outbox-inbox-and-message-delivery.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md), [ADR-0006](../adr/0006-payment-and-settlement-lifecycle-state-ownership.md), [ADR-0007](../adr/0007-idempotency-key-concurrency-and-response-snapshots.md), [ADR-0008](../adr/0008-api-version-path-and-compatibility.md), [ADR-0009](../adr/0009-public-payment-identifiers.md), [ADR-0010](../adr/0010-payment-currencies-and-amount-range.md), [ADR-0011](../adr/0011-payment-intent-external-reference-and-capture-method.md), [ADR-0012](../adr/0012-payment-created-outbox-timing.md), [ADR-0013](../adr/0013-problem-details-audit-and-retention-boundaries.md), [ADR-0016](../adr/0016-webhook-endpoint-api-ownership-and-subscriptions.md), [ADR-0018](../adr/0018-signed-webhook-delivery-contract.md), [ADR-0019](../adr/0019-webhook-delivery-reliability-and-lifecycle.md), and [ADR-0020](../adr/0020-immutable-double-entry-ledger-foundation.md)

## Goal

Add specification-authorized direct capture and refund commands to merchant-owned manual Payment Intents without weakening the financial transaction boundary. A successful command must create exactly one payment transition, one immutable balanced ledger transaction, one versioned outbox event, and one completed idempotency response snapshot in a single PostgreSQL transaction.

The intended public surface is:

- `POST /v1/payment-intents/{id}/capture` for one full direct capture of a `CREATED` Payment Intent; and
- `POST /v1/payment-intents/{id}/refunds` for one positive full or partial refund of a captured Payment Intent.

The release evidence must prove exact integer-minor-unit handling, merchant isolation, allowed lifecycle transitions, no over-capture or over-refund, response-equivalent idempotent replay, immutable balanced postings, atomic outbox intent, and the mandatory same-key/distinct-key capture and concurrent-refund races against real PostgreSQL.

The plan became implementation-ready after the owner approved its recommended command, availability, deterministic-provider, event/topology, and Webhook-compatibility decisions and accepted ADR-0020. The Ledger Foundation was implemented and verified at commit `1e0f8af`; the current milestone is authorized to compose its transaction-aware posting port without exposing a Ledger API.

### Non-goals

- No partial capture. The specification classifies partial capture as P2/document-only; the v1 command captures the full Payment Intent amount or fails without an effect.
- No authorization, authorization expiry, void, automatic capture, additional capture methods, payment-method data, PAN/CVV, bank credentials, or real movement of funds.
- No real card, bank, mobile-money, payout, or provider API integration. A future external provider cannot be placed behind the local stub without a new durable external-effect/recovery design.
- No new Ledger foundation, balance projection, or Ledger read API. This slice composes the accepted Ledger posting port delivered at `1e0f8af`; capture/refund code does not emulate accounting records.
- No settlement batching, eligibility processing, settlement adjustment implementation, reconciliation, fees, FX, tax, disputes, chargebacks, or frontend/dashboard work.
- No new list/read refund endpoint, payment list/search endpoint, manual replay API, operator mutation, retention deletion, or destructive recovery path.
- No synchronous RabbitMQ publish, Webhook delivery, Settlement write, or network call inside a financial transaction.
- No change to existing Payment Intent creation semantics, `payment.created.v1`, Webhook endpoint URL/secret behavior, or signed-delivery retry policy.

## Specification traceability

- **Sections:** prioritized P0/P2 scope; assumptions A-02 and A-03; actor permissions; Payments/Ledger/Eventing ownership; money representation; separate payment/settlement lifecycles; state-transition Table 13; ledger postings Table 14; event catalog Table 16; FR-03 through FR-07; critical capture workflow; concurrency Table 19; data model Tables 21 and 22; API Tables 24 and 25; reliability, telemetry, runbook, verification, race, and M1 release-gate sections.
- **Requirement IDs:** FR-03 direct exactly-once capture; FR-04 full/partial refunds; FR-05 idempotent money-mutating POSTs; FR-06 atomic immutable balanced ledger posting; FR-07 transactional outbox; FR-13 correlation/operations. FR-14 applies only to future privileged recovery, not ordinary merchant commands, under ADR-0013. FR-15 authorization is deferred.
- **Invariant IDs:** INV-01 through INV-07 and INV-10 are directly release-blocking. INV-08 and INV-09 remain preserved for future Settlement work. The global money, lifecycle-separation, audit-link, and asynchronous-integrity rules also apply.
- **Authorization evidence:** the endpoint catalog explicitly authorizes both routes with `payments:write`; the Payments boundary owns `payment_intents`, `refunds`, and payment transitions; the Ledger boundary owns accounting records; and the Eventing boundary owns outbox persistence. The conceptual `refund` is an immutable command/result with a positive amount, Payment Intent FK, and merchant-scoped external-reference uniqueness.
- **Acceptance/release gates:** all payment/ledger constraints and runtime permissions, same/distinct-key capture races, changed-fingerprint replay, concurrent over-refund, atomic crash points, tenant isolation, OpenAPI/event schemas, and migration-from-empty/prior proof are mandatory. A fake/in-memory database cannot satisfy the financial gate.

The apparent scope tension is resolved as follows:

- P0 **direct capture** means full capture of the Payment Intent amount. P2 **partial capture** remains deferred.
- P0 **full or partial refunds** means every refund command supplies a positive amount; an amount below the unrefunded captured value is partial, and an amount equal to the remaining value is full.
- Refunds after a future settlement require a Settlements-owned adjustment. Because no settlement record can exist in the current repository, this slice may prove pre-settlement refunds only. The cross-milestone post-settlement contract must be accepted before Settlement and refund processing coexist.

## Historical baseline at plan creation

Evidence inspected at clean commit `71d8f27`:

- `PaymentIntent` already stores internal UUID/public `pi_<ULID>`, merchant ownership, exact external reference, `BIGINT` amount and zero-initialized capture/refund projections, `MANUAL`, payment status, optimistic version, and timestamps. There is no `Refund` or Ledger model.
- The initial migration's `payment_intents_status_projection_check` intentionally permits only `created` with zero projections. It must be replaced, not bypassed, when transition code is enabled.
- The API exposes only create/read. It uses the existing bearer API-key guard and `payments:write`/`payments:read`, exact raw-body parsing with `lossless-json`, RFC 9457 problems, and tenant-scoped lookup.
- `IdempotencyService` implements ADR-0007's acquisition lease, same-key replay/mismatch/in-progress behavior, row ownership, three whole-transaction retries, and atomic response-snapshot completion. Its TypeScript and database route allow-lists currently admit only `POST /v1/payment-intents`.
- `PaymentIntentService.create` commits Payment Intent, `payment.created.v1`, and the 201 snapshot together. `PrismaPaymentIntentRepository` currently rejects every persisted status except `CREATED`.
- Eventing accepts, validates, relays, and routes only the exact nine-field `payment.created.v1` contract. The outbox event/payload constraints, publisher serializer, mandatory routing, RabbitMQ topology, event documentation, and contract tests are all event-specific.
- Webhook subscriptions, the projection consumer/marker, and the HTTP dispatcher currently accept only `payment.created.v1`. ADR-0018's exact signed-body contract is also explicitly written for that event. Captured/refunded fanout cannot be implied by adding producer rows.
- The non-owner PostgreSQL runtime role `settleflow_app` has scoped table grants. Ledger/refund tables and immutable posting triggers do not exist, and the application must never run financial code as the migration owner.
- Existing unit and real-dependency tests prove create/read atomicity, idempotency, outbox relay, Webhook projection/delivery, and runtime-role controls. There is no capture/refund/ledger race evidence.
- The current API representation uses lowercase payment statuses (`created`) and the ADR-0006-derived uppercase settlement status `NOT_ELIGIBLE`. No Settlement-owned record exists.

Inspection included the authoritative specification, [module boundaries](../architecture/module-boundaries.md), [financial invariants](../architecture/financial-invariants.md), all accepted ADRs, `prisma/schema.prisma`, all migrations, Payments/Idempotency/Eventing/Webhooks code, worker lifecycle, OpenAPI/API/event documentation, runbooks, integration tests, and prior plans.

## Approved implementation decisions

The owner approved all five gates. ADR-0020 records the Ledger decisions; the remaining bounded public-command/provider/event choices are recorded by this approved living plan and the implementation authorization.

### Gate 1: Ledger Foundation — accepted and implemented

**Recommended decision:** create a separate Ledger Foundation ADR and implementation plan before this plan is approved. It must define:

- Ledger-owned `ledger_accounts`, `ledger_transactions`, and `ledger_entries` models;
- `ltx_<ULID>` public transaction identifiers and collision policy;
- business-type/reference uniqueness for one capture or refund posting;
- deterministic per-merchant/per-currency `provider_clearing` and `merchant_payable` accounts, including when/how accounts are provisioned without merchant self-service onboarding;
- capture posting: debit provider clearing, credit merchant payable;
- pre-settlement refund posting: debit merchant payable, credit provider clearing;
- positive-entry, minimum-two-entry, same-currency, deferred balance, append-only, reversal-only, FK, restricted-role, and truncate protections for INV-01 through INV-06;
- a transaction-aware Ledger application port that accepts the existing Prisma transaction context but does not depend on Payments; and
- exact empty/prior migration, permission, concurrency, reversal, and incident-runbook proof.

**Why blocking:** the specification forbids a capture/refund transition without its balanced posting in the same commit. A placeholder ledger ID, mutable balance, deferred later posting, or payment-only implementation would directly violate FR-06 and the atomic transaction boundary.

**Rejected alternatives:** payment-only transitions, fake ledger rows owned by Payments, an asynchronous ledger consumer, a mutable balance column, or direct Payments writes to Ledger tables.

### Gate 2: Public command/resource contract — accepted

The specification authorizes the routes and money semantics but not their complete bodies/status codes/refund representation. The recommended contract is:

- Capture request body contains exactly `amountMinor` and `currency`. The amount must equal the Payment Intent's full requested amount; including it preserves the specification's changed-amount idempotency race. Currency must exactly match the immutable payment currency.
- Refund request body contains exactly `externalRef`, `amountMinor`, and `currency`. Amount is always explicit; omission never means “refund remaining.” Currency must match the payment.
- Refund `externalRef` reuses ADR-0011's exact 1-255 Unicode-scalar, case-sensitive, no-normalization, no-control/surrounding-whitespace rules and is unique per merchant across refunds.
- Successful capture returns `200` with the current Payment Intent representation updated to `paymentStatus: "captured"`, full captured amount, zero refunded amount, incremented version, derived `settlementStatus: "NOT_ELIGIBLE"`, and the `ltx_<ULID>` capture transaction ID.
- Successful refund returns `201` with an immutable refund representation: proposed `rf_<ULID>` `id`, public `paymentId`, exact `externalRef`, `amountMinor`, currency, resulting lowercase `paymentStatus`, `cumulativeRefundedAmountMinor`, `ledgerTransactionId`, and UTC `createdAt`.
- Refund rows have no mutable status. Row existence means the refund committed; rejected/declined commands are idempotency outcomes, not failed financial rows.
- Public refund identifiers use proposed `rf_<ULID>` with an application-side process-scoped monotonic factory, a unique database guard, canonical uppercase input, and at most three complete collision attempts.
- Payment `version` increments once for every successful capture/refund. It is returned as state metadata but is not an `If-Match` precondition for money commands; pessimistic row locking is authoritative.

**Alternatives rejected:** an empty capture body (cannot satisfy the documented changed-amount race), inferred refund amount, partial capture, request currency normalization, floating/decimal major-unit input, mutable refund status, internal UUID exposure, or client-supplied merchant/status/ledger/event fields.

Approval must also fix the exact RFC 9457 code/status matrix below and whether the capture response preserves `externalRef`/`captureMethod` fields already present in the Payment Intent representation.

### Gate 3: Capture availability and post-settlement coordination — accepted

`payment.captured.v1` requires `availableOn`, but neither the specification nor an accepted ADR defines its type or calculation. The recommended reference policy is:

- Payments persists immutable `captured_at` and `available_at` timestamps from one authoritative transaction instant;
- direct simulated capture uses `available_at = captured_at`, encoded in the event as UTC RFC 3339 milliseconds under JSON field `availableOn`;
- this attribute is input to future Settlement eligibility, not a Payments-owned settlement status; and
- API responses continue returning ADR-0006-derived `NOT_ELIGIBLE` until a Settlements-owned record establishes another state.

Before M3, a Settlement ADR must define how a captured event/read port establishes `ELIGIBLE`, how API reads compose that state, and how a `payment.refunded.v1` for a settled payment creates an `ADJUSTMENT_PENDING` Settlements-owned record. This capture/refund milestone must not create Settlement tables or silently reject a state that cannot yet exist.

**Alternative:** use a date plus merchant settlement timezone. That couples capture to the unresolved M3 cutoff/calendar policy and is not recommended without a Settlement decision.

### Gate 4: Deterministic mock-provider boundary — accepted

The specification says provider behavior is simulated but does not define capture/refund provider outcomes. The recommended v1 boundary is:

- a Payments-owned `PaymentExecutionPort` with a local deterministic adapter only;
- no credential, HTTP client, remote side effect, provider readiness dependency, or environment-secret input;
- default local behavior approves valid direct capture/refund commands, while explicit synthetic test fixtures can deterministically decline;
- evaluation occurs after idempotency ownership and before the financial transaction, because it is pure/local and must not extend database lock time;
- a deterministic decline completes a safe replayable problem snapshot but creates no Payment/Refund mutation, Ledger transaction, or outbox event; and
- an adapter/configuration failure is transient `503`, leaves no financial effect, and does not complete a terminal snapshot.

The decline problem code/status and any synthetic provider-reference format are **To be decided**. The recommended minimum stores no provider reference in this milestone because no specification contract defines it. Reconciliation can add a controlled stable match reference through its later ADR/migration.

A real provider cannot reuse this call sequence. External capture/refund has an unknown-outcome/crash boundary and requires a new durable attempt/state/idempotency design before any network adapter is authorized.

### Gate 5: Captured/refunded event and Webhook compatibility — accepted

The specification fixes minimum payload semantics but not exact envelopes. Preserve the current flat event style and propose:

`payment.captured.v1` exact body:

```json
{
  "eventId": "evt_01K...",
  "eventType": "payment.captured.v1",
  "occurredAt": "2026-08-02T10:20:12.345Z",
  "requestId": "req_01K...",
  "merchantId": "11111111-1111-4111-8111-111111111111",
  "paymentId": "pi_01K...",
  "capturedAmountMinor": 125000,
  "currency": "ETB",
  "availableOn": "2026-08-02T10:20:12.345Z",
  "ledgerTransactionId": "ltx_01K..."
}
```

`payment.refunded.v1` exact body:

```json
{
  "eventId": "evt_01K...",
  "eventType": "payment.refunded.v1",
  "occurredAt": "2026-08-02T11:20:12.345Z",
  "requestId": "req_01K...",
  "merchantId": "11111111-1111-4111-8111-111111111111",
  "paymentId": "pi_01K...",
  "refundId": "rf_01K...",
  "amountMinor": 25000,
  "currency": "ETB",
  "cumulativeRefundedAmountMinor": 25000,
  "ledgerTransactionId": "ltx_01K..."
}
```

Both use `evt_<ULID>`, exact JSON-safe integers, version in `eventType`, no outer wrapper, no internal UUID, no `externalRef`, no idempotency/API-key/provider data, and the existing consumer-ready AMQP metadata pattern. Exact event bytes are serialized once and retained through Webhook projection.

The current relay and mandatory publish path cannot route these events safely. Before producer endpoints are enabled, approve and implement:

- routing keys `payment.captured.v1` and `payment.refunded.v1` on `settleflow.domain-events`;
- event-specific durable quorum queues/DLQs or another explicitly approved consumer topology;
- type-dispatched producer validation/serialization and conditional outbox payload constraints;
- `payment.captured.v1` and `payment.refunded.v1` JSON Schemas and contract tests;
- Webhook subscription expansion, projection consumers, generic retained event bytes, and dispatcher event-type headers; and
- a staged rollout that deploys consumers before producers so ADR-0016's processing-time eligibility cannot cause unintended historical fanout.

Recommended queue names are `settleflow.webhook-projection.payment-captured.v1` and `settleflow.webhook-projection.payment-refunded.v1`, with matching `.dlq` queues through `settleflow.dead-letter`. This naming/topology and whether queues may accumulate before their consumers are ready require approval. Binding the new routing keys to the existing created-only queue is rejected because its strict consumer would dead-letter valid new event types. Publishing with no bound queue is rejected because `mandatory` returns would keep every outbox row pending.

ADR-0018 currently fixes exact signed delivery specifically for `payment.created.v1`. It must be generalized or supplemented before captured/refunded HTTP delivery; implementation must not assume its nine-field wording automatically approves the new bodies.

## Proposed design after approval

### Domain state and transition rules

Payment state remains the only customer-facing lifecycle authority:

| Current state           | Command                    | Required amount/state checks                                                                   | Result state         |
| ----------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- | -------------------- |
| `CREATED`               | Full direct capture        | Request amount equals `amount_minor`; currency matches; captured/refunded projections are zero | `CAPTURED`           |
| Any other state         | Capture                    | No second/partial/after-refund capture is permitted                                            | No change; conflict  |
| `CAPTURED`              | Refund less than capture   | `0 < refund < captured_amount_minor`; cumulative value checked under payment lock              | `PARTIALLY_REFUNDED` |
| `CAPTURED`              | Refund equal to capture    | `refund = captured_amount_minor`                                                               | `REFUNDED`           |
| `PARTIALLY_REFUNDED`    | Refund less than remainder | `0 < refund < captured_amount_minor - refunded_amount_minor`                                   | `PARTIALLY_REFUNDED` |
| `PARTIALLY_REFUNDED`    | Refund equal to remainder  | cumulative refunds equal captured amount                                                       | `REFUNDED`           |
| `REFUNDED`              | Refund                     | Remaining refundable amount is zero                                                            | No change; conflict  |
| `CREATED`/other invalid | Refund                     | No capture exists or lifecycle is unsupported                                                  | No change; conflict  |

`AUTHORIZED` and `VOIDED` remain dormant/deferred. No generic status setter is introduced. A Refund has no mutable state machine: the immutable row, ledger link, and event exist only for a committed refund.

### Money and validation

- Reuse the approved raw-body/lossless-number path. `1000`, `1000.0`, and `1e3` canonicalize to the same integer; fractions, unsafe/out-of-range values, strings, booleans, null, duplicate keys, unknown keys, malformed UTF-8/JSON, zero, and negative values fail before acquisition.
- Every request amount is `1..Number.MAX_SAFE_INTEGER` at the API and becomes `bigint` only after exact validation. Addition/subtraction for remaining/cumulative amounts occurs in `bigint`; conversion back to JSON requires an explicit safe-range assertion.
- Currency is exactly uppercase `ETB` or `USD`, never normalized, and must equal the payment/ledger/refund currency. No FX or cross-currency aggregation exists.
- Capture accepts only the entire requested amount. An amount below or above it is a conflict with no posting, projection, or event.
- Refund accepts any positive amount no greater than `captured_amount_minor - refunded_amount_minor` under the locked row. The post-update projection must remain within `0..captured_amount_minor` and the database check is the final guard.
- Canonical fingerprints use fixed versioned objects and base-10 amount strings. Capture includes public path `paymentId`, amount, and currency. Refund includes public path `paymentId`, exact `externalRef`, amount, and currency. Request ID and transport-only data are excluded.

### API behavior and RFC 9457 errors

Both routes require the existing bearer merchant identity, `payments:write`, exactly one valid `Idempotency-Key`, `application/json`, and an optional validated/generated `X-Request-Id`. Every lookup/lock predicate includes authenticated `merchant_id` plus public Payment Intent ID; missing and foreign resources are indistinguishable.

Recommended problem matrix, pending Gate 2/4 approval:

| Condition                                                                 | HTTP | Stable code                            | Snapshot after acquisition |
| ------------------------------------------------------------------------- | ---: | -------------------------------------- | -------------------------- |
| Malformed ID/body/header, wrong/unsafe amount type, unknown field         |  400 | `invalid_request`                      | No                         |
| Missing/invalid credential                                                |  401 | `unauthorized`                         | No                         |
| Missing `payments:write`                                                  |  403 | `insufficient_scope`                   | No                         |
| Missing or foreign-merchant Payment Intent                                |  404 | `payment_intent_not_found`             | Yes                        |
| Well-formed currency differs from Payment Intent                          |  422 | `currency_mismatch`                    | Yes                        |
| Capture amount differs from full requested amount                         |  409 | `capture_amount_mismatch`              | Yes                        |
| Payment lifecycle cannot capture                                          |  409 | `payment_intent_not_capturable`        | Yes                        |
| Payment lifecycle cannot refund                                           |  409 | `payment_intent_not_refundable`        | Yes                        |
| Refund exceeds remaining captured amount                                  |  409 | `refund_amount_exceeds_available`      | Yes                        |
| Different command collides on merchant refund external reference          |  409 | `refund_external_reference_conflict`   | Yes                        |
| Same key, changed fingerprint                                             |  409 | `idempotency_key_reused`               | Existing ADR behavior      |
| Same key/fingerprint with active owner                                    |  409 | `idempotency_request_in_progress`      | No; `Retry-After: 1`       |
| Completed tombstone after response disposal                               |  409 | `idempotency_key_expired`              | Existing ADR behavior      |
| Deterministic mock-provider decline                                       |  422 | `payment_provider_declined` (proposed) | Yes                        |
| Database/transaction retry exhaustion or transient adapter/config failure |  503 | `service_unavailable`                  | No                         |

Every problem remains `application/problem+json` with stable `type`, `title`, `status`, safe `detail`, `code`, current-attempt `requestId`, and only bounded field/reason violations. No response exposes SQL, constraints, stack traces, raw financial bodies, keys, internal UUIDs, provider fixtures, or another merchant's existence.

### Idempotency and command flow

Normalized routes are literal templates:

- `POST /v1/payment-intents/{id}/capture`
- `POST /v1/payment-intents/{id}/refunds`

For each command:

1. Authenticate, authorize, validate content/header/body/path syntax, and build the canonical semantic fingerprint.
2. Acquire ADR-0007 ownership in a short committed transaction. Replays never re-read current payment state or invoke provider/Ledger/Eventing code.
3. Evaluate the approved pure deterministic provider adapter outside a database transaction. Terminal decline is completed as a safe snapshot; transient adapter failure is not.
4. Generate required candidate public IDs through their owning ports. Any identifier collision retries the whole effect transaction and never only the failed insert.
5. `IdempotencyService.complete` begins the effect transaction, sets bounded lock/statement timeouts, and locks/verifies the idempotency owner.
6. Payments uses reviewed parameterized SQL to select the Payment Intent `FOR UPDATE` with both `merchant_id` and `public_id`. It then rechecks lifecycle, currency, requested/captured/refunded amounts, and arithmetic.
7. For refund, insert the immutable Refund through the Payments repository. For capture, no separate capture table is needed; the single capture is represented by the locked transition plus unique Ledger business reference.
8. Call the Ledger application port with the same transaction. Ledger creates the transaction and exactly two positive same-currency entries using the approved posting. Deferred constraints validate balance/minimum-entry/currency at commit.
9. Update the Payment Intent projection/status/version/timestamps through Payments' adapter, conditioned on the locked internal row and merchant. A refund updates cumulative value exactly once.
10. Construct and persist one `payment.captured.v1` or `payment.refunded.v1` through Eventing with the same transaction.
11. Build the bounded logical success/problem response from transaction result values, set the idempotency row `COMPLETED`, and persist the snapshot/result reference in the same transaction.
12. Commit all domain, refund, ledger, outbox, and snapshot writes together; only then return HTTP. RabbitMQ and Webhooks run after commit and may repeat.

Use PostgreSQL `READ COMMITTED` plus the payment row lock unless real evidence requires `SERIALIZABLE`. Retry only approved deadlock/serialization SQLSTATEs and restart the whole effect transaction, at most the current three attempts. Lock ordering is idempotency row, payment row, then Ledger-owned rows in the Ledger ADR's deterministic order. No broker, HTTP, DNS, provider network, Webhook, Settlement, hashing, or logging sink call may occur while locks are held.

### Audit evidence

Ordinary merchant capture/refund commands do not create Operations `audit_events` under ADR-0013's ordinary-write interpretation. Their durable evidence is:

- authenticated merchant/API-key context in bounded request telemetry;
- idempotency scope/fingerprint/result snapshot and result reference;
- Payment Intent state/version and immutable Refund row where applicable;
- immutable Ledger transaction/entries and business references;
- stable outbox event/event ID and request correlation; and
- later inbox/Webhook delivery evidence.

Manual recovery, replay, reversal, or operator correction remains privileged, reasoned, and audited in a later plan. It is never approximated by direct SQL.

## Database and migration impact

### Payments-owned schema

Proposed additive/constraint migration, after Gate 1 and Gate 2 approval:

1. Add nullable `captured_at TIMESTAMPTZ(6)` and `available_at TIMESTAMPTZ(6)` to `payment_intents`; current rows remain valid `CREATED` rows. Do not add a settlement-status column.
2. Add unique `(id, merchant_id)` if needed for a composite tenant-safe Refund FK.
3. Replace `payment_intents_status_projection_check` with an accepted lifecycle/projection/timestamp check:
   - `created`: captured/refunded zero and capture timestamps null;
   - `captured`: captured equals requested, refunded zero, timestamps non-null/equal under the reference availability policy;
   - `partially_refunded`: captured equals requested, `0 < refunded < captured`, capture timestamps non-null;
   - `refunded`: captured equals requested, refunded equals captured, capture timestamps non-null;
   - dormant `authorized`/`voided` remain non-writable until separately authorized rather than being admitted without complete rules.
4. Create `refunds`:

| Column              | Proposed type/constraint                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `id`                | UUID primary key, internal only                                                            |
| `public_id`         | `VARCHAR(29)`, globally unique, proposed `^rf_[0-7][0-9A-HJKMNP-TV-Z]{25}$`                |
| `merchant_id`       | UUID, restrictive FK to Merchant                                                           |
| `payment_intent_id` | UUID, composite restrictive FK with `merchant_id` to the owned Payment Intent              |
| `external_ref`      | `VARCHAR(255)`, exact bounded format, unique with `merchant_id`                            |
| `amount_minor`      | `BIGINT`, named check `1..9007199254740991`                                                |
| `currency`          | `CHAR(3)`, uppercase ETB/USD checks and transaction-time equality to Payment Intent/Ledger |
| `created_at`        | `TIMESTAMPTZ(6)`, immutable command-result time                                            |

There is no refund status, update timestamp, soft delete, settlement state, provider secret/reference, mutable balance, response body, or event payload column. The Ledger-owned transaction carries the unique Refund business reference and its public ledger transaction ID.

5. Add only evidence-backed indexes: global refund public ID; unique `(merchant_id, external_ref)`; tenant/payment chronological lookup only if a documented query/test requires it. Capture/refund command locking uses the existing unique public Payment Intent ID with an explicit merchant predicate; capture an `EXPLAIN` plan before adding a redundant composite public-ID index.
6. Grant `settleflow_app` only the required `SELECT/INSERT` on Refund and `SELECT/UPDATE` on Payment Intent; revoke Refund update/delete/truncate. Add database triggers rejecting Refund update/delete/truncate if runtime-role denial alone cannot protect owner/migration misuse. Ledger permissions remain entirely Gate 1's migration.

### Idempotency/Eventing schema

- Replace the create-only normalized-route check with an allow-list for the three exact POST templates. Keep method `POST`, digest lengths, state/lease/snapshot consistency, 24-hour minimum response window, and unique scope unchanged.
- Expand `result_reference` to accept `pi_<ULID>` for create/capture and proposed `rf_<ULID>` for refund. Do not store raw route IDs or keys.
- Expand `outbox_events_event_type_check` to the three accepted payment event types and replace the created-only payload check with explicit event-type-discriminated exact-key/type/value checks. Do not loosen it to arbitrary JSON.
- Keep stable `evt_<ULID>`, pending/lease/publish semantics, uniqueness, pending index, and terminal retention unchanged.
- Apply exact runtime grants for new tables/operations without broadening schema creation, deletion, or immutable evidence mutation.

### Migration sequencing and compatibility

1. Implement/verify the separately owned Ledger migration first.
2. Deploy additive Refund/payment timestamp columns and new event/idempotency constraints while old API code still writes only `CREATED`/`payment.created.v1`.
3. Deploy event relay/topology/consumer compatibility before any captured/refunded producer can commit.
4. Deploy API code with routes disabled until schema, runtime grants, consumer compatibility, and smoke checks pass; then enable the producer surface.

The migration must apply to an empty database and upgrade the committed `71d8f27` history with existing synthetic Payment Intent/outbox/Webhook data. Check-constraint replacement requires a short table lock and must be measured/documented. There is no payment/refund backfill, seed, destructive rewrite, enum rename, or status synthesis. After the first posting, rollback means disabling commands and forward-fixing; never drop/reforge financial evidence.

## Event, RabbitMQ, and Webhook impact

- Payments constructs only accepted event data and calls Eventing's transaction-aware persistence port. It never writes `outbox_events` directly.
- Eventing owns exact serialization, event IDs, outbox rows, routing, publisher confirmation, and relay retry. Confirmed publication remains at least once.
- New event types require per-type serializer validators and RabbitMQ routing; the generic relay must never treat an unknown contract as publishable.
- Webhooks/Settlements process committed events through inbox-protected consumers and never join the capture/refund transaction.
- Webhook projection must retain the exact validated new event bytes and create deliveries only for endpoints active/subscribed when that event is processed. Existing event markers must continue preventing later historical fanout.
- The current Webhook marker/schema, subscription type union/check, projection service/repository, dispatcher type/header validation, and ADR-0018 documentation are created-only and require a separately approved compatibility sub-milestone before capture/refund producers are enabled.
- Actual HTTP retry/signing mechanics remain ADR-0018/0019; only event-type/body compatibility changes. No new retry schedule, replay API, SSRF rule, secret rule, or delivery state is authorized here.
- Settlement eligibility/adjustment consumers are deferred. The captured/refunded outbox event is the durable handoff; no synchronous Settlement write is permitted.

## Affected modules and files

The planning milestone changes only this file. The following is the expected later implementation surface after all gates are approved.

| Module/file area                                                                                   | Planned change                                                                           | Ownership/boundary impact                                                            |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `docs/adr/0020-*.md` onward and `docs/adr/README.md`                                               | Record Ledger, public command/provider, availability, and event/Webhook decisions        | Required before code; exact ADR split/numbering To be decided                        |
| Separate Ledger plan plus `packages/modules/ledger/**` and tests                                   | Implement the blocking transaction-aware posting boundary                                | Ledger-owned prerequisite; must not depend on Payments                               |
| `prisma/schema.prisma`                                                                             | Add Refund relation/timestamps and later Ledger models from their owning plan            | Schema remains module-owned despite one physical database                            |
| `prisma/migrations/<timestamp>_payment_capture_and_refunds/migration.sql`                          | Add Refund/payment/idempotency/outbox constraints/indexes/grants                         | Reviewed forward migration; no financial data rewrite                                |
| `packages/modules/payments/src/payments.types.ts`                                                  | Add capture/refund commands, records, responses, provider/Ledger-facing inputs           | Payments exposes application types, not Prisma rows                                  |
| `packages/modules/payments/src/payment-intent.validation.ts` and focused tests                     | Add refund-ID/external-ref/money/state validation                                        | Pure Payments policy                                                                 |
| `packages/modules/payments/src/payment-intent.service.ts` and tests                                | Orchestrate full capture/refund, idempotency, Ledger, projection, and outbox             | Payments coordinates ports with one transaction; no cross-table writes               |
| `packages/modules/payments/src/prisma-payment-intent.repository.ts` and tests                      | Tenant-scoped row lock, Refund insert, conditional projection update, constraint mapping | Reviewed raw SQL only for `FOR UPDATE`; Payments tables only                         |
| `packages/modules/payments/src/payments.errors.ts` and `index.ts`                                  | Typed lifecycle/amount/currency/reference/provider errors and exports                    | Enables allow-listed RFC mapping                                                     |
| New deterministic mock-provider adapter/tests within Payments or infrastructure                    | Pure synthetic approved/declined outcomes                                                | No network/secret/real-rail dependency; final location To be decided by provider ADR |
| `packages/modules/idempotency/src/idempotency.types.ts`, service/repository tests                  | Admit route-template union and capture/refund result-reference snapshots                 | Idempotency still owns acquisition/completion                                        |
| `packages/modules/eventing/src/eventing.types.ts`, service/repository, contracts, and tests        | Add exact captured/refunded producer contracts and persistence                           | Payments -> Eventing port only                                                       |
| `packages/modules/eventing/src/rabbitmq-outbox.publisher.ts`, `rabbitmq-topology.ts`, and tests    | Type-dispatched mandatory routing and approved queues/DLQs                               | No transaction-time broker call                                                      |
| Eventing/Webhooks consumer files and `apps/worker/src/{worker.module.ts,runtime/**}`               | Add approved per-event projection consumers/readiness/lifecycle before producers         | Inbox-protected post-commit work; separate channel/consumer identities               |
| `packages/modules/webhooks/src/webhook.types.ts`, validation/repositories/services/tests           | Expand subscriptions, generic event marker/delivery body/event-type compatibility        | Separate approved Webhooks compatibility sub-milestone; no Payments writes           |
| `apps/api/src/payment-intents/payment-intent.controller.ts` and tests                              | Add two scoped POST handlers                                                             | Thin authenticated adapter                                                           |
| `apps/api/src/payment-intents/payment-intent-body.parser.ts` and tests                             | Generalize exact lossless parsing into command-specific strict bodies                    | Raw body stays bounded/redacted                                                      |
| `apps/api/src/payment-intents/payment-intent.openapi.ts` and `docs/api/openapi.json`               | Add request/response/problem/security contracts                                          | Public compatibility surface                                                         |
| `apps/api/src/http/problem-details.filter.ts` and tests                                            | Map only approved capture/refund errors                                                  | Safe RFC 9457 adapter                                                                |
| `apps/api/src/app.module.ts`                                                                       | Compose accepted Payments/Ledger/Eventing/provider ports                                 | Existing modular monolith; no new deployable                                         |
| `docs/events/payment.captured.v1.schema.json`, `payment.refunded.v1.schema.json`, and README       | Commit exact versioned schemas, AMQP metadata, and forbidden fields                      | Contract artifacts required before publication                                       |
| `test/integration/payment-intents.int-spec.ts` or focused capture/refund suite                     | Real PostgreSQL API/atomicity/tenant/idempotency proof                                   | Financial integration tests cannot be skipped                                        |
| `test/integration/outbox-relay.int-spec.ts` and Webhook consumer/delivery suites                   | Routing, confirmation, exact-byte, dedupe, projection, and no-historical-fanout proof    | Post-commit at-least-once evidence                                                   |
| `test/integration/prisma-data-foundation.int-spec.ts`                                              | Constraint/trigger/runtime-role/empty-upgrade proof                                      | Database remains final enforcement boundary                                          |
| `README.md`, `docs/api/payment-intents.md`, `docs/runbooks/README.md`, new payment/ledger runbooks | Exact commands, limitations, safe diagnosis, invariant incident response                 | No raw SQL repair guidance                                                           |
| `package.json`/workspace package manifests                                                         | Add focused scripts and the required Payments-to-Ledger workspace edge                   | No new third-party dependency; lockfile changes are limited to the workspace edge    |

No Compose, Docker image, secret environment variable, new deployable, frontend, or provider dependency is expected. Any such need is a plan deviation requiring review.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario                                      | Expected safe state                                                     | Retry/recovery                                                                     | Required evidence                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| Same capture key/body repeated after commit                        | One capture, Ledger transaction, outbox event; stored response replayed | Return snapshot without domain/provider re-entry                                   | API/integration replay test              |
| Same capture key with changed amount/currency                      | Original effect only                                                    | `409 idempotency_key_reused`                                                       | Contract/race test                       |
| 50 distinct keys capture one Payment Intent                        | One success; one capture posting/event; all other rows unchanged        | Locked losers receive approved durable lifecycle conflict                          | Mandatory PostgreSQL race                |
| Active/stale idempotency owner                                     | No second effect                                                        | Active gets 409/Retry-After; one expired-owner takeover                            | Existing plus command-specific race      |
| Same refund key/body repeated                                      | One Refund row/posting/event/projection increment                       | Stored 201 replay                                                                  | Integration replay test                  |
| Different key, same refund external reference                      | One Refund only                                                         | Named unique conflict stored/replayed                                              | Database/API race                        |
| Concurrent refunds whose sum exceeds capture                       | Committed refund sum/projection never exceeds captured amount           | Payment row serialization; excess losers get approved conflict                     | Mandatory PostgreSQL race                |
| Provider deterministic decline                                     | Payment unchanged; no Refund/Ledger/outbox                              | Replay terminal snapshot with same key                                             | Unit/integration fixture                 |
| Provider adapter transient/config failure                          | Payment unchanged; no financial/result completion                       | 503; retry/takeover with same key after safe recovery                              | Failure injection                        |
| Ledger check/trigger failure                                       | Payment/Refund/outbox/snapshot all roll back                            | Stop affected path, preserve diagnostics, forward-fix; never patch entries         | Negative constraint/crash tests          |
| Event/Refund/Ledger public-ID collision                            | No partial effect                                                       | Retry entire transaction up to accepted bound; then 503                            | Forced-collision tests                   |
| Deadlock/serialization failure                                     | Whole effect transaction rolls back                                     | At most three whole-transaction retries; metric on exhaustion                      | SQLSTATE injection/race                  |
| PostgreSQL unavailable                                             | No effect; readiness false                                              | 503 and retry with same key after recovery                                         | Real dependency outage test              |
| RabbitMQ unavailable                                               | Financial transaction and pending outbox may commit                     | Relay retries later; response never waits for broker                               | Broker-outage integration test           |
| Crash before financial commit                                      | No Payment/Refund/Ledger/outbox/snapshot effect                         | Lease/takeover repeats whole command                                               | Crash-point tests                        |
| Crash after commit before HTTP response                            | Complete effect and snapshot exist                                      | Same key replays exact logical response                                            | Lost-response test                       |
| Relay crash after publish before mark                              | Same stable event may republish                                         | Existing lease/confirm/inbox design deduplicates effect                            | Existing relay failure test per new type |
| Unsupported/invalid new event at consumer                          | No Webhook effect                                                       | Immediate approved DLQ; no financial rollback                                      | RabbitMQ poison tests                    |
| Future refund after Settlement `SETTLED` without adjustment design | Must not be silently treated as a complete settlement correction        | Gate endpoint coexistence on approved Settlement adjustment consumer/read contract | M3 cross-module tests                    |

Recovery never deletes/reforges an outbox event, reuses a key for a changed body, resets a payment/refund projection, updates/deletes a Refund or posted Ledger row, manually edits Webhook evidence, or uses a second compensating write without an approved reversal/forward-fix command.

## Security and privacy

- Authenticate/authorize before idempotency lookup or resource disclosure. Merchant ID comes only from the API-key identity and is included in every Payment/Refund predicate.
- Validate opaque public IDs canonically and return the same 404 for absent/cross-tenant payments. Refund IDs are not secrets.
- Keep raw bodies solely in the bounded raw-body parser. Never log amount payloads, external references, idempotency keys/digests, API keys, response snapshots, provider fixture rules, SQL, or Ledger entries.
- Structured telemetry may carry request ID, merchant ID, API-key ID, public payment/refund/ledger/event IDs, route template, state/outcome code, and duration. IDs are not metric labels.
- The deterministic provider has no network, credential, endpoint, secret, or production mode. A real provider requires threat modeling for authentication, request signing, PCI/regulatory data, timeout/unknown outcome, replay, and secret rotation.
- `settleflow_app` remains non-owner/no-schema-create. Refunds and posted Ledger evidence must deny update/delete/truncate; migrations run through the owner-only URL/job.
- Event/Webhook bodies contain only the approved minimum and exact bytes. No new event may leak `externalRef`, API/idempotency data, provider fixture details, internal UUIDs, or settlement state.
- Perform explicit SQL parameterization, tenant isolation, resource-exhaustion/idempotency storage, race, error-redaction, event-data-classification, and runtime-role reviews before merge.

## Observability and operations

- Trace spans: `payment.capture`, `payment.refund`, `idempotency.acquire`, `ledger.post`, and `outbox.persist`, with database wait/retry events but no body/key/amount attributes.
- Counters: `payments_captured_total`, `refunds_total`, capture/refund conflicts by stable bounded reason, idempotent replay/in-progress/reuse, provider synthetic declines, ledger invariant failures, whole-transaction retries/exhaustion, and new event publish/projection outcomes.
- Histogram: `payment_command_duration_seconds` by command/outcome; no merchant/payment/refund IDs as labels.
- Backlog signals: pending/oldest outbox by bounded event type; new projection queue/DLQ depth; Webhook due/dead-letter signals remain existing behavior.
- Structured logs: service, environment, route template, stable code, request/event/public resource IDs, merchant/API-key IDs, duration, retry count; never raw request/response, external reference, amount, key, provider fixture, or SQL detail.
- API readiness remains dependency-aware as currently committed. A valid financial command's database commit never depends on RabbitMQ, Webhook, telemetry, or a merchant destination. The deterministic local provider adds no readiness dependency.
- Add a payment/ledger invariant runbook: stop the affected command surface, preserve request/event/ledger IDs and database evidence, inspect named constraints/metrics, and forward-fix or reverse through an approved command. Direct row/queue edits are prohibited.
- Environment-specific alert thresholds/destinations remain **To be decided** by Operations before a production-like release. The specification's capture latency objective is p95 below 300 ms/p99 below 600 ms in the documented reference environment, without relaxing correctness.

## Test strategy

- **Unit:** exhaustive payment transition matrix; full-only capture; partial/full/repeated refund arithmetic in `bigint`; exact lossless body tokens; currency/external-ref/public-ID validation; canonical fingerprint vectors; deterministic provider approve/decline/failure; response snapshots; event payload/order/forbidden fields; error mapping; identifier collision bounds; Ledger posting builder in the separate Ledger suite.
- **Database constraints/migrations:** empty and `71d8f27` upgrade; status/projection/timestamp combinations; Refund format/amount/currency/tenant/external-ref/FKs; outbox per-type payload checks; idempotency route/result checks; Ledger balance/count/currency/immutability/reversal triggers; runtime-role insert/update/delete/truncate permission negatives; query plans.
- **Integration with real dependencies:** full capture and partial/full refunds through HTTP with PostgreSQL; exact atomic rows/entries/events/snapshots; tenant/scope/auth isolation; provider fixtures; RabbitMQ absent/healthy; publisher routing/confirms; inbox/Webhook exact-byte/dedup/fanout after its compatibility gate.
- **Contract:** generated/committed OpenAPI exact paths, scopes, required headers, bodies, responses, statuses/problems, safe integer maximum, ETB/USD, `rf_`/`ltx_` patterns; JSON Schemas and AMQP properties for both new events; no undocumented route or partial-capture example.
- **Concurrency/race:** specification-mandated 50 distinct capture keys, 50 same capture keys, changed-amount same key, refund requests whose sum exceeds capture, same refund external-ref race, cross-merchant parallel operations, ID collision, lock timeout, deadlock/serialization whole retry, and relay claim/duplicate tests per event type.
- **Failure injection/recovery:** before/after Refund insert, Ledger transaction/each entry, Payment update, outbox insert, idempotency snapshot, commit, response send, publish/mark, consume/ack; provider decline/failure; PostgreSQL/RabbitMQ outage; Webhook poison/DLQ; restart with pending evidence.
- **Security:** foreign merchant/missing equivalence; bad scopes/credentials; malformed/oversized/duplicate JSON; unsafe/fractional/overflow amounts; controls/Unicode edges; SQL parameterization; runtime owner-vs-app permissions; logs/problems/events/snapshots scanned for prohibited data.
- **Performance:** reference capture p95/p99 and idempotency contention; concurrent refund lock behavior; query plans; outbox/projection backlog drain without using performance to waive invariant checks.
- **Regression:** existing create/read, Merchant Access, readiness, outbox relay, Webhook endpoint/projection/signing/retries, graceful shutdown, OpenAPI, and build suites remain green.
- **Documentation/link checks:** Prettier/Markdown links/JSON Schema validation/OpenAPI drift/`git diff --check` and complete status.

## Verification commands for implementation

Commands are planned, not run by this documentation-only milestone:

```shell
git status --short --branch
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm infra:up
pnpm db:provision-runtime-role
pnpm prisma:validate
pnpm prisma:generate
pnpm db:migrate:apply
pnpm db:migrate:status
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:payments
pnpm test:event-contract
pnpm test
pnpm test:integration
pnpm build
pnpm openapi:check
git diff --check
git status --short --branch
```

The implementation must additionally record focused Ledger constraint/permission commands and repeated capture/refund race commands once their scripts exist. Mark any missing focused command **To be defined**; do not report it as passed. Docker/Testcontainers are mandatory for the financial integration gate.

## Documentation impact

- Update `docs/api/payment-intents.md` and `README.md` with exact capture/refund examples, success/problem behavior, idempotent retries, simulated-provider limitation, and safe local commands.
- Add/index exact captured/refunded event schemas and AMQP/Webhook contracts in `docs/events/`.
- Add/index Payment/Ledger invariant and capture/refund recovery runbooks. Update the outbox/Webhook runbooks for the new event queues only after topology/consumer approval.
- Update architecture/module/invariant text only when a decision is accepted; do not rewrite the specification through implementation documentation.
- Update the committed OpenAPI artifact and runtime drift tests atomically with the routes.
- Record all accepted ADRs, migration rollout/forward-fix notes, performance environment/results, known limitations, and explicit exclusion of real rails/partial capture/post-settlement adjustment implementation.
- Correct existing stale README statements about already committed Webhook delivery only in the later documentation implementation diff, not in this planning-only milestone.

## Rollback or forward-recovery strategy

Before routes are enabled and before financial rows exist, application code can be disabled and additive schema retained. Once a capture/refund/ledger posting exists:

- disable new capture/refund commands at the deployment/routing layer if correctness is in doubt;
- stop affected async consumers only when needed, preserving queues, inbox, projections, deliveries, and attempts;
- let active transactions roll back and outbox/delivery leases expire naturally;
- keep Payment Intent, Refund, Ledger, idempotency, outbox, inbox, Webhook, and audit evidence intact;
- use a reviewed forward migration/code fix; and
- correct a posted financial error only with an approved reversal/new transaction, never an update/delete/truncate or balance patch.

Migration rollback that drops/reforges financial evidence is prohibited after first use. Event schema/routing changes use additive versioning and consumer-before-producer rollout. A faulty provider stub is disabled/forward-fixed; it is never replaced by an unreviewed real adapter.

## Risks and assumptions

| Risk or assumption                                                  | Impact                                                    | Mitigation/validation                                                                             | Owner/deadline                                     |
| ------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Ledger was absent when this plan was drafted                        | Any capture/refund implementation would violate FR-06     | Resolved by accepted ADR-0020 and the Ledger Foundation committed at `1e0f8af`                    | Resolved before implementation                     |
| Partial capture wording is confused with partial refunds            | Unauthorized partial capture or incorrect state           | Explicit full-only capture; P2 remains deferred; contract/race tests                              | Payments owner / before API ADR acceptance         |
| Capture/refund bodies and response codes are underspecified         | Permanent public/idempotency compatibility error          | Accept Gate 2 ADR with exact schemas/status/problem codes                                         | Project owner / before schema/API code             |
| Refund public ID/external-reference contract is not accepted        | Irreversible resource/business-key design                 | Approve `rf_<ULID>` and exact reference policy before migration                                   | Project owner / before migration                   |
| `availableOn` calculation/type is undefined                         | Incorrect Settlement eligibility or incompatible event    | Accept Gate 3; keep Settlement state out of Payments                                              | Payments/Settlements owners / before event ADR     |
| Real-provider semantics leak behind a local port                    | Unknown remote outcome can duplicate money effects        | Pure deterministic adapter only; new ADR/state machine for any network integration                | Security/Payments owners / before adapter code     |
| Current outbox relay is created-only                                | New rows retry forever or mandatory-return                | Event contract/topology/serializer compatibility before producers                                 | Eventing owner / before route enablement           |
| Current Webhook contracts are created-only                          | New events dead-letter, mis-sign, or fan out historically | Consumer-before-producer compatibility milestone and ADR-0018 extension                           | Webhooks/Eventing owners / before route enablement |
| Post-settlement refund adjustment is not implemented                | Payment projection could diverge from merchant obligation | No settled state exists now; require M3 adjustment contract before coexistence                    | Settlements owner / before M3                      |
| Payment row becomes a contention hotspot                            | Timeouts/latency under capture/refund races               | Short deterministic lock order, bounded timeouts, whole retries, real concurrency/load evidence   | Payments/DB owner / before merge                   |
| Check replacement locks a populated table                           | Deployment write interruption                             | Measure on representative data, staged migration, controlled job, additive compatibility          | DB owner / before deployment                       |
| Ordinary merchant financial commands need separate audit rows later | Current evidence interpretation could be challenged       | ADR-0013 ordinary-write interpretation; superseding ADR if policy changes                         | Operations/Security / before release review        |
| Metrics/alert destinations remain absent                            | Operators may not be paged for invariant/backlog failures | Emit bounded signals/runbooks now; approve thresholds/destinations before production-like release | Operations owner / before release                  |

## Implementation order

1. Obtain owner approval for Gates 1-5 and create/accept the required ADRs. Keep this plan `Draft` until they are resolved.
2. Create and complete the separate Ledger Foundation plan/implementation, including accounts, postings, invariants, roles, migrations, tests, and runbook.
3. Finalize captured/refunded HTTP, refund ID/reference, provider outcome, availability, event, topology, and Webhook compatibility contracts in this plan.
4. Add exact JSON/event/OpenAPI contract tests before producer implementation.
5. Add the additive Payments/Refund/Idempotency/Eventing schema migration and runtime grants; prove empty/prior application and all negative constraints.
6. Generalize Eventing relay/topology and deploy inbox/Webhook projection/delivery compatibility consumers before enabling new producers.
7. Implement pure state/money/fingerprint/provider policies and exhaustive unit tests.
8. Implement Payments orchestration and reviewed tenant-scoped `FOR UPDATE` repository logic using the already verified Ledger/Idempotency/Eventing ports.
9. Add thin capture/refund API handlers, lossless parsers, RFC problem mapping, OpenAPI, and documentation.
10. Run atomicity, crash, tenant, provider, Ledger, outbox, and all mandatory concurrency scenarios with real PostgreSQL/RabbitMQ.
11. Run the full verification matrix, inspect every migration/file/result, record deviations, and only then mark the plan completed. Commit/push remain separate explicit user actions.

## Execution checklist

- [x] Governance, specification, architecture, invariants, ADRs, current schema/code/tests, event/Webhook flow, and prior plans inspected.
- [x] Specification authorization and P0/P2 boundary recorded.
- [x] Missing Ledger prerequisite and material contract decisions identified.
- [x] Gates 1-5 and required ADRs approved.
- [x] Ledger Foundation implemented and all INV-01 through INV-06 gates pass.
- [x] Capture/refund/Eventing/Webhook compatibility implementation and migrations completed.
- [x] Financial, concurrency, failure, security, permission, and regression tests pass.
- [x] Documentation/runbooks/OpenAPI/event schemas updated.
- [x] Commands/results/deviations recorded below.

## Verification record

| Command or review                            | Result | Date/evidence                                                                                                                                                                          |
| -------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline status and HEAD                     | Pass   | 2026-08-02: clean `## main...origin/main` at `1e0f8af`                                                                                                                                 |
| Authoritative document/repository inspection | Pass   | Specification, invariants, boundaries, accepted ADRs, schema/migrations, packages, API, event/Webhook flow, tests, and plans reviewed                                                  |
| Specification authorization                  | Pass   | FR-03..07 authorize direct full capture and partial/full refund; partial capture and real providers remain excluded                                                                    |
| Dependency installation                      | Pass   | `corepack pnpm@11.18.0 install --frozen-lockfile`; workspace already current, with no new third-party dependency                                                                       |
| Local infrastructure                         | Pass   | PostgreSQL 18.4 and RabbitMQ 4.3.4 reported healthy through Compose                                                                                                                    |
| Prisma checks                                | Pass   | Prisma 7.9.1 validation and generation passed; a disposable PostgreSQL database applied all eight migrations and passed the four-case data-foundation suite                            |
| Formatting, lint, and type-check             | Pass   | `pnpm format:check`, `pnpm lint`, and `pnpm typecheck` passed                                                                                                                          |
| Unit and contract tests                      | Pass   | 37 suites / 172 tests passed; focused Payments and event-contract suites also passed                                                                                                   |
| Integration tests                            | Pass   | 9 suites / 60 tests passed against real PostgreSQL and RabbitMQ, including capture/refund races, Ledger/outbox atomicity, projection, delivery, permissions, readiness, and migrations |
| Production build                             | Pass   | API and worker production builds passed with the repository-pinned pnpm 11.18.0 through a process-local Corepack shim                                                                  |
| OpenAPI and JSON artifacts                   | Pass   | Generated OpenAPI drift check passed; OpenAPI and all three Payment lifecycle JSON Schemas parsed successfully                                                                         |
| Documentation and repository hygiene         | Pass   | Markdown links, formatting, JSON/OpenAPI checks, and `git diff --check` passed; final status is recorded in the implementation report                                                  |

### Implementation outcomes and deviations

- The implementation adds no third-party package. The lockfile change records only the Payments-to-Ledger workspace dependency required for atomic postings.
- Payment locking now obtains the database command timestamp after the tenant-scoped `FOR UPDATE` lock and clamps it against `updated_at`. This preserves monotonic lifecycle timestamps for queued concurrent commands.
- The inbox database contract was generalized to exact consumer/event-type pairs for `payment.created.v1`, `payment.captured.v1`, and `payment.refunded.v1`; arbitrary combinations remain rejected.
- Ordinary merchant capture/refund commands create no separate Operations audit row under ADR-0013. Immutable Payment/Refund rows, Ledger transactions/entries, idempotency snapshots, and outbox events are the durable audit evidence.
- Existing created-event behavior and signed Webhook delivery semantics remain compatible. Eventing and Webhook projection were extended consumer-before-producer for the two new exact contracts.
- Test fixture time margins and dependency startup bounds were made deterministic across the host and disposable containers; production timing behavior was not relaxed.

## Definition of done

The planning milestone was complete when all authoritative requirements/invariants and current constraints were traced, the Ledger blocker and material approvals were explicit, and the future files/order/tests/recovery were reviewable.

Implementation is complete only after all five approval gates and the Ledger prerequisite are satisfied; full direct capture and full/partial refunds atomically commit payment/refund state, balanced immutable entries, one exact outbox event, and one replay snapshot; every tenant, validation, error, event/Webhook, permission, crash, and mandatory race gate passes with real dependencies; no partial capture, real provider, Settlement/reconciliation, frontend, replay, or unrelated work enters scope; and the plan records complete evidence and deviations.
