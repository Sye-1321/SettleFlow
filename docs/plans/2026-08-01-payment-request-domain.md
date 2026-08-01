# Implementation Plan: Payment Request (Payment Intent create/read) domain

- **Status:** Approved
- **Owner:** SettleFlow maintainers
- **Created:** 2026-08-01
- **Last updated:** 2026-08-01
- **Related issue/PR:** None
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0002](../adr/0002-node-typescript-package-manager-and-version-policy.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0004](../adr/0004-rabbitmq-outbox-inbox-and-message-delivery.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md), [ADR-0006](../adr/0006-payment-and-settlement-lifecycle-state-ownership.md), [ADR-0007](../adr/0007-idempotency-key-concurrency-and-response-snapshots.md), [ADR-0008](../adr/0008-api-version-path-and-compatibility.md), [ADR-0009](../adr/0009-public-payment-identifiers.md), [ADR-0010](../adr/0010-payment-currencies-and-amount-range.md), [ADR-0011](../adr/0011-payment-intent-external-reference-and-capture-method.md), [ADR-0012](../adr/0012-payment-created-outbox-timing.md), and [ADR-0013](../adr/0013-problem-details-audit-and-retention-boundaries.md)

## Goal

Plan the specification-authorized, merchant-owned Payment Intent create/read slice without implementing it. A later implementation is successful when an authenticated merchant can create one `CREATED` payment intent and retrieve only its own intent, with exact money validation, tenant isolation, duplicate protection, idempotent replay, durable evidence, and an OpenAPI contract that agrees with the authoritative v1.0 specification.

The specification calls the bounded module **Payments** and the resource **Payment Intent**. “Payment Request” is the milestone label only; it does not authorize a second bounded context, a `payment_requests` table, or an alias resource.

### Non-goals

- Capture, authorization, void, refunds, payment-provider calls, card or bank data, or real movement of money.
- Ledger accounts, entries, balances, settlement eligibility changes, settlement batches, reconciliation, or financial reporting.
- RabbitMQ topology, publishers/consumers, webhooks, inbox processing, or a worker handler.
- Merchant onboarding, API-key lifecycle endpoints, operator identity, JWTs, sessions, or RBAC.
- A customer-facing frontend or list/search endpoint.
- Implementing any deferred capability merely because its state or future integration is mentioned in this plan.

## Specification traceability

- **Requirement IDs:** FR02 (create/retrieve payment intents), FR05 (idempotency), FR07 (transactional outbox for committed events), FR13 (correlation), and FR14 only to determine whether a privileged audit event applies. FR03, FR04, FR06, FR15, and the rest of the financial lifecycle are deferred.
- **Invariant IDs:** INV01, INV03, INV04, INV07, INV08, INV09, and INV10 constrain the model and future transitions. No ledger posting occurs in this slice, so INV02, INV05, and INV06 are preserved but not exercised.
- **Architecture evidence:** the Payments boundary owns `payment_intents`, payment state, and payment transitions; Merchant Access supplies authenticated merchant identity; Idempotency owns command keys/fingerprints/response snapshots; Eventing owns outbox/inbox; Operations owns privileged audit records. Direct cross-module table writes are forbidden.
- **Data-model evidence:** the specification's conceptual `payment_intent` aggregate includes merchant ownership, merchant external-reference uniqueness, amount/currency checks, optimistic versioning, and separate payment and settlement states. It describes current captured/refunded projections without authorizing ledger or refund records in this slice.
- **API evidence:** the v1 endpoint catalog authorizes `POST /v1/payment-intents` with `payments:write` and `GET /v1/payment-intents/{id}` with `payments:read`. The appendix's create example supplies `externalRef`, `currency`, `amountMinor`, and `captureMethod: "manual"`, and includes an `Idempotency-Key` header.
- **Money evidence:** amounts are integer minor units stored as PostgreSQL `BIGINT`; currency is one uppercase three-character code per payment; decimal amounts, negative capture/refund values, overflow, and currency mismatches are rejected.
- **Lifecycle evidence:** payment and settlement lifecycles are separate. Creation persists payment status `CREATED`; the API derives settlement status `NOT_ELIGIBLE` without a `payment_intents.settlement_status` column. Capture/refund/void and settlement-owned records belong to later milestones under ADR-0006.
- **Tenant/security evidence:** every merchant-owned query and mutation must include the authenticated merchant ID in the database predicate. Cross-tenant identifiers must not reveal resource existence.
- **Event evidence:** the event catalog defines `payment.created.v1`; ADR-0012 requires one stable event to be written to the Eventing-owned outbox in the same transaction as the Payment Intent and completed idempotency snapshot. The approved contract refines `amount` to exact integer `amountMinor` and adds versioned type and request correlation.
- **Acceptance/release gates:** the specification's broader M1 includes create/read/capture/refund/ledger, but this plan intentionally delivers only the first coherent create/read increment. Capture, refund, and Ledger remain unavailable until their own approved milestones. Minimal outbox persistence is pulled forward under ADR-0012; relay/webhooks remain M2.

This plan does not promote P1 authorize-then-capture (FR15). OQ05 retains direct capture and defers authorization. ADR-0010 resolved OQ01 to ETB and USD with no conversion.

## Authorization matrix

