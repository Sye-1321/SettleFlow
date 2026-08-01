# ADR-0016: Webhook endpoint API, ownership, and subscriptions

- **Status:** Accepted
- **Date:** 2026-08-01
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through Webhook Endpoint Foundation approval
- **Supersedes:** None
- **Superseded by:** None

## Context

The specification authorizes merchant-scoped webhook endpoint registration, inspection, disablement, subscriptions, and secret rotation. It supplies create and update routes but leaves list/read and rotation route details, public ID format, concurrency preconditions, URL mutability, normalized uniqueness, and subscription persistence to repository design.

These choices must be settled before endpoint models or APIs exist so tenant isolation, concurrent administration, and future event projection have one stable contract. This ADR defines the Webhooks-owned endpoint aggregate only. It does not authorize outbound delivery or the `payment.created.v1` consumer.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): FR-09 and FR-10; endpoint catalog; core data model; webhook security and delivery lifecycle.
- [Architecture overview](../architecture/README.md)
- [Module boundaries](../architecture/module-boundaries.md)
- [Security policy](../../SECURITY.md)
- [ADR-0008](0008-api-version-path-and-compatibility.md)
- [ADR-0013](0013-problem-details-audit-and-retention-boundaries.md)
- [ADR-0014](0014-webhook-endpoint-url-and-ssrf-policy.md)
- [ADR-0015](0015-webhook-signing-secret-encryption-and-rotation.md)
- [ADR-0017](0017-webhook-endpoint-lifecycle-audit.md)

## Decision drivers

- Enforce merchant ownership in every endpoint operation.
- Provide stable non-sequential public identifiers without exposing database UUIDs.
- Prevent lost updates and unsafe concurrent rotations.
- Keep destination identity immutable and merchant duplicates deterministic.
- Model subscriptions relationally for constraints and processing-time eligibility.
- Expose only the endpoint-management surface needed by the specification.

## Considered options

### Option A: Merchant-owned aggregate with ULID public IDs, ETag preconditions, immutable URL, and normalized subscriptions

Use `whe_<ULID>` public IDs, scoped queries, an integer aggregate version surfaced as an ETag, immutable normalized URLs, and one subscription row per endpoint/event type. Add bounded list/read and explicit secret-rotation routes.

### Option B: UUIDs in the public API and last-write-wins updates

This exposes storage identifiers and permits concurrent status/subscription/rotation changes to overwrite one another. It is rejected.

### Option C: Mutable URLs on an endpoint

Changing a destination under an existing identity obscures ownership/audit history and complicates SSRF revalidation. It is rejected.

### Option D: Store subscriptions as a JSON or array column

This weakens per-event uniqueness, validation, indexing, and future eligibility queries. It is rejected.

### Option E: Create deliveries for endpoints that were historically subscribed

Historical fanout invents delivery obligations after the event-processing moment. It is rejected.

## Decision

The decision is **Option A**.

### Endpoint identity and ownership

- The database may use an internal UUID, but every public endpoint identifier is exactly `whe_` plus a 26-character uppercase Crockford ULID.
- Generate IDs from a process-scoped monotonic ULID factory using cryptographic randomness. On a named public-ID uniqueness collision, attempt generation at most three times total, then fail safely with a stable service error.
- Every read and mutation includes authenticated `merchant_id` in its database predicate. Missing and foreign-merchant IDs return the same `404 webhook_endpoint_not_found` problem.
- An endpoint starts `ACTIVE` and has a nonnegative integer version. Supported public status values are `active` and `inactive`; there is no delete endpoint or hidden soft-delete state.
- Endpoint URL is immutable. To change a destination, create a new endpoint and make the old endpoint inactive.
- The canonical URL from [ADR-0014](0014-webhook-endpoint-url-and-ssrf-policy.md) is unique across all endpoints owned by one merchant, regardless of active status. Re-registering that normalized URL returns `409 webhook_endpoint_url_conflict`; reactivation uses `PATCH`.

### Subscriptions and processing-time eligibility

- Persist one normalized subscription row per endpoint and supported event type, with a unique endpoint/event-type constraint and restrictive endpoint ownership relation. Do not persist a JSON/array subscription source of truth.
- The initial and only accepted subscription value is `payment.created.v1`. Unknown or duplicate values fail validation. An endpoint must have at least one subscription.
- Subscription replacement is part of the endpoint aggregate update; add/remove rows, increment the aggregate version, and append audit evidence atomically.
- A future event projection creates a delivery only for endpoints that are both active and subscribed **when that event is durably processed**. Registration/reactivation/subscription after processing does not cause historical fanout. Disabling/unsubscribing before processing makes the endpoint ineligible.
- The future consumer must query eligibility through a Webhooks application/repository port in its inbox-protected transaction. Eventing and transport adapters do not query or write Webhooks tables directly.

### API contract

The canonical API surface is:

| Method  | Path                                          | Scope             | Behavior                                                    |
| ------- | --------------------------------------------- | ----------------- | ----------------------------------------------------------- |
| `POST`  | `/v1/webhook-endpoints`                       | `webhooks:manage` | Create an active endpoint and show its current secret once. |
| `GET`   | `/v1/webhook-endpoints`                       | `webhooks:read`   | Return a bounded, cursor-paginated merchant-owned list.     |
| `GET`   | `/v1/webhook-endpoints/{id}`                  | `webhooks:read`   | Return one merchant-owned endpoint without secret material. |
| `PATCH` | `/v1/webhook-endpoints/{id}`                  | `webhooks:manage` | Replace status and/or subscriptions; URL is not mutable.    |
| `POST`  | `/v1/webhook-endpoints/{id}/secret-rotations` | `webhooks:manage` | Rotate and show the new current secret once.                |

