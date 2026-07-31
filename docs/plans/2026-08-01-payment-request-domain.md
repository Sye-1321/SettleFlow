# Implementation Plan: Payment Request (Payment Intent create/read) domain

- **Status:** Draft
- **Owner:** SettleFlow maintainers
- **Created:** 2026-08-01
- **Last updated:** 2026-08-01
- **Related issue/PR:** To be decided
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0004](../adr/0004-rabbitmq-outbox-inbox-and-message-delivery.md), and the required ADRs listed under [Decisions required before implementation](#decisions-required-before-implementation)

## Goal

Plan the specification-authorized, merchant-owned Payment Intent create/read slice without implementing it. A later implementation is successful when an authenticated merchant can create one `CREATED` payment intent and retrieve only its own intent, with exact money validation, tenant isolation, duplicate protection, idempotent replay, durable evidence, and an OpenAPI contract that agrees with the authoritative v1.0 specification.

The specification calls the bounded module **Payments** and the resource **Payment Intent**. “Payment Request” is the milestone label only; it does not authorize a second bounded context, a `payment_requests` table, or an alias resource.

### Non-goals

- Capture, authorization, void, refunds, payment-provider calls, card or bank data, or real movement of money.
- Ledger accounts, entries, balances, settlement eligibility changes, settlement batches, reconciliation, or financial reporting.
- RabbitMQ topology, publishers/consumers, webhooks, inbox processing, or a worker handler.
- Merchant onboarding, API-key lifecycle endpoints, operator identity, JWTs, sessions, or RBAC.
- A customer-facing frontend or list/search endpoint.
- Retrofitting application code, Prisma schema/migrations, OpenAPI, package manifests, or scripts during this planning milestone.

## Specification traceability

- **Requirement IDs:** FR02 (create/retrieve payment intents), FR05 (idempotency), FR07 (transactional outbox for committed events), FR13 (correlation), and FR14 only to determine whether a privileged audit event applies. FR03, FR04, FR06, FR15, and the rest of the financial lifecycle are deferred.
- **Invariant IDs:** INV01, INV03, INV04, INV07, INV08, INV09, and INV10 constrain the model and future transitions. No ledger posting occurs in this slice, so INV02, INV05, and INV06 are preserved but not exercised.
- **Architecture evidence:** the Payments boundary owns `payment_intents`, payment state, and payment transitions; Merchant Access supplies authenticated merchant identity; Idempotency owns command keys/fingerprints/response snapshots; Eventing owns outbox/inbox; Operations owns privileged audit records. Direct cross-module table writes are forbidden.
- **Data-model evidence:** the specification's conceptual `payment_intent` aggregate includes merchant ownership, merchant external-reference uniqueness, amount/currency checks, optimistic versioning, and separate payment and settlement states. It describes current captured/refunded projections without authorizing ledger or refund records in this slice.
- **API evidence:** the v1 endpoint catalog authorizes `POST /v1/payment-intents` with `payments:write` and `GET /v1/payment-intents/{id}` with `payments:read`. The appendix's create example supplies `externalRef`, `currency`, `amountMinor`, and `captureMethod: "manual"`, and includes an `Idempotency-Key` header.
- **Money evidence:** amounts are integer minor units stored as PostgreSQL `BIGINT`; currency is one uppercase three-character code per payment; decimal amounts, negative capture/refund values, overflow, and currency mismatches are rejected.
- **Lifecycle evidence:** payment and settlement lifecycles are separate. Creation establishes payment status `CREATED` and settlement status `NOT_ELIGIBLE`; capture/refund/void transitions belong to later milestones.
- **Tenant/security evidence:** every merchant-owned query and mutation must include the authenticated merchant ID in the database predicate. Cross-tenant identifiers must not reveal resource existence.
- **Event evidence:** the event catalog defines `payment.created.v1` with `eventId`, `occurredAt`, `merchantId`, `paymentId`, `amount`, `currency`, and `status`. The decision about when this milestone must persist that event is unresolved below.
- **Acceptance/release gates:** M0 requires the error/idempotency skeleton; M1 requires create/read/capture/refund/ledger and FR02-FR06/INV01-INV10; M2 introduces Eventing/webhooks. The traceability appendix calls for an Idempotency ADR and duplicate/mismatch/in-progress/storm evidence.

This plan does not promote P1 authorize-then-capture (FR15). The specification's unanswered OQ05 defaults to direct capture and defers authorization. OQ01 must be closed before M1; its documented fallback is ETB and USD with no conversion.

## Authorization matrix

| Proposed artifact                   | Authorization evidence                                                                                                                                                                               | Planned ownership and limit                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PaymentIntent` / `payment_intents` | FR02; Payments boundary; conceptual data model; create/read endpoint catalog                                                                                                                         | Payments owns all writes and transitions. This slice creates and reads only.                                                     |
| Merchant relation and `merchant_id` | Merchant actor, tenant-isolation rules, and merchant external-reference uniqueness                                                                                                                   | Merchant Access owns `merchants`; Payments holds a restrictive FK and never writes Merchant Access tables.                       |
| `external_ref`                      | FR02 says duplicate external references within a merchant are rejected or replayed by documented policy; conceptual model proposes merchant-scoped uniqueness; create example includes `externalRef` | Payments stores it and enforces `(merchant_id, external_ref)` uniqueness. Exact conflict/replay policy requires approval.        |
| `amount_minor` and `currency`       | FR02 and global money rules                                                                                                                                                                          | Immutable creation terms in this slice; no balance or ledger meaning is inferred.                                                |
| `capture_method`                    | The normative create example sends `captureMethod: "manual"`; FR15 distinguishes later authorization behavior                                                                                        | Store only after the allowed vocabulary and default are approved. No automatic capture behavior is authorized here.              |
| Payment and settlement status       | Separate lifecycle tables and conceptual model                                                                                                                                                       | Payments owns both projections. This slice can write only `CREATED` and `NOT_ELIGIBLE`.                                          |
| Captured/refunded projections       | Conceptual `payment_intent` description                                                                                                                                                              | Initialize both to zero only. Later capture/refund commands own changes. They are not balances.                                  |
| Optimistic `version`                | Conceptual model and concurrency guidance                                                                                                                                                            | Initialize to zero; no metadata-update endpoint is authorized in this slice.                                                     |
| Idempotency record                  | FR05, idempotency architecture, capture workflow, and appendix request header                                                                                                                        | Idempotency module owns its table and acquisition/replay operations; Payments must use its port, never write its table directly. |
| `POST /v1/payment-intents`          | Endpoint catalog plus appendix example                                                                                                                                                               | Thin API adapter, `payments:write`, merchant identity from the existing guard, idempotency required.                             |
| `GET /v1/payment-intents/{id}`      | Endpoint catalog                                                                                                                                                                                     | Thin API adapter, `payments:read`, tenant-safe lookup, no idempotency key.                                                       |
| `payment.created.v1`                | Event catalog and Payments publishing responsibility                                                                                                                                                 | Payments supplies event data; Eventing owns persistence/delivery. Sequencing is a blocking decision.                             |

No specification evidence authorizes a `PaymentRequest`, payment line item, customer, provider, card, payment method, fee, tax, exchange-rate, balance, ledger, transition-history, or payment-specific audit table in this slice. None is proposed.

## Existing behavior

- Git was clean before planning: `git status --short --branch` returned only `## main...origin/main` at committed Merchant Access HEAD `0e9e47c`.
- [prisma/schema.prisma](../../prisma/schema.prisma) contains only `Merchant` and `ApiKey`; there is no financial or idempotency table.
- `packages/modules/merchant-access` authenticates opaque bearer credentials and returns only merchant ID, API-key ID, and scopes. Its fixed vocabulary already includes `payments:write` and `payments:read`.
- The global API guard authenticates all non-public routes, and `RequireMerchantScopes` can enforce endpoint scopes. No Payments, Idempotency, Eventing, Ledger, or Operations implementation exists.
- The current authenticated foundation route is `GET /api/v1`, while the authoritative specification uses `/v1` for the payment endpoints. This is a real namespace conflict and cannot be silently resolved in code.
- The current NestJS default error body is not the required RFC 9457 problem-details contract. No global request-ID propagation or payment DTO validation foundation exists.
- PostgreSQL and RabbitMQ readiness/lifecycle behavior is already centralized. Payment create/read must not replace or weaken it.
- Existing migrations establish the Prisma foundation and Merchant Access only. A later migration must work both from an empty database and from the committed Merchant Access migration state.
- ADR-0003 permits Prisma by default and reviewed, parameterized raw SQL only where financial/concurrency correctness cannot be safely expressed. ADR-0004 already requires an outbox, publisher confirms, manual acknowledgements, and at-least-once consumers when messaging is introduced.

Evidence reviewed for this plan includes `AGENTS.md`, `PLANS.md`, `CONTRIBUTING.md`, `SECURITY.md`, all files under `docs/architecture`, ADR-0001 through ADR-0005 and their index, all existing plans, the complete unchanged v1.0 `.docx` specification, the full Prisma schema and migrations, the Merchant Access package/API guard/tests/documentation, the root README, workspace scripts, and current OpenAPI setup.

## Decisions required before implementation

The product capability is P0 and therefore authorized, but implementation is **not yet safe to begin**. The following decisions must be accepted first; this plan does not make them authoritative.

### ADRs required

1. **Payment and settlement lifecycle ADR.** Record the specification's separate state machines, initial states, legal transitions, terminal states, ownership, row-locking rule, dormant P1 `AUTHORIZED` state, repeated partial-refund behavior, and whether future enum values are created now or added with later migrations. The specification explicitly identifies lifecycle separation as an ADR topic.
2. **Idempotency ADR.** Define the exact table, canonical request fingerprint, merchant/method/normalized-route/key scope, single-winner PostgreSQL acquisition, owner lease and stale-owner recovery, response-snapshot transaction sequence, replay contract, conflict/in-progress errors, expiry, and cleanup. The specification traceability matrix explicitly requires this ADR, and the architecture document marks final response-snapshot sequencing as undecided.

ADR-0003 must be cited by the idempotency ADR if its acquisition uses parameterized raw SQL. ADR-0004 is sufficient for delivery semantics, but the event sequencing choice below may require an amendment or a specification waiver if creation events are deferred.

### Contract and milestone decisions requiring recorded approval

| Decision                     | Evidence/problem                                                                                                                                                | Recommended resolution                                                                                                                                                                                                                     | Approval deadline               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| API base path                | Specification says `/v1`; committed foundation says `/api/v1`.                                                                                                  | Treat the specification as authoritative and expose payment routes at `/v1`; separately decide whether `/api/v1` remains a compatibility-only foundation route or is deprecated. Do not create both payment route families implicitly.     | Before controller/OpenAPI work  |
| Public payment ID            | Examples use an opaque prefixed `pi_...` form; the current data foundation uses UUIDs; no normative identifier format is stated.                                | Approve one project-wide public-ID policy. Prefer a UUID primary key only if the appendix identifier is confirmed illustrative; otherwise use an internal UUID plus a uniquely indexed immutable public ID.                                | Before migration                |
| Supported currencies         | OQ01 is unresolved and must close before M1; fallback is ETB and USD, with no conversion.                                                                       | Explicitly accept the fallback allow-list `{ETB, USD}` for v1 or approve a different finite list.                                                                                                                                          | Before DTO/schema constraints   |
| `amountMinor` API range      | PostgreSQL `BIGINT` exceeds JavaScript's safe JSON integer range. The spec requires integer JSON and overflow rejection.                                        | Accept `1..9,007,199,254,740,991`, serialize as a JSON integer, and store as `BIGINT`; otherwise the API representation must change through specification control.                                                                         | Before DTO/OpenAPI work         |
| `externalRef` contract       | Required/unique behavior is clear; length, character policy, whitespace, case, and replay policy are not.                                                       | Require 1-255 characters, reject control characters and leading/trailing whitespace, compare case-sensitively, preserve the accepted value, and use merchant-scoped uniqueness.                                                            | Before migration/DTO work       |
| Duplicate external reference | FR02 explicitly allows either rejection or documented replay.                                                                                                   | Same idempotency key plus same fingerprint replays the original response. A different key that collides on `(merchant_id, external_ref)` returns `409 external_reference_conflict`; never infer equivalence from external reference alone. | In Idempotency ADR              |
| `captureMethod`              | Only `manual` appears in the create example; allowed values/default and automatic behavior are undefined.                                                       | Require the field and accept only `manual` in this slice. Do not default or auto-capture. Broaden only with an approved lifecycle/API change.                                                                                              | Before DTO/schema work          |
| Create-event sequencing      | `payment.created.v1` is catalogued, but Eventing is M2 and no outbox exists. Creating rows now and emitting only for future rows later loses historical events. | Either include the minimal Eventing outbox persistence dependency in the implementation transaction, or approve an explicit M1 event deferral plus deterministic backfill/non-public-release policy. Do not publish directly to RabbitMQ.  | Before migration/service design |
| Error contract               | RFC 9457, stable codes, and `requestId` are required; exact endpoint status/schema remains open.                                                                | Approve the matrix below and a shared problem-details/request-ID adapter before exposing payment routes.                                                                                                                                   | Before controller work          |
| Record retention             | Financial-record deletion/retention is not specified.                                                                                                           | Provide no delete endpoint and no physical deletion in v1; establish retention before any purge/archive feature.                                                                                                                           | Before release                  |
| Audit interpretation         | FR14 covers privileged actions; the security list says “creation” without clearly naming payment creation.                                                      | Do not invent a payment audit table. Confirm that merchant create evidence is the payment row, idempotency record, correlation data, and creation event; reserve `audit_events` for explicitly privileged operator actions.                | Before release                  |

The missing repeated transition `PARTIALLY_REFUNDED -> PARTIALLY_REFUNDED` is also material: cumulative partial refunds imply it, but the lifecycle table does not state it. The lifecycle ADR must either add it through specification clarification or explain a different model before refund work. It does not block creation if later states are not made writable, but it blocks claiming the full lifecycle is settled.

## Proposed design

### Boundary and request flow

1. The API adapter authenticates the bearer API key through Merchant Access and requires `payments:write` or `payments:read` on the handler.
2. The adapter validates route/header/body and obtains the immutable merchant request identity. Controllers contain no persistence or financial rules.
3. For create, the Payments application service calls the Idempotency port using merchant ID, HTTP method, normalized route template, key, and a canonical fingerprint of the validated command.
4. A single PostgreSQL transaction creates the merchant-owned payment intent, optionally persists `payment.created.v1` through an Eventing port if the sequencing decision requires it, and finalizes idempotency according to the approved ADR. There are no network calls in the transaction.
5. For retrieve, the Payments repository queries by both payment ID and authenticated merchant ID. A missing or foreign record produces the same `404 payment_intent_not_found` response.
6. Prisma client ownership and shutdown remain in `PrismaDatabase`; modules receive the shared lifecycle-managed client and never instantiate a second connection pool.

### Proposed Payments package

Create `packages/modules/payments` only during the later implementation. It should expose application commands/queries and ports, keep Prisma in an adapter, and not expose generated Prisma records as API DTOs. The API should add only a thin payment-intent controller, request/response DTOs, and error mapping. The worker has no Payment Request responsibility.

Rejected alternatives:

- A `payment_requests` table or module: not named or owned by the specification.
- Putting payment code in Merchant Access: violates the bounded-context ownership table.
- Letting controllers access Prisma: bypasses ownership, transaction, and tenant rules.
- Using RabbitMQ as part of the synchronous create path: violates financial correctness and outbox rules.
- Treating `externalRef` as the idempotency mechanism: it cannot bind the full request fingerprint or safely replay an exact response.
- Floating-point/decimal major-unit amounts: violates the money representation invariant.

## Exact proposed data model

The following is the proposed review baseline, not a schema change. Names are physical PostgreSQL names; Prisma fields use the repository's camelCase mapping convention.

### Payments-owned `payment_intents`

| Column                  | PostgreSQL/Prisma shape                | Null/default                                        | Rule and evidence                                                                                             |
| ----------------------- | -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`                    | `UUID` / `String @db.Uuid`             | PK; generation depends on public-ID decision        | Immutable payment identifier.                                                                                 |
| `merchant_id`           | `UUID` / relation to `Merchant`        | NOT NULL; `ON DELETE RESTRICT`, `ON UPDATE CASCADE` | Tenant owner; every lookup/mutation also predicates on it. FK does not grant Merchant Access write authority. |
| `external_ref`          | proposed `VARCHAR(255)`                | NOT NULL                                            | Merchant-provided business key; unique with `merchant_id`; exact validation requires approval.                |
| `amount_minor`          | `BIGINT` / `BigInt`                    | NOT NULL                                            | Original requested amount in minor units; `CHECK amount_minor > 0`; immutable.                                |
| `currency`              | `CHAR(3)`                              | NOT NULL                                            | `CHECK currency ~ '^[A-Z]{3}$'`; application allow-list enforces approved supported currencies; immutable.    |
| `capture_method`        | proposed enum `payment_capture_method` | NOT NULL                                            | Only `MANUAL` is proposed for this slice; vocabulary requires approval.                                       |
| `payment_status`        | enum `payment_status`                  | NOT NULL, `CREATED`                                 | Full allowed enum depends on lifecycle ADR; this slice writes only `CREATED`.                                 |
| `settlement_status`     | enum `settlement_status`               | NOT NULL, `NOT_ELIGIBLE`                            | Independent lifecycle; this slice writes only `NOT_ELIGIBLE`.                                                 |
| `captured_amount_minor` | `BIGINT` / `BigInt`                    | NOT NULL, `0`                                       | Projection only; `CHECK 0 <= captured_amount_minor AND captured_amount_minor <= amount_minor`.                |
| `refunded_amount_minor` | `BIGINT` / `BigInt`                    | NOT NULL, `0`                                       | Projection only; `CHECK 0 <= refunded_amount_minor AND refunded_amount_minor <= captured_amount_minor`.       |
| `version`               | `INTEGER`                              | NOT NULL, `0`                                       | Optimistic concurrency token for later metadata/update paths; `CHECK version >= 0`.                           |
| `created_at`            | `TIMESTAMPTZ(6)`                       | NOT NULL, current time                              | Durable creation time in UTC.                                                                                 |
| `updated_at`            | `TIMESTAMPTZ(6)`                       | NOT NULL, current time                              | Current aggregate projection update time.                                                                     |

Required database objects:

- Primary key on `id` and named unique constraint on `(merchant_id, external_ref)`.
- Restrictive FK to `merchants(id)`.
- Named checks for positive amount, three-uppercase-character currency, non-negative projections, projection upper bounds, and non-negative version.
- A state/projection consistency check so `CREATED` always has captured/refunded zero and `NOT_ELIGIBLE`; exact later-state expressions wait for the lifecycle ADR.
- No provider, ledger, settlement-batch, customer, payment-method, fee, tax, webhook, event, or audit columns.
- No soft-delete or delete endpoint. A later retention decision controls archival/purge.
- A tenant-safe `WHERE id = ? AND merchant_id = ?` explain plan must be recorded. Because `id` is globally unique, the primary-key plan may be sufficient; add a redundant composite index only if measurement proves it necessary.

Whether the first migration creates only currently writable enum values or the entire specification-authorized future vocabulary must be decided by the lifecycle ADR. Predeclaring future values does not authorize endpoints or transitions.

### Idempotency-owned `idempotency_keys`

This supporting model is required before create can be safely exposed but is not Payments-owned. Its exact ADR baseline is:

| Column                     | Proposed shape                  | Purpose                                                                                                    |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`                       | `UUID` PK                       | Internal record identity.                                                                                  |
| `merchant_id`              | `UUID` NOT NULL, restrictive FK | Tenant scope.                                                                                              |
| `http_method`              | `VARCHAR(8)` NOT NULL           | Uppercase `POST`.                                                                                          |
| `normalized_route`         | `VARCHAR(255)` NOT NULL         | Stable template `/v1/payment-intents`, never raw query/path data.                                          |
| `idempotency_key`          | `VARCHAR(255)` NOT NULL         | Validated caller key; prohibited from logs/telemetry. Storage/hash treatment must be confirmed in the ADR. |
| `request_hash`             | `CHAR(64)` NOT NULL             | SHA-256 of the canonical validated command representation.                                                 |
| `state`                    | enum `IN_PROGRESS`, `COMPLETED` | Acquisition/finalization state; do not add ambiguous terminal states without recovery semantics.           |
| `owner_token`              | `UUID`                          | Single-winner lease identity while in progress.                                                            |
| `lease_expires_at`         | `TIMESTAMPTZ(6)`                | Stale-owner recovery boundary.                                                                             |
| `response_status`          | `INTEGER` nullable              | Exact completed HTTP status snapshot.                                                                      |
| `response_headers`         | `JSONB` nullable                | Only approved replay-safe headers, never credentials or idempotency-key values.                            |
| `response_body`            | `JSONB` nullable                | Exact completed response/problem snapshot after redaction rules.                                           |
| `completed_at`             | `TIMESTAMPTZ(6)` nullable       | Completion evidence.                                                                                       |
| `expires_at`               | `TIMESTAMPTZ(6)` NOT NULL       | Minimum 24 hours; proposed default seven days.                                                             |
| `created_at`, `updated_at` | `TIMESTAMPTZ(6)` NOT NULL       | Lifecycle evidence and cleanup ordering.                                                                   |

Require unique `(merchant_id, http_method, normalized_route, idempotency_key)`, an expiry index, and state/snapshot consistency checks. Acquisition must use a proven single-winner pattern under PostgreSQL Read Committed; a reviewed parameterized raw statement is expected because Prisma cannot express the required acquire-and-return conflict behavior safely. The ADR must settle raw-key versus keyed-hash storage, exact lease length, bounded waiting, and whether response completion shares the domain transaction.

No `audit_events` or outbox table is proposed here. If `payment.created.v1` is required in the same milestone, Eventing must first define and own the outbox schema under ADR-0004.

## State machines and permitted transitions

### Payment lifecycle

| From                               | Command                    | To                   | Status in this slice                 | Preconditions/effect                                                                                                                          |
| ---------------------------------- | -------------------------- | -------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| No record                          | Create intent              | `CREATED`            | Authorized                           | Valid merchant, `payments:write`, valid body, idempotency winner, unique merchant external reference; captured/refunded projections are zero. |
| `CREATED`                          | Capture                    | `CAPTURED`           | Deferred                             | Valid amount, row lock, idempotency, ledger and outbox atomicity.                                                                             |
| `CREATED`                          | Authorize                  | `AUTHORIZED`         | P1 deferred                          | FR15/OQ05; no endpoint in this slice.                                                                                                         |
| `CREATED` or `AUTHORIZED`          | Void                       | `VOIDED`             | Deferred/endpoint unspecified        | No later capture. Exact void API is not authorized by the current endpoint catalog.                                                           |
| `CAPTURED`                         | Partial refund             | `PARTIALLY_REFUNDED` | Deferred                             | Refund > 0 and cumulative refund < captured amount.                                                                                           |
| `PARTIALLY_REFUNDED`               | Another partial refund     | `PARTIALLY_REFUNDED` | Requires specification clarification | Implied by cumulative refunds but missing from the explicit transition table.                                                                 |
| `CAPTURED` or `PARTIALLY_REFUNDED` | Complete cumulative refund | `REFUNDED`           | Deferred                             | Cumulative refund equals captured amount.                                                                                                     |

All other transitions are forbidden. `GET` never transitions state. A generic state-update method must not exist; later commands encode specific transitions and locking.

### Settlement lifecycle

`NOT_ELIGIBLE -> ELIGIBLE -> BATCHED -> SETTLED -> ADJUSTMENT_PENDING` is separate from payment status. Creation writes only `NOT_ELIGIBLE`; this slice cannot make a payment eligible. No endpoint may derive a settlement status from the payment status without the later capture/settlement rules.

## Amount, currency, and money handling

- Accept only JSON integer `amountMinor`; reject strings, decimals, exponents that do not represent a safe integer, `NaN`, infinities, zero, negatives, and values above the approved maximum.
- Proposed API range is `1..Number.MAX_SAFE_INTEGER`; convert explicitly to Prisma `bigint` after validation and convert back only after proving the value is in the approved JSON-safe range.
- Persist `amount_minor` as PostgreSQL `BIGINT`. Never use JavaScript floating-point arithmetic for monetary calculations, SQL `REAL/DOUBLE`, or major-unit decimal input.
- Accept one uppercase three-letter currency per intent. Reject lowercase rather than silently normalizing so the canonical idempotency fingerprint is unambiguous.
- Apply the approved finite supported-currency allow-list in the Payments domain. The proposed OQ01 fallback is ETB and USD. No FX conversion, exponent lookup, rounding, or cross-currency aggregation occurs.
- `captured_amount_minor` and `refunded_amount_minor` initialize to zero; they are not calculated or mutated in this slice.
- Response money uses `{ "amountMinor": <integer>, "currency": "ETB" }` semantics. The final response schema must be captured in OpenAPI before implementation is marked complete.

## API and integration impact

### Proposed request/response contract

| Method/path                    | Scope            | Request                                                                                                             | Success                                                                                                                                | Tenant behavior                                                                                |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /v1/payment-intents`     | `payments:write` | Bearer key; `Idempotency-Key` (1-255); JSON body with `externalRef`, `amountMinor`, `currency`, and `captureMethod` | Proposed `201`; body contains immutable ID, submitted fields, `CREATED`, `NOT_ELIGIBLE`, zero projections, version, and UTC timestamps | Merchant ID comes only from authentication, never body/query.                                  |
| `GET /v1/payment-intents/{id}` | `payments:read`  | Bearer key and validated ID                                                                                         | `200` with the same resource representation                                                                                            | Query includes `id` and authenticated `merchant_id`; missing/foreign both return the same 404. |

There is no list, update, delete, capture, refund, void, authorize, or public lookup endpoint in this slice.

### Validation and error behavior

- Enforce `application/json`, a bounded request body, a strict object schema, and rejection of unknown fields.
- `externalRef`: proposed 1-255 characters, no control characters, no leading/trailing whitespace, case-sensitive and otherwise preserved. Do not derive it from a request ID.
- `amountMinor`: required safe positive integer under the approved maximum.
- `currency`: required uppercase three-letter supported code.
- `captureMethod`: required literal `manual` until the contract is expanded.
- `Idempotency-Key`: required on create, 1-255 characters after syntax validation, no control characters or surrounding whitespace, and never logged. GET ignores no supplied key semantically but middleware must not log its value.
- Reject body-supplied `merchantId`, `status`, settlement state, projections, version, timestamps, provider data, or IDs.
- Accept a valid `X-Request-Id` or generate one, return it, and propagate it as correlation metadata. Exact allowed syntax/length must be set in the shared API contract.
- All errors use `application/problem+json` in RFC 9457 shape with stable `code` and `requestId`; no raw database, validation-library, credential, idempotency-key, or request-body details.

Proposed status/code matrix requiring approval:

| Condition                                                     | HTTP                                    | Stable code                        |
| ------------------------------------------------------------- | --------------------------------------- | ---------------------------------- |
| Malformed/unknown field, invalid identifier/header/type/range | 400                                     | `invalid_request`                  |
| Missing or invalid API key                                    | 401                                     | `unauthorized`                     |
| Valid key missing required scope                              | 403                                     | `insufficient_scope`               |
| Missing or foreign payment intent                             | 404                                     | `payment_intent_not_found`         |
| Unsupported currency or unsupported capture method            | 422                                     | `unsupported_payment_intent_value` |
| Same idempotency scope/key with changed fingerprint           | 409                                     | `idempotency_key_reused`           |
| Same key/fingerprint still owned by an unexpired request      | proposed 409 plus bounded `Retry-After` | `idempotency_request_in_progress`  |
| Different key collides with merchant external reference       | 409                                     | `external_reference_conflict`      |
| Database unavailable/transaction retries exhausted            | 503                                     | `service_unavailable`              |

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
3. Begin a bounded database transaction and acquire the scoped idempotency record with the ADR-approved single-winner statement.
4. A completed same-fingerprint record returns its stored response without a second insert/event. A changed fingerprint returns the documented 409. An active owner returns/waits according to the ADR. An expired lease is taken over only by the proven recovery algorithm.
5. The winner inserts one `payment_intents` row using the authenticated merchant ID. The unique external-reference constraint is the final race guard.
6. If creation events are included, call the Eventing port to persist one outbox row in this same transaction. Never contact RabbitMQ in the request transaction.
7. Finalize the response snapshot exactly once using the ADR-approved transaction sequence.
8. Commit, then return/replay the durable response. Serialization/deadlock retries rerun the entire transaction with a small bounded retry count and the same owner/fingerprint semantics.

Default PostgreSQL isolation remains Read Committed unless a measured/proven case justifies stronger isolation. Set bounded lock and statement timeouts. There is no payment row to lock before creation; uniqueness and idempotency acquisition choose the winner. No network call, broker publish, password hashing, or API-key verification occurs inside the database transaction.

The exact response-snapshot sequence is intentionally unresolved because the specification workflow says commit then persist the snapshot while the architecture notes call the sequence TBD. The Idempotency ADR must analyze crash points: before payment insert, after insert/before outbox, after domain commit/before snapshot, after snapshot/before HTTP response, and lease takeover after process death.

## Audit and event requirements

- The Payment Intent row, immutable merchant/external reference, timestamps, request/correlation ID in telemetry, and completed idempotency snapshot provide command evidence. Logs are not the source of financial truth.
- `payment.created.v1` is the only authorized domain event for this slice. Its envelope/payload must include the catalogued event ID, occurrence time, merchant ID, payment ID, amount, currency, and `CREATED` status, plus approved correlation metadata. It contains no API key, idempotency-key value, raw request body, or provider data.
- Event IDs are generated once and persisted; at-least-once delivery must not create a second logical event. Eventing owns the outbox and the worker, and future consumers own their projections/inbox deduplication.
- Payment creation is a merchant command, not an explicitly privileged operator action under FR14. No `audit_events` row or Payments-owned audit table is proposed without specification clarification. API-key creation/rotation/disablement and future privileged replays remain Operations audit concerns.
- Application logs may include request ID, merchant ID, payment ID, API-key ID, route template, method, status, duration, and stable error code. They must omit credentials, authorization headers, idempotency-key values, request/response bodies, and raw financial payloads.

## Affected modules and files for the later implementation

| Module/file area                                       | Ownership or change                                       | Boundary impact                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/modules/payments`                            | New Payments application/domain/repository package        | Owns `payment_intents`; depends on ports for Idempotency/Eventing, not their tables.     |
| Idempotency module path to be approved                 | New cross-cutting command-deduplication package           | Owns `idempotency_keys`; merchant-scoped API used by Payments and future money commands. |
| `apps/api/src/payment-intents`                         | Thin controller, DTOs, OpenAPI, problem mapping           | Uses Merchant Access identity/scopes and Payments application API.                       |
| `apps/api/src/app.module.ts`                           | Composition only                                          | Wires shared Prisma lifecycle, repositories, and application services.                   |
| Shared API request-ID/problem-details area to be named | Cross-cutting HTTP contract                               | Must not leak domain/credential details.                                                 |
| `prisma/schema.prisma` and one reviewed migration      | Add only approved Payment/Idempotency/Eventing structures | Each module retains write ownership despite shared physical schema.                      |
| `test/integration`                                     | Real PostgreSQL API/concurrency/failure tests             | Exercises tenant and duplicate guarantees, not mocked SQL.                               |
| `docs/api`, committed OpenAPI, README/runbook          | Exact contract and operator commands                      | Must resolve `/v1` versus `/api/v1` before generation.                                   |

No reverse dependency from Ledger, Merchant Access, or Eventing to Payments is introduced. A Prisma relation is referential integrity, not permission for cross-module writes.

## Database and migration plan

1. Approve the lifecycle and Idempotency ADRs plus all contract decisions above.
2. Add Prisma models/enums with explicit mapped names, restrictive foreign keys, and named indexes.
3. Generate a create-only migration against local PostgreSQL; manually review every statement. Add only the CHECK constraints/raw DDL Prisma cannot express, with comments tying each to an invariant.
4. Apply from an empty database and from a fixture at the current Merchant Access migration. Verify migration status and Prisma validation/generation.
5. Prove that the merchant external-reference unique constraint is tenant-scoped, all cross-column checks reject invalid rows, and FK deletion is restricted.
6. Capture `EXPLAIN (ANALYZE, BUFFERS)` for merchant-scoped ID lookup and duplicate-key acquisition; add indexes only from evidence.
7. If outbox persistence is approved for this milestone, order its migration before code that requires it and preserve compatibility for the API and worker. Otherwise record the approved deferral/backfill policy explicitly.
8. Do not seed payment intents or idempotency records. Integration tests create synthetic records transactionally/ephemerally.

Migration rollback is safe only before durable payment data exists. After use, dropping payment/idempotency/event evidence is forbidden; use forward fixes and expand-contract migrations.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario                      | Expected safe state                                                          | Retry/recovery                                              | Required evidence            |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------- |
| PostgreSQL unavailable before acquisition          | No payment or idempotency row                                                | 503; caller retries with same key                           | Integration failure test     |
| Two requests, same key/fingerprint                 | Exactly one payment; both eventually receive the same snapshot               | Single winner; bounded wait/replay                          | Concurrent storm test        |
| Same key, changed body                             | Original state unchanged; no second payment                                  | 409 `idempotency_key_reused`                                | Contract/integration test    |
| Different keys, same merchant/external ref         | Exactly one payment                                                          | Unique constraint; loser gets documented 409                | Race test                    |
| Same external ref for different merchants          | One payment per merchant allowed                                             | Tenant-scoped uniqueness                                    | Database/integration test    |
| Cross-tenant GET                                   | No data disclosure                                                           | Same 404 as missing                                         | Security integration test    |
| Crash before transaction commit                    | No payment/event/completed snapshot                                          | Lease/transaction recovery; same key retries                | Failure-injection test       |
| Crash after domain commit but before HTTP response | One payment and durable replay evidence according to ADR                     | Same key returns stored response                            | Crash-point integration test |
| RabbitMQ unavailable                               | If outbox included, payment/outbox commit remains allowed; no direct publish | Worker retries later; readiness remains per existing policy | Dependency failure test      |
| Serialization/deadlock error                       | No partial commit                                                            | Retry whole transaction within bound                        | Injected SQL-state test      |
| Unsupported/overflow money input                   | No database writes                                                           | Correct problem response                                    | Unit/contract test           |
| Idempotency lease expires                          | Never create a second payment                                                | ADR-approved safe takeover/read by business uniqueness      | Stale-owner test             |

## Security and privacy

- Require the existing opaque bearer credential and exact scope per endpoint. Never accept merchant identity from request-controlled fields.
- Put `merchant_id` in every repository predicate, including conflict/read paths; use parameterized Prisma queries or reviewed parameterized raw SQL.
- Return tenant-safe 404s and generic authentication errors. Scope failure is 403 without revealing resources.
- Bound body/header/path sizes before canonicalization or database work. Reject unknown fields and control characters.
- Do not log authorization data, API keys, idempotency keys, raw bodies, response snapshots, or unsanitized external references. Treat external references as untrusted data in logs and traces.
- Keep only business/payment metadata authorized by the specification. No PAN, bank account, provider credential, customer PII, card token, email, phone, tax, or KYC field is accepted or stored.
- Protect response snapshots and payment rows with the same database access controls/backups as transactional data. Cleanup may purge expired response bodies only under the approved retention policy; it must not delete payment truth.
- Complete a security review covering tenant isolation, ID enumeration, idempotency resource exhaustion, hash/canonicalization ambiguity, SQL parameterization, problem-detail leakage, and denial-of-service bounds.

## Observability and operations

- Trace names: `payments.create`, `payments.get`, `idempotency.acquire`, `idempotency.replay`, and, if applicable, `outbox.persist`. No trace attribute contains a key or raw body.
- Structured fields: service, route template, method, status, duration, request/correlation ID, merchant ID, API-key ID, payment ID when known, stable error code, and replay boolean. Exclude `externalRef` unless separately classified/sanitized.
- Metrics: request latency/count by route/status, create success/failure, idempotency acquired/replayed/conflict/in-progress, external-reference conflicts, database retry exhaustion, and outbox backlog only when Eventing exists. Do not use merchant/payment IDs as metric labels.
- Preserve current liveness/readiness semantics. PostgreSQL remains required for API readiness; RabbitMQ behavior remains as committed until an approved outbox operational design changes it.
- Add a runbook for investigating idempotency conflicts/stale owners and payment-create failures without mutating financial records. Manual replay must be privileged and audited when it is later implemented.
- Target the specification's reference create/capture latency gate (create p95 under 300 ms and p99 under 600 ms in the stated local/reference conditions) without weakening correctness.

## Test strategy

- **Unit:** command/body/header validators; canonical fingerprint vectors; money range conversion; status initialization; problem-code mapping; tenant ID propagation; forbidden transition tests for any state-machine helper.
- **Database constraints/migrations:** empty and prior-version migration; Prisma validate/generate; positive amount; uppercase currency syntax; projections; initial-state consistency; tenant external-reference uniqueness; restrictive FK; no invalid direct row.
- **Integration with real dependencies:** Testcontainers PostgreSQL for create/read, exact replay, mismatch, duplicate external reference, cross-tenant isolation, scope/auth failures, unavailable database, and clean Prisma lifecycle. RabbitMQ is needed only for existing readiness or an approved outbox path.
- **Contract:** committed OpenAPI matches runtime; exact paths/scopes/request/response/problem schemas; examples contain synthetic credentials/data; no secret or invalid decimal money example.
- **Concurrency/race:** same-key storm, different-key/same-external-ref race, stale lease takeover, response replay after simulated response loss, and (later) row-lock transition races.
- **Failure injection/recovery:** every transaction/snapshot crash point, deadlock/serialization whole-transaction retry, DB outage, and broker outage if outbox included.
- **Security:** missing/malformed/revoked key behavior remains generic; wrong scopes; cross-tenant ID and external-reference probes; oversized body/header; control characters; unknown fields; log/trace scans for credentials, idempotency keys, and bodies.
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

- Add the approved lifecycle and Idempotency ADRs and index them.
- Update architecture documentation only if an approved decision clarifies lifecycle, idempotency response sequencing, event sequencing, identifier policy, or API namespace; plans cannot override those documents.
- Add Payment Intent API/security documentation and generated OpenAPI examples.
- Update README with exact create/read development and test commands using placeholders, never usable keys.
- Add idempotency/recovery operational guidance and migration verification evidence.
- Update this plan's status, checklist, and verification record during implementation.

## Explicitly deferred work

- Capture, authorization, void, partial/full refunds, provider references, and provider adapters.
- Every ledger account/entry/balance and the atomic domain-ledger transition.
- Settlement eligibility/transitions/batches, adjustments, reconciliation, and reporting.
- RabbitMQ topology, publisher/consumer runtime, inbox, dead letters, webhook endpoints/delivery, and business-event consumers. The creation outbox persistence decision remains a prerequisite, not implicit implementation authority for these items.
- Payment transition-history storage unless separately authorized; state transitions remain aggregate behavior.
- Merchant/operator management endpoints, privileged replay tooling, and audit UI.
- Pagination/list/search, update/delete, customer objects, payment methods, subscriptions, fees, tax, FX, KYC, real bank/card rails, and a customer-facing frontend.

## Rollback or forward-recovery strategy

Before deployment/data, revert application wiring and an unapplied migration. After any payment intent is durably created, never roll back by dropping/truncating payment, idempotency, or outbox evidence. Disable the new route at deployment/configuration level if necessary, retain readable records, and ship a forward-compatible fix. Schema changes follow expand-contract so the previous API/worker can run during deployment. There are no ledger postings to reverse in this slice.

## Risks and assumptions

| Risk or assumption                                                          | Impact                                                              | Mitigation/validation                                                      | Owner/deadline                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| `/v1` versus `/api/v1` conflict remains unresolved                          | Wrong public contract or duplicate route families                   | Approve namespace before controller/OpenAPI work                           | Maintainers / before implementation                     |
| Response-snapshot sequencing is undefined                                   | A crash could create a payment without replayable response evidence | Idempotency ADR plus crash-point tests                                     | Architecture owner / before implementation              |
| Eventing is scheduled after M1 although `payment.created.v1` is catalogued  | Missing historical events or scope expansion                        | Approve atomic outbox now or explicit deferral/backfill policy             | Product and architecture owners / before implementation |
| Public ID format is unspecified                                             | Irreversible API/storage contract                                   | Approve identifier policy before migration                                 | Architecture/API owner / before implementation          |
| Money range and currency set are unresolved                                 | Overflow or unsupported-currency ambiguity                          | Approve safe JSON range and OQ01 list                                      | Product owner / before implementation                   |
| External-reference and capture-method contracts are under-specified         | Inconsistent validation/replay across clients                       | Approve proposed exact rules                                               | Product/API owner / before implementation               |
| Raw SQL is likely needed for idempotency acquisition                        | Concurrency or SQL-injection defect                                 | ADR-0003 review, parameterization, real PostgreSQL race tests              | Data owner / before merge                               |
| Future states predeclared in enums may be mistaken for implemented behavior | Unauthorized transitions                                            | Lifecycle ADR, command-specific APIs, state/check tests                    | Payments owner / before migration                       |
| Merchant creation may be misread as a privileged audit requirement          | Missing evidence or invented cross-boundary table                   | Clarify FR14/security wording; use Eventing/Idempotency evidence meanwhile | Security/product owner / before release                 |

## Execution checklist

- [x] Governance, specification, current schema/migrations, architecture, ADRs, Merchant Access, README, and existing plans reviewed.
- [x] Authorization evidence and boundary ownership mapped.
- [x] Contradictions, missing decisions, and required ADRs identified.
- [ ] Payment/settlement lifecycle ADR accepted.
- [ ] Idempotency ADR accepted.
- [ ] API namespace, identifier, currency/range, external-reference, capture-method, error, event, retention, and audit decisions approved.
- [ ] Design and boundaries reviewed.
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
| Prettier, local links, whitespace, diff, and status checks  | Pass              | 2026-08-01: plan-only checks; only this untracked plan remained                                                                                       |
| Application, database, dependency, test, or runtime command | Not run by design | Planning-only milestone; no implementation verification authorized                                                                                    |

## Definition of done

This planning milestone is complete when this file is the only worktree change; it maps every authorized Payment Intent model/endpoint and cross-cutting requirement; gives reviewable table, state, money, idempotency, error, audit/event, migration, security, failure, and test designs; explicitly identifies blocking ADRs/decisions; defers all unauthorized financial/application work; passes Markdown link and whitespace checks; and records a complete Git status without a commit or push.

The later implementation milestone is not authorized to start merely because this plan exists. It begins only after the required ADRs and contract decisions are accepted and the plan status is changed from `Draft` to `Approved`.