| Authorized artifact                 | Authorization evidence                                                                                                                                                                        | Planned ownership and limit                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PaymentIntent` / `payment_intents` | FR02; Payments boundary; conceptual data model; create/read endpoint catalog                                                                                                                  | Payments owns all writes and transitions. This slice creates and reads only.                                                     |
| Merchant relation and `merchant_id` | Merchant actor, tenant-isolation rules, and merchant external-reference uniqueness                                                                                                            | Merchant Access owns `merchants`; Payments holds a restrictive FK and never writes Merchant Access tables.                       |
| `external_ref`                      | FR02 says duplicate external references within a merchant are rejected or replayed by documented policy; conceptual model proposes merchant-scoped uniqueness; ADR-0011 resolves the contract | Payments stores the exact accepted value and enforces case-sensitive `(merchant_id, external_ref)` uniqueness.                   |
| `amount_minor` and `currency`       | FR02 and global money rules                                                                                                                                                                   | Immutable creation terms in this slice; no balance or ledger meaning is inferred.                                                |
| `capture_method`                    | The normative create example and ADR-0011                                                                                                                                                     | Require and persist only `MANUAL`; no default, automatic capture, or authorization behavior is enabled.                          |
| Payment and settlement status       | Separate lifecycle rules and ADR-0006                                                                                                                                                         | Payments persists only `CREATED`; the API derives `NOT_ELIGIBLE`. Settlements owns later settlement truth.                       |
| Captured/refunded projections       | Conceptual `payment_intent` description                                                                                                                                                       | Initialize both to zero only. Later capture/refund commands own changes. They are not balances.                                  |
| Optimistic `version`                | Conceptual model and concurrency guidance                                                                                                                                                     | Initialize to zero; no metadata-update endpoint is authorized in this slice.                                                     |
| Idempotency record                  | FR05, idempotency architecture, capture workflow, and appendix request header                                                                                                                 | Idempotency module owns its table and acquisition/replay operations; Payments must use its port, never write its table directly. |
| `POST /v1/payment-intents`          | Endpoint catalog plus appendix example                                                                                                                                                        | Thin API adapter, `payments:write`, merchant identity from the existing guard, idempotency required.                             |
| `GET /v1/payment-intents/{id}`      | Endpoint catalog                                                                                                                                                                              | Thin API adapter, `payments:read`, tenant-safe lookup, no idempotency key.                                                       |
| `payment.created.v1`                | Event catalog, ADR-0004, ADR-0012, and the approved M1 event contract                                                                                                                         | Payments supplies event data; Eventing atomically persists the outbox row and owns later delivery.                               |

No specification evidence authorizes a `PaymentRequest`, payment line item, customer, provider, card, payment method, fee, tax, exchange-rate, balance, ledger, transition-history, or payment-specific audit table in this slice. None is proposed.

## Existing behavior

- Git was clean before this approval update: `git status --short --branch` returned only `## main...origin/main` at committed ADR baseline `b7b5527`.
- [prisma/schema.prisma](../../prisma/schema.prisma) contains only `Merchant` and `ApiKey`; there is no financial or idempotency table.
- `packages/modules/merchant-access` authenticates opaque bearer credentials and returns only merchant ID, API-key ID, and scopes. Its fixed vocabulary already includes `payments:write` and `payments:read`.
- The global API guard authenticates all non-public routes, and `RequireMerchantScopes` can enforce endpoint scopes. No Payments, Idempotency, Eventing, Ledger, or Operations implementation exists.
- The current authenticated foundation route remains `GET /api/v1`. ADR-0008 requires the implementation milestone to correct it to `GET /v1`; `/v1` is the only business API namespace and no compatibility alias is authorized.
- The current NestJS default error body is not the required RFC 9457 problem-details contract. No global request-ID propagation or payment DTO validation foundation exists.
- PostgreSQL and RabbitMQ readiness/lifecycle behavior is already centralized. Payment create/read must not replace or weaken it.
- Existing migrations establish the Prisma foundation and Merchant Access only. A later migration must work both from an empty database and from the committed Merchant Access migration state.
- ADR-0003 permits Prisma by default and reviewed, parameterized raw SQL only where financial/concurrency correctness cannot be safely expressed. ADR-0004 already requires an outbox, publisher confirms, manual acknowledgements, and at-least-once consumers when messaging is introduced.
- No ULID or lossless JSON dependency is currently installed. The owner approved exact `ulid@3.0.2` and `lossless-json@4.3.0` for the implementation milestone under ADR-0002's exact-version policy.

Evidence reviewed for this plan includes `AGENTS.md`, `PLANS.md`, `CONTRIBUTING.md`, `SECURITY.md`, all files under `docs/architecture`, ADR-0001 through ADR-0013 and their index, all existing plans, the complete unchanged v1.0 `.docx` specification, the full Prisma schema and migrations, the Merchant Access package/API guard/tests/documentation, the root README, workspace scripts, current dependencies, and current OpenAPI setup.

## Accepted decisions and implementation selections

All decisions required for this create/read slice are accepted. Implementation may begin under a separate implementation task while remaining within this plan's scope.