- Create accepts the URL and nonempty subscriptions. PATCH accepts only status and/or the full desired subscription set; unknown fields, including URL, are rejected.
- Secret rotation is not accepted through PATCH. GET/list responses contain safe metadata only and never ciphertext, nonce, tag, key ID, secret version internals, or plaintext secret.
- GET by ID, create, successful PATCH, and successful rotation emit a strong opaque `ETag` representing the endpoint version. Its encoding is a transport concern, not a database identifier.
- PATCH and secret rotation require exactly one valid `If-Match` precondition for the current ETag. Missing preconditions return `428 precondition_required`; stale or nonmatching preconditions return `412 precondition_failed`. A successful mutation increments the endpoint version exactly once.
- Validation, precondition, scope, conflict, and service failures use the RFC 9457 contract from ADR-0013. The exact list cursor encoding and page bounds are documented in the implementation plan/OpenAPI before coding.
- Creation, rotation, status changes, and subscription changes append the audit evidence required by [ADR-0017](0017-webhook-endpoint-lifecycle-audit.md) in the same transaction. Read/list operations do not create audit rows.

Project-owner approval accepts the public ID, routes, scopes, optimistic preconditions, immutable/unique URL, normalized subscription, and processing-time eligibility decisions above.

## Consequences

### Positive

- Tenant-safe predicates and non-storage public IDs make ownership explicit.
- ETags prevent silent lost updates and concurrent secret-rotation races.
- Immutable normalized URLs retain stable endpoint/audit identity.
- Normalized subscriptions support constraints and efficient eligibility selection.
- Processing-time eligibility is deterministic and avoids retroactive delivery creation.

### Negative

- Changing a URL requires creating a second endpoint and disabling the first.
- Clients must retain and submit ETags for mutations.
- Subscription replacement and audit append require one aggregate transaction.
- A list/read/rotation surface is larger than the two routes explicitly illustrated by the specification.

### Risks and mitigations

- **Cross-tenant disclosure:** Include merchant ownership in every predicate and test identical foreign/missing responses.
- **Lost update:** Require `If-Match` and perform version comparison/update atomically in PostgreSQL.
- **Duplicate canonical destination:** Enforce named database uniqueness on merchant plus normalized URL and map only that constraint.
- **Public-ID collision:** Use database uniqueness and no more than three total generation attempts.
- **Subscription race with event processing:** Define eligibility by the consumer transaction's database view and test concurrent status/subscription changes.
- **Secret disclosure on reads:** Construct allowlisted response DTOs and run redaction/contract tests.

## Implementation notes

- The Webhooks module owns endpoint, subscription, and secret persistence. Merchant Access supplies authenticated merchant/API-key identity and scope enforcement.
- Proposed schema/migration details, exact DTO shapes, cursor bounds, ETag encoding, and transaction/locking queries belong in the required implementation plan.
- No endpoint API, schema, migration, subscription, projection, or outbound webhook behavior is created by this ADR milestone.

## Affected requirements and invariants

- **Requirements:** FR-09 endpoint registration, inspection, status, subscription, ownership, secret lifecycle, and SSRF; FR-10 future delivery; FR-13 errors/correlation; FR-14 audit.
- **Invariants:** No financial invariant changes. Tenant ownership and duplicate-effect protections remain mandatory.
- **Acceptance:** API contract, tenant isolation, scope, uniqueness, ETag concurrency, ID collision, subscription race, one-time secret, and audit atomicity tests are required when implemented.

## Impact assessment

- **Affected modules and dependency direction:** API calls Webhooks; Webhooks uses Merchant Access context, URL/keyring infrastructure ports, and an Operations audit port. Eventing does not own endpoint data.
- **Financial invariants and money representation:** None.
- **Database schema, migration, locking, and transaction boundaries:** Future endpoint/subscription/secret tables, named constraints, aggregate version checks, and atomic audit writes are required.
- **Idempotency, outbox/inbox, retries, and partial failure:** Future projection is inbox-protected; endpoint commands use optimistic preconditions, not payment idempotency keys.
- **API, event, webhook, or CSV compatibility:** Adds a versioned `/v1` management contract and initially supports only `payment.created.v1`.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Requires `webhooks:read`/`webhooks:manage`, merchant predicates, ADR-0014 URL policy, and ADR-0015 secret policy.
- **Observability, alerting, and runbooks:** Record endpoint public ID, merchant/request ID, route, status, and stable failure code; omit destination path/query and secret material.
- **Production dependencies and supply-chain impact:** No dependency is selected here.

## Verification

- Contract-test all five routes, scopes, request/response/problem schemas, ETag behavior, list bounds, and one-time secret fields.
- Test missing/foreign endpoints, normalized URL collisions, inactive reactivation, immutable URL rejection, unsupported/duplicate/empty subscriptions, and public-ID collision exhaustion.
- Race PATCH/PATCH, PATCH/rotation, and rotation/rotation with the same ETag; prove one commit and one `412` with complete rollback.
- Race future event processing with status/subscription changes and prove the accepted processing-time eligibility rule with no historical fanout.
- Verify every endpoint query contains merchant ownership and all response/log/audit surfaces exclude secret/ciphertext and sensitive URL components.

## Rollout and recovery

Apply additive endpoint/subscription/secret/audit schema before exposing routes. Release management APIs before enabling any projection consumer or HTTP sender. On a faulty mutation path, disable writes and forward-fix; do not bypass ETags, tenant predicates, URL policy, encryption, or audit atomicity. Endpoint and audit evidence is not manually rewritten during recovery.

## Documentation and traceability

The [ADR index](README.md) records acceptance. The Webhook Endpoint implementation plan, OpenAPI, README, security controls, future projection/delivery plans, and runbooks must cite this ADR and ADRs 0014, 0015, and 0017.