| Decision area                           | Accepted outcome                                                                                                                                                                                                                 | Authority                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Lifecycle and ownership                 | Payments owns payment status/projections; Settlements owns settlement truth. Create persists `CREATED` and derives `NOT_ELIGIBLE` without a settlement-status column.                                                            | ADR-0006                   |
| Idempotency                             | SHA-256 key/request digests, PostgreSQL single-winner acquisition, 30-second lease, active-owner 409 with `Retry-After: 1`, atomic completion snapshot, minimum 24-hour/default seven-day replay window, and retained tombstone. | ADR-0007                   |
| API path                                | `/v1` is canonical; correct the scaffold route and create no `/api/v1` compatibility alias.                                                                                                                                      | ADR-0008                   |
| Public Payment Intent ID                | Internal UUID plus immutable, unique `pi_<ULID>` public ID; every merchant query also predicates on `merchant_id`.                                                                                                               | ADR-0009                   |
| Money                                   | ETB/USD only; `amountMinor` is a JSON-safe integer in `1..9,007,199,254,740,991`, persisted as constrained PostgreSQL `BIGINT`.                                                                                                  | ADR-0010                   |
| `externalRef` and `captureMethod`       | Exact case-sensitive 1-255 scalar reference with no surrounding whitespace/control characters; required lowercase `manual`, persisted as `MANUAL`; merchant-scoped uniqueness.                                                   | ADR-0011                   |
| Creation event                          | Payment, completed idempotency snapshot, and one `payment.created.v1` outbox row commit atomically; no RabbitMQ publication in M1.                                                                                               | ADR-0012                   |
| Problems, audit, request ID, retention  | RFC 9457 problems and approved codes; validated/generated request IDs; ordinary merchant create/read creates no `audit_events`; no payment deletion; owner-specific retention boundaries.                                        | ADR-0013                   |
| Payment/event identifier implementation | Exact `ulid@3.0.2`, process-scoped monotonic factories, cryptographic randomness, and no more than three total collision attempts for `pi_` and `evt_` identifiers.                                                              | Owner approval, 2026-08-01 |
| Creation event contract                 | Flat nine-field contract defined under [Audit and event requirements](#audit-and-event-requirements); event ID is `evt_<ULID>`.                                                                                                  | Owner approval, 2026-08-01 |
| Lossless amount parsing                 | Exact `lossless-json@4.3.0` over Nest raw body for create; exactly representable integer forms such as `1000`, `1000.0`, and `1e3` canonicalize to the same base-10 integer before fingerprinting.                               | Owner approval, 2026-08-01 |

No M1-blocking decision remains. Tombstone deletion beyond the accepted response-body disposal policy, settlement read composition, additional currencies/capture methods, and every later lifecycle transition remain deferred and require their own authorized milestones.

## Approved design

### Boundary and request flow

1. The API adapter authenticates the bearer API key through Merchant Access and requires `payments:write` or `payments:read` on the handler.
2. The adapter obtains the immutable merchant request identity, validates route/headers, and losslessly parses the create command from Nest's retained raw body with exact `lossless-json@4.3.0`. Controllers contain no persistence or financial rules.
3. For create, the Payments application service calls the Idempotency port using merchant ID, HTTP method, normalized route template, key, and a canonical fingerprint of the validated command.
4. A single PostgreSQL transaction creates the merchant-owned Payment Intent, persists exactly one `payment.created.v1` row through an Eventing port, and finalizes the idempotency response snapshot. All three commit or roll back together. There are no network calls in the transaction.
5. For retrieve, the Payments repository queries by both payment ID and authenticated merchant ID. A missing or foreign record produces the same `404 payment_intent_not_found` response.
6. Prisma client ownership and shutdown remain in `PrismaDatabase`; modules receive the shared lifecycle-managed client and never instantiate a second connection pool.

### Payments package

Create `packages/modules/payments` only during implementation. It exposes application commands/queries and ports, keeps Prisma in an adapter, and does not expose generated Prisma records as API DTOs. Add bounded Idempotency and Eventing packages for their owned tables/ports. The API adds only a thin Payment Intent controller, raw-body command parser, request/response DTOs, request-ID/problem mapping, and composition. The worker has no M1 Payment Intent or outbox-relay responsibility.

Rejected alternatives:

- A `payment_requests` table or module: not named or owned by the specification.
- Putting payment code in Merchant Access: violates the bounded-context ownership table.
- Letting controllers access Prisma: bypasses ownership, transaction, and tenant rules.
- Using RabbitMQ as part of the synchronous create path: violates financial correctness and outbox rules.
- Treating `externalRef` as the idempotency mechanism: it cannot bind the full request fingerprint or safely replay an exact response.
- Floating-point/decimal major-unit amounts: violates the money representation invariant.

## Exact planned data model

The following is the approved implementation baseline, not a schema change in this documentation task. Names are physical PostgreSQL names; Prisma fields use the repository's camelCase mapping convention.

### Payments-owned `payment_intents`

| Column                  | PostgreSQL/Prisma shape         | Null/default                                        | Rule and evidence                                                                                             |
| ----------------------- | ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`                    | `UUID` / `String @db.Uuid`      | PK, generated UUID                                  | Internal relational ID; never exposed to merchant clients or events.                                          |
| `public_id`             | `VARCHAR(29)`                   | NOT NULL                                            | Immutable, globally unique `pi_` plus uppercase ULID; API field `id`; maximum three collision attempts.       |
| `merchant_id`           | `UUID` / relation to `Merchant` | NOT NULL; `ON DELETE RESTRICT`, `ON UPDATE CASCADE` | Tenant owner; every lookup/mutation also predicates on it. FK does not grant Merchant Access write authority. |
| `external_ref`          | `VARCHAR(255)`                  | NOT NULL                                            | Exact accepted merchant business key; case-sensitive unique pair with `merchant_id`.                          |
| `amount_minor`          | `BIGINT` / `BigInt`             | NOT NULL                                            | Immutable; named check enforces `1..9007199254740991`.                                                        |
| `currency`              | `CHAR(3)`                       | NOT NULL                                            | Named checks enforce uppercase syntax and `currency IN ('ETB', 'USD')`; immutable.                            |
| `capture_method`        | enum `payment_capture_method`   | NOT NULL, no implicit default                       | Only `MANUAL` is accepted/written; required in the API.                                                       |
| `payment_status`        | enum `payment_status`           | NOT NULL, `CREATED`                                 | ADR-0006 vocabulary; this slice writes only `CREATED`.                                                        |
| `captured_amount_minor` | `BIGINT` / `BigInt`             | NOT NULL, `0`                                       | Projection only; `CHECK 0 <= captured_amount_minor AND captured_amount_minor <= amount_minor`.                |
| `refunded_amount_minor` | `BIGINT` / `BigInt`             | NOT NULL, `0`                                       | Projection only; `CHECK 0 <= refunded_amount_minor AND refunded_amount_minor <= captured_amount_minor`.       |
| `version`               | `INTEGER`                       | NOT NULL, `0`                                       | Optimistic concurrency token; named check enforces non-negative values.                                       |
| `created_at`            | `TIMESTAMPTZ(6)`                | NOT NULL, current time                              | Durable creation time in UTC.                                                                                 |
| `updated_at`            | `TIMESTAMPTZ(6)`                | NOT NULL, current time                              | Current aggregate projection update time.                                                                     |

Required database objects:

- Primary key on internal `id`, global unique constraint and exact-format check on `public_id`, and named unique constraint on `(merchant_id, external_ref)`.
- Restrictive FK to `merchants(id)`.
- Named checks for the approved amount range, ETB/USD allow-list, non-negative projections, projection upper bounds, non-negative version, and initial state/projection consistency.
- No settlement-status column. The API returns derived lowercase `settlementStatus: "not_eligible"` while no settlement-owned record can exist.
- No provider, ledger, settlement-batch, customer, payment-method, fee, tax, webhook, event, or audit columns.
- No soft-delete or delete endpoint. A later retention decision controls archival/purge.
- A tenant-safe `WHERE public_id = ? AND merchant_id = ?` explain plan must be recorded. Because `public_id` is globally unique, its unique index may be sufficient; add a redundant composite index only if measurement proves it necessary.

The payment-status enum may declare ADR-0006's accepted vocabulary (`CREATED`, dormant `AUTHORIZED`, `CAPTURED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `VOIDED`), but M1 services and database consistency checks permit only creation into `CREATED`. Predeclared values authorize no endpoint or transition.

### Idempotency-owned `idempotency_keys`

This supporting model is required before create can be safely exposed but is not Payments-owned. Its exact ADR baseline is:

| Column                     | Accepted shape                  | Purpose                                                                                  |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `id`                       | `UUID` PK                       | Internal record identity.                                                                |
| `merchant_id`              | `UUID` NOT NULL, restrictive FK | Tenant scope.                                                                            |
| `http_method`              | `VARCHAR(8)` NOT NULL           | Uppercase `POST`.                                                                        |
| `normalized_route`         | `VARCHAR(255)` NOT NULL         | Stable template `/v1/payment-intents`, never raw query/path data.                        |
| `key_hash`                 | `BYTEA(32)` NOT NULL            | SHA-256 of the exact validated key; raw key is never persisted.                          |
| `request_hash`             | `BYTEA(32)` NOT NULL            | SHA-256 of the versioned canonical validated command.                                    |
| `state`                    | enum `IN_PROGRESS`, `COMPLETED` | Acquisition/finalization state.                                                          |
| `owner_token`              | `UUID` nullable                 | Cryptographically random single-winner identity while in progress.                       |
| `lease_expires_at`         | `TIMESTAMPTZ(6)` nullable       | Initial 30-second stale-owner boundary while in progress.                                |
| `response_status`          | `INTEGER` nullable              | Exact completed logical HTTP status.                                                     |
| `response_content_type`    | `VARCHAR(128)` nullable         | Completed content type.                                                                  |
| `response_headers`         | `JSONB` nullable                | Only explicitly approved replay-safe headers.                                            |
| `response_body`            | `JSONB` nullable                | Bounded completed logical response/problem snapshot.                                     |
| `result_reference`         | `VARCHAR(255)` nullable         | Immutable public Payment Intent reference for completed creates and retained tombstones. |
| `completed_at`             | `TIMESTAMPTZ(6)` nullable       | Atomic completion evidence.                                                              |
| `response_expires_at`      | `TIMESTAMPTZ(6)` nullable       | Never less than 24 hours; default seven days.                                            |
| `created_at`, `updated_at` | `TIMESTAMPTZ(6)` NOT NULL       | Lifecycle evidence and cleanup ordering.                                                 |

Require unique `(merchant_id, http_method, normalized_route, key_hash)`, exact digest-length checks, an expiry index, and owner/lease/snapshot state-consistency checks. A reviewed, parameterized `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` harmless-update pattern, or equivalently proven SQL, establishes a single winner under PostgreSQL Read Committed. Active same-key/same-hash callers receive `409 idempotency_request_in_progress` and `Retry-After: 1`; they are not held open. Response-body/header disposal retains the scope/request digests, completed state, result reference, and timestamps as a tombstone; deletion beyond that boundary remains unauthorized.

### Eventing-owned `outbox_events`

M1 must add the minimum Eventing-owned outbox schema and persistence port needed to store the approved flat event atomically. It requires a globally unique `event_id`, versioned `event_type`, occurrence/request correlation, aggregate/public payment reference, exact JSON payload, pending publication state, creation/availability time, and nullable future-compatible lease/publish metadata. Unpublished rows are never age-purged. Eventing owns every write; Payments passes event data and the shared transaction context through its port.

## State machines and permitted transitions

### Payment lifecycle

| From                               | Command                    | To                   | Status in this slice          | Preconditions/effect                                                                                                                          |
| ---------------------------------- | -------------------------- | -------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| No record                          | Create intent              | `CREATED`            | Authorized                    | Valid merchant, `payments:write`, valid body, idempotency winner, unique merchant external reference; captured/refunded projections are zero. |
| `CREATED`                          | Capture                    | `CAPTURED`           | Deferred                      | Valid amount, row lock, idempotency, ledger and outbox atomicity.                                                                             |
| `CREATED`                          | Authorize                  | `AUTHORIZED`         | P1 deferred                   | FR15/OQ05; no endpoint in this slice.                                                                                                         |
| `CREATED` or `AUTHORIZED`          | Void                       | `VOIDED`             | Deferred/endpoint unspecified | No later capture. Exact void API is not authorized by the current endpoint catalog.                                                           |
| `CAPTURED`                         | Partial refund             | `PARTIALLY_REFUNDED` | Deferred                      | Refund > 0 and cumulative refund < captured amount.                                                                                           |
| `PARTIALLY_REFUNDED`               | Another partial refund     | `PARTIALLY_REFUNDED` | Deferred                      | ADR-0006 confirms repeated partial refunds while the cumulative total remains below capture.                                                  |
| `CAPTURED` or `PARTIALLY_REFUNDED` | Complete cumulative refund | `REFUNDED`           | Deferred                      | Cumulative refund equals captured amount.                                                                                                     |

All other transitions are forbidden. `GET` never transitions state. A generic state-update method must not exist; later commands encode specific transitions and locking.

### Settlement lifecycle

`NOT_ELIGIBLE -> ELIGIBLE -> BATCHED -> SETTLED -> ADJUSTMENT_PENDING` remains separate from payment status and is owned by Settlements. M1 creates no settlement record and writes no settlement status. The create/read representation deterministically derives `NOT_ELIGIBLE` only while no settlement-owned record can exist; this slice cannot make a payment eligible.

## Amount, currency, and money handling

- Enable Nest raw-body retention and parse only the create body with exact `lossless-json@4.3.0`; never validate money from the already-rounded native `req.body` value.
- Require a JSON numeric token that represents an exact integer in `1..Number.MAX_SAFE_INTEGER`. Accept exact equivalents such as `1000`, `1000.0`, and `1e3`; reject strings, non-integral fractions, unsafe/rounded values, `NaN`, infinities, zero, negatives, and overflow.
- Parse the raw UTF-8 body into lossless numeric tokens, obtain the exact `amountMinor` token, require an exact safe conversion, then apply `Number.isSafeInteger` and the inclusive range check. Only this checked value may become a Prisma `bigint` or enter the canonical fingerprint.
- Prove lossless conversion before producing a JavaScript `number`, then convert explicitly to Prisma `bigint`. Convert back only after proving the stored value remains in the approved JSON-safe range.
- Persist `amount_minor` as PostgreSQL `BIGINT`. Never use JavaScript floating-point arithmetic for monetary calculations, SQL `REAL/DOUBLE`, or major-unit decimal input.
- Accept one uppercase three-letter currency per intent. Reject lowercase rather than silently normalizing so the canonical idempotency fingerprint is unambiguous.
- Apply the exact `{ETB, USD}` allow-list in the Payments domain and named database constraints. No FX conversion, exponent lookup, rounding, or cross-currency aggregation occurs.
- `captured_amount_minor` and `refunded_amount_minor` initialize to zero; they are not calculated or mutated in this slice.
- Response money uses `{ "amountMinor": <integer>, "currency": "ETB" }` semantics. The final response schema must be captured in OpenAPI before implementation is marked complete.

## API and integration impact

### Request/response contract

| Method/path                    | Scope            | Request                                                                                                             | Success                                                                                                                                     | Tenant behavior                                                                                |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /v1/payment-intents`     | `payments:write` | Bearer key; `Idempotency-Key` (1-255); JSON body with `externalRef`, `amountMinor`, `currency`, and `captureMethod` | `201`; body contains public ID, submitted fields, lowercase `created`/derived `not_eligible`, zero projections, version, and UTC timestamps | Merchant ID comes only from authentication, never body/query.                                  |
| `GET /v1/payment-intents/{id}` | `payments:read`  | Bearer key and validated ID                                                                                         | `200` with the same resource representation                                                                                                 | Query includes `id` and authenticated `merchant_id`; missing/foreign both return the same 404. |

There is no list, update, delete, capture, refund, void, authorize, or public lookup endpoint in this slice.

### Validation and error behavior

- Enforce `application/json`, a bounded request body, a strict object schema, and rejection of unknown fields.
- `externalRef`: required string of 1-255 Unicode scalar values and within the bounded body; no NUL/control characters or leading/trailing whitespace; case-sensitive and otherwise preserved without trimming, case folding, or Unicode normalization. Do not derive it from a request ID.
- `amountMinor`: required safe positive integer under the approved maximum.
- `currency`: required uppercase three-letter supported code.
- `captureMethod`: required literal `manual` until the contract is expanded.
- `Idempotency-Key`: required on create, 1-255 characters after syntax validation, no control characters or surrounding whitespace, and never logged. GET ignores no supplied key semantically but middleware must not log its value.
- Reject body-supplied `merchantId`, `status`, settlement state, projections, version, timestamps, provider data, or IDs.
- Accept caller `X-Request-Id` only when it is 1-128 characters from `[A-Za-z0-9._:-]`; otherwise generate a high-entropy `req_` ID. Return the canonical value and propagate it to the winning command/outbox correlation without storing an invalid caller value.
- All errors use `application/problem+json` in RFC 9457 shape with stable `code` and `requestId`; no raw database, validation-library, credential, idempotency-key, or request-body details.

Accepted status/code matrix:

| Condition                                                     | HTTP                      | Stable code                       |
| ------------------------------------------------------------- | ------------------------- | --------------------------------- |
| Malformed/unknown field, invalid identifier/header/type/range | 400                       | `invalid_request`                 |
| Missing or invalid API key                                    | 401                       | `unauthorized`                    |
| Valid key missing required scope                              | 403                       | `insufficient_scope`              |
| Missing or foreign payment intent                             | 404                       | `payment_intent_not_found`        |
| Unsupported currency                                          | 422                       | `unsupported_currency`            |
| Unsupported capture method                                    | 422                       | `unsupported_capture_method`      |
| Same idempotency scope/key with changed fingerprint           | 409                       | `idempotency_key_reused`          |
| Same key/fingerprint still owned by an unexpired request      | 409 plus `Retry-After: 1` | `idempotency_request_in_progress` |
| Completed key after response-snapshot disposal                | 409                       | `idempotency_key_expired`         |
| Different key collides with merchant external reference       | 409                       | `external_reference_conflict`     |
| Database unavailable/transaction retries exhausted            | 503                       | `service_unavailable`             |

A completed replay returns the original status, body, content type, and approved safe headers. It must not re-read and reserialize the current payment because later state changes would alter the original response. Do not add a replay-indicator header unless the contract explicitly approves it.

## Idempotency, transactions, and concurrency

### Canonical fingerprint

After strict validation, construct a versioned canonical command containing only:

```json
{
  "v": 1,
  "externalRef": "<exact accepted value>",
  "amountMinor": "<base-10 integer without leading sign/zeros>",
  "currency": "<uppercase code>",
  "captureMethod": "manual"
}
```

Serialize keys in the fixed order above and SHA-256 the UTF-8 bytes. The string form inside the fingerprint avoids runtime number-format differences; the HTTP body remains the specification-required integer. Merchant ID, method, route, and idempotency key belong to the uniqueness scope and need not be duplicated in the body hash.

### Required command behavior

1. Authenticate and authorize before exposing whether an idempotency record exists.
2. Validate the complete request before fingerprinting.
3. Run the bounded ADR-approved single-winner acquisition statement/transaction for the scoped idempotency record.
4. A completed same-fingerprint record returns its stored response without a second insert/event. A changed fingerprint returns the documented 409. An unexpired active owner returns the accepted 409 with `Retry-After: 1`; no HTTP request waits for completion. After lease expiry, conditional takeover follows ADR-0007's lock/timeout algorithm.
5. The winner obtains candidate `pi_<ULID>` and `evt_<ULID>` values from the Payments- and Eventing-owned identifier ports before the insert transaction. Each uses its own process-scoped monotonic factory and permits no more than three attempts per identifier.
6. Begin the command transaction, lock/verify the idempotency owner token, and insert one `payment_intents` row using the authenticated merchant ID. The global public-ID and merchant external-reference constraints are final race guards.
7. Persist the approved `payment.created.v1` event through the Eventing port using the shared transaction. Never contact RabbitMQ in the request transaction.
8. Build the bounded logical response from transaction result values and update the idempotency record to `COMPLETED` with the response snapshot and result reference in the same transaction.
9. Commit, then return/replay the durable response. A public/event-ID unique collision rolls back the whole command transaction before another candidate is attempted. Approved serialization/deadlock retries also rerun the entire command transaction with the same owner/fingerprint semantics.

Default PostgreSQL isolation remains Read Committed unless a measured/proven case justifies stronger isolation. Set bounded lock and statement timeouts. There is no payment row to lock before creation; uniqueness and idempotency acquisition choose the winner. No network call, broker publish, password hashing, or API-key verification occurs inside the database transaction.

ADR-0007 resolves the response-snapshot sequence: payment, outbox intent, and completed logical snapshot commit atomically; only the HTTP send occurs afterward. Crash tests cover before payment insert, after payment/before outbox, after outbox/before snapshot, before commit, after commit/before HTTP response, and lease takeover after process death.

## Audit and event requirements

- The Payment Intent row, immutable merchant/external reference, timestamps, completed idempotency result, outbox record, and request/command/event correlation provide durable command evidence. Logs are not authoritative state.
- `payment.created.v1` is the only authorized domain event for this slice. Its exact flat contract has nine fields:

```json
{
  "eventId": "evt_01K...",
  "eventType": "payment.created.v1",
  "occurredAt": "2026-08-01T10:20:12.345Z",
  "requestId": "req_01K...",
  "merchantId": "00000000-0000-0000-0000-000000000000",
  "paymentId": "pi_01K...",
  "amountMinor": 125000,
  "currency": "ETB",
  "status": "CREATED"
}
```

- `eventId` is exactly `evt_` plus a 26-character uppercase Crockford ULID and is generated no more than three times on collision. `eventType` carries schema version `v1`; no separate version field or nested `data` wrapper exists. `occurredAt` is UTC RFC 3339 with milliseconds from the injected clock used for the event ULID. `merchantId` is the existing Merchant UUID; `paymentId` is the public `pi_<ULID>` only. `amountMinor` remains a JSON-safe integer, and `requestId` is the winning command's canonical correlation ID.
- The event contains no internal Payment Intent UUID, `externalRef`, settlement status, API-key/authentication data, idempotency-key value, raw request body, response snapshot, provider data, or extra field.
- Event IDs are generated once and persisted; same-key replay returns the snapshot and creates no second logical event. Eventing owns outbox persistence and the future worker; later consumers own their projections/inbox deduplication.
- Payment creation is an ordinary merchant command, not an FR14 privileged operational action. It creates no `audit_events` row or Payments-owned audit table. API-key lifecycle, future privileged replay, settlement execution, reconciliation import, and manual recovery remain Operations audit concerns.
- Application logs may include request ID, merchant ID, payment ID, API-key ID, route template, method, status, duration, and stable error code. They must omit credentials, authorization headers, idempotency-key values, request/response bodies, and raw financial payloads.

## Affected modules and files for the later implementation

| Module/file area                                   | Ownership or change                                                 | Boundary impact                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/modules/payments`                        | New Payments application/domain/repository package                  | Owns `payment_intents`; depends on Idempotency/Eventing ports, not their tables.                    |
| `packages/modules/idempotency`                     | New cross-cutting command-deduplication package                     | Owns `idempotency_keys`; exposes merchant-scoped acquisition/replay APIs.                           |
| `packages/modules/eventing`                        | New bounded M1 persistence package                                  | Owns `outbox_events`, event contract/ID port, and persistence only; relay/runtime remains deferred. |
| `packages/infrastructure`                          | Exact `ulid@3.0.2` monotonic generator adapter                      | Implements module-owned identifier ports; format ownership stays in Payments/Eventing.              |
| `apps/api/package.json`                            | Exact `lossless-json@4.3.0`                                         | API transport parses the raw create body losslessly before passing a typed command.                 |
| `apps/api/src/payment-intents`                     | Thin controller, raw-body parser, DTOs, OpenAPI, problem mapping    | Uses Merchant Access identity/scopes and Payments application API.                                  |
| `apps/api/src/main.ts`                             | Nest raw-body support and approved request-ID/problem-details setup | Existing readiness and graceful shutdown remain intact; raw bodies are never logged or persisted.   |
| `apps/api/src/api-version.controller.ts`           | Correct scaffold route from `/api/v1` to `/v1`                      | No compatibility alias.                                                                             |
| `apps/api/src/app.module.ts`                       | Composition only                                                    | Wires shared Prisma lifecycle, ports, repositories, and application services.                       |
| Shared API request-ID/problem-details area         | Cross-cutting HTTP compatibility contract                           | Must not leak domain, credential, rejected values, SQL, or raw bodies.                              |
| `prisma/schema.prisma` and reviewed migration(s)   | Add only approved Payment/Idempotency/Eventing structures           | Each module retains write ownership despite the shared physical schema.                             |
| `test/integration`                                 | Real PostgreSQL API/concurrency/failure tests                       | Exercises tenant, atomicity, duplicate, lossless parsing, and collision guarantees.                 |
| `docs/api`, committed OpenAPI, README, and runbook | Exact contract, event schema, operator/developer commands           | All documentation uses canonical `/v1`; pending outbox inspection is documented without relay work. |

No reverse dependency from Ledger, Merchant Access, or Eventing to Payments is introduced. Payments invokes Idempotency and Eventing application ports through the approved direction; a Prisma relation is referential integrity, not permission for cross-module writes.

## Database and migration plan

1. Treat ADR-0006 through ADR-0013 and the approved implementation selections above as the controlling design inputs.
2. Add Prisma models/enums with explicit mapped names, restrictive foreign keys, and named indexes; do not add a settlement-status column.
3. Generate a create-only migration against local PostgreSQL; manually review every statement. Add only the CHECK constraints/raw DDL Prisma cannot express, with comments tying each to an invariant.
4. Apply from an empty database and from a fixture at the current Merchant Access migration. Verify migration status and Prisma validation/generation.
5. Prove the global public-ID and event-ID constraints, tenant-scoped external-reference uniqueness, amount/currency/state checks, digest lengths, idempotency state consistency, and restrictive FK behavior.
6. Capture `EXPLAIN (ANALYZE, BUFFERS)` for merchant-scoped ID lookup and duplicate-key acquisition; add indexes only from evidence.
7. Create the Eventing-owned outbox schema before enabling the create route. Preserve future lease/publish compatibility, but add no RabbitMQ topology, relay, consumer, inbox, or publishing code.
8. Do not seed payment intents or idempotency records. Integration tests create synthetic records transactionally/ephemerally.

Migration rollback is safe only before durable payment data exists. After use, dropping payment/idempotency/event evidence is forbidden; use forward fixes and expand-contract migrations.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario                      | Expected safe state                                                   | Retry/recovery                                             | Required evidence            |
| -------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------- |
| PostgreSQL unavailable before acquisition          | No payment or idempotency row                                         | 503; caller retries with same key                          | Integration failure test     |
| Two requests, same key/fingerprint, active winner  | Exactly one in-progress owner; no second payment/event                | Loser gets 409 plus `Retry-After: 1`; later retry replays  | Concurrent storm test        |
| Same key, changed body                             | Original state unchanged; no second payment                           | 409 `idempotency_key_reused`                               | Contract/integration test    |
| Different keys, same merchant/external ref         | Exactly one payment                                                   | Unique constraint; loser gets documented 409               | Race test                    |
| Same external ref for different merchants          | One payment per merchant allowed                                      | Tenant-scoped uniqueness                                   | Database/integration test    |
| Cross-tenant GET                                   | No data disclosure                                                    | Same 404 as missing                                        | Security integration test    |
| Crash before transaction commit                    | No payment/event/completed snapshot                                   | Lease/transaction recovery; same key retries               | Failure-injection test       |
| Crash after domain commit but before HTTP response | One payment and durable replay evidence according to ADR              | Same key returns stored response                           | Crash-point integration test |
| RabbitMQ unavailable                               | Payment/idempotency/outbox commit remains atomic; no publish attempt  | Pending outbox retained; readiness remains existing policy | Dependency failure test      |
| Serialization/deadlock error                       | No partial commit                                                     | Retry whole transaction within bound                       | Injected SQL-state test      |
| Unsupported/overflow money input                   | No database writes                                                    | Correct problem response                                   | Unit/contract test           |
| Idempotency lease expires                          | Never create a second payment                                         | ADR-approved safe takeover/read by business uniqueness     | Stale-owner test             |
| Public/event ID unique collision                   | No partial domain effect; at most three total generation attempts     | Retry within bound, then safe failure                      | Forced-collision test        |
| Fraction/unsafe token rounded by native parser     | Lossless raw-body validator rejects before fingerprint or persistence | 400 `invalid_request`; no writes                           | Raw HTTP token test          |

## Security and privacy

- Require the existing opaque bearer credential and exact scope per endpoint. Never accept merchant identity from request-controlled fields.
- Put `merchant_id` in every repository predicate, including conflict/read paths; use parameterized Prisma queries or reviewed parameterized raw SQL.
- Return tenant-safe 404s and generic authentication errors. Scope failure is 403 without revealing resources.
- Bound body/header/path sizes before canonicalization or database work. Reject unknown fields and control characters.
- Retain raw request bytes only for the lifetime of request parsing. Parse create with `lossless-json`, ignore the native rounded body for money validation, and never log/store raw bytes.
- Do not log authorization data, API keys, idempotency keys, raw bodies, response snapshots, or unsanitized external references. Treat external references as untrusted data in logs and traces.
- Keep only business/payment metadata authorized by the specification. No PAN, bank account, provider credential, customer PII, card token, email, phone, tax, or KYC field is accepted or stored.
- Protect response snapshots and payment rows with the same database access controls/backups as transactional data. Cleanup may purge expired response bodies only under the approved retention policy; it must not delete payment truth.
- Complete a security review covering tenant isolation, ID enumeration, idempotency resource exhaustion, hash/canonicalization ambiguity, SQL parameterization, problem-detail leakage, and denial-of-service bounds.

## Observability and operations

- Trace names: `payments.create`, `payments.get`, `idempotency.acquire`, `idempotency.replay`, and `outbox.persist`. No trace attribute contains a key or raw body.
- Structured fields: service, route template, method, status, duration, request/correlation ID, merchant ID, API-key ID, payment ID when known, stable error code, and replay boolean. Exclude `externalRef` unless separately classified/sanitized.
- Metrics: request latency/count by route/status, create success/failure, idempotency acquired/replayed/conflict/in-progress, external-reference conflicts, identifier-collision exhaustion, database retry exhaustion, and pending outbox count/oldest age. Do not use merchant/payment/event IDs as metric labels.
- Preserve current liveness/readiness semantics. PostgreSQL remains required for API readiness; RabbitMQ behavior remains as committed until an approved outbox operational design changes it.
- Add a runbook for investigating idempotency conflicts/stale owners and payment-create failures without mutating financial records. Manual replay must be privileged and audited when it is later implemented.
- Target the specification's reference create/capture latency gate (create p95 under 300 ms and p99 under 600 ms in the stated local/reference conditions) without weakening correctness.

## Test strategy

- **Unit:** raw-body/header validators; exact numeric-token and canonical fingerprint vectors; ULID format/clock/collision bounds; money conversion; status initialization/derived settlement status; flat event contract; problem mapping; tenant propagation; forbidden transition tests for any state-machine helper.
- **Database constraints/migrations:** empty and prior-version migration; Prisma validate/generate; public/event ID format/uniqueness; approved amount range; ETB/USD checks; projections; initial-state consistency; digest/state checks; tenant external-reference uniqueness; restrictive FK; no invalid direct row.
- **Integration with real dependencies:** Testcontainers PostgreSQL for create/read, atomic payment/idempotency/outbox writes, exact replay, active-owner 409, mismatch, duplicate external reference, cross-tenant isolation, scope/auth failures, unavailable database, collision injection, and clean Prisma lifecycle. RabbitMQ is needed only for existing readiness; M1 makes no broker call.
- **Contract:** committed OpenAPI matches runtime; exact paths/scopes/request/response/problem schemas; examples contain synthetic credentials/data; no secret or invalid decimal money example.
- **Concurrency/race:** same-key storm with active-owner 409/later replay, different-key/same-external-ref race, stale lease takeover, bounded Payment/event ID collision paths, response replay after simulated response loss, and later row-lock transition races.
- **Failure injection/recovery:** every payment/outbox/snapshot transaction crash point, deadlock/serialization whole-transaction retry, DB outage, and broker outage with no publish attempt.
- **Security:** missing/malformed/revoked key behavior remains generic; wrong scopes; cross-tenant ID/external-reference probes; malformed/oversized raw body; unsafe/fractional numeric tokens; control characters; unknown/conflicting duplicate fields; log/trace scans for credentials, idempotency keys, raw bodies, and snapshots.
- **Performance:** measure create/read percentiles and idempotency contention with reference data; record query plans.
- **Documentation/link checks:** README/API/runbook commands, Markdown links, OpenAPI drift, `git diff --check`, and complete status.

Expected later verification commands (not run in this planning-only milestone):

```shell
pnpm install --frozen-lockfile
pnpm infra:up
pnpm infra:ps
pnpm prisma:validate
pnpm prisma:generate
pnpm db:migrate:apply
pnpm db:migrate:status
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm openapi:check
pnpm build
git diff --check
git status --short --branch --untracked-files=all
```

Add a focused `test:payments` script during implementation. Any new concurrency/failure command must be documented rather than reported as passed before it exists.

## Documentation impact

- Keep ADR-0006 through ADR-0013 indexed as the accepted architecture baseline; this plan records the narrower approved implementation selections without changing ADR text.
- Update architecture documentation only if implementation discovers a contradiction requiring change control; this plan cannot override accepted ADRs.
- Add Payment Intent API/security documentation and generated OpenAPI examples.
- Update README with exact create/read development and test commands using placeholders, never usable keys.
- Add idempotency/recovery operational guidance and migration verification evidence.
- Update this plan's status, checklist, and verification record during implementation.

## Explicitly deferred work

- Capture, authorization, void, partial/full refunds, provider references, and provider adapters.
- Every ledger account/entry/balance and the atomic domain-ledger transition.
- Settlement eligibility/transitions/batches, adjustments, reconciliation, and reporting.
- RabbitMQ topology, publisher/consumer runtime, inbox, dead letters, webhook endpoints/delivery, and business-event consumers. M1 includes only the required outbox schema, contract, and atomic persistence port.
- Payment transition-history storage unless separately authorized; state transitions remain aggregate behavior.
- Merchant/operator management endpoints, privileged replay tooling, and audit UI.
- Pagination/list/search, update/delete, customer objects, payment methods, subscriptions, fees, tax, FX, KYC, real bank/card rails, and a customer-facing frontend.

## Rollback or forward-recovery strategy

Before deployment/data, revert application wiring and an unapplied migration. After any payment intent is durably created, never roll back by dropping/truncating payment, idempotency, or outbox evidence. Disable the new route at deployment/configuration level if necessary, retain readable records, and ship a forward-compatible fix. Schema changes follow expand-contract so the previous API/worker can run during deployment. There are no ledger postings to reverse in this slice.

## Risks and assumptions

| Risk or assumption                                            | Impact                                                           | Mitigation/validation                                                                                    | Owner/deadline                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Raw SQL is required for idempotency acquisition               | Concurrency or SQL-injection defect                              | Isolate reviewed parameterized SQL under ADR-0003; run real PostgreSQL race/timeout/takeover tests.      | Data owner / before merge               |
| Native Nest parsing rounds before ordinary DTO validation     | Fractional or unsafe token could be accepted as another integer  | Validate only the retained raw body with exact `lossless-json@4.3.0`; include raw HTTP boundary tests.   | API/Payments owners / before merge      |
| Process monotonicity is not cross-process global ordering     | IDs from separate API processes may not be globally time-ordered | Treat IDs as opaque; rely on cryptographic entropy and unique constraints, not ordering, for identity.   | Architecture owner / before merge       |
| Forced/defective ID collision path is mishandled              | Duplicate or partial payment/event evidence                      | Limit to three attempts; force collisions and prove complete rollback.                                   | Payments/Eventing owners / before merge |
| Future states predeclared in enums may look implemented       | Unauthorized transitions                                         | Command-specific services, state consistency checks, and negative tests; no generic status setter.       | Payments owner / before migration       |
| Pending outbox rows accumulate because relay is deferred      | Storage/backlog growth                                           | Inspect count/oldest age; never age-purge unpublished rows; implement relay only in its later milestone. | Eventing owner / before release         |
| Response snapshots contain more data than required            | Sensitive-data retention or unbounded storage                    | Construct bounded logical snapshots from whitelisted result fields/headers; redaction and size tests.    | Security owner / before merge           |
| Payment records lack an approved destructive-retention policy | Long-term storage growth                                         | No delete/purge path; monitor and require later owner-approved retention design.                         | Product/Operations / before any purge   |

## Execution checklist

- [x] Governance, specification, current schema/migrations, architecture, ADRs, Merchant Access, README, and existing plans reviewed.
- [x] Authorization evidence and boundary ownership mapped.
- [x] Contradictions, missing decisions, and required ADRs identified.
- [x] ADR-0006 through ADR-0013 accepted.
- [x] API namespace, identifier, currency/range, external-reference, capture-method, error, event, retention, and audit decisions approved.
- [x] ULID, exact event envelope, and lossless amount parser selections approved.
- [x] Design and boundaries reviewed for implementation readiness.
- [ ] Implementation and migrations completed.
- [ ] Tests and failure scenarios pass.
- [ ] Security and sensitive-data review pass.
- [ ] Documentation and runbooks updated.
- [ ] Commands/results and deviations recorded below.

## Verification record

| Command or review                                           | Result            | Date/evidence                                                                                                                                         |
| ----------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git status --short --branch` before planning               | Pass              | 2026-08-01: clean `main...origin/main`                                                                                                                |
| Complete document/repository evidence review                | Pass              | 2026-08-01: sources listed under Existing behavior; specification SHA-256 remained `77E3A5B44C4EE20F2E241DDC5CE2991D64BE82128E31EFBEE6DEC86239F239A6` |
| Initial plan formatting/link/diff/status checks             | Pass              | 2026-08-01: original plan-only milestone; the plan was later committed                                                                                |
| ADR and implementation-selection approval update            | Pass              | 2026-08-01: `pnpm exec prettier --check`, local-link/anchor/stale-language checks, and `git diff --check`; only this tracked plan is modified         |
| Application, database, dependency, test, or runtime command | Not run by design | Planning-only milestone; no implementation verification authorized                                                                                    |

## Definition of done

This planning milestone is complete when this file is the only worktree change; it maps every authorized Payment Intent model/endpoint and cross-cutting requirement; gives reviewable table, state, money, idempotency, error, audit/event, migration, security, failure, and test designs; records all accepted ADRs and implementation selections; defers unauthorized work; passes Markdown link/format/whitespace checks; and records complete Git status without a commit or push.

The plan is now Approved for a separately authorized implementation task. Completion of that implementation requires the remaining execution checklist, verification commands, and failure/security evidence; plan approval itself does not claim that code, schemas, migrations, dependencies, OpenAPI, or tests exist.
