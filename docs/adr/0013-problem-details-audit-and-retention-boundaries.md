# ADR-0013: Problem details, audit, and retention boundaries

- **Status:** Accepted
- **Date:** 2026-08-01
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through payment-request ADR acceptance review
- **Supersedes:** None
- **Superseded by:** None

## Context

The specification requires `application/problem+json` aligned with RFC 9457, a stable `code`, and `requestId`, but the scaffold currently returns NestJS default errors. FR-14 requires append-only audit records for privileged operational actions. The security section says to audit creation, rotation, disablement, replay, settlement execution, and reconciliation import in the context of key/secret lifecycle and privileged operations; it does not explicitly classify an ordinary merchant Payment Intent create/read as privileged.

The specification sets retention for idempotency, outbox/inbox, logs/traces, and several financial records, but does not authorize a Payment Intent delete endpoint or a payment purge policy. Error behavior, audit ownership, and retention must be bounded before exposing the domain so implementation does not leak details, invent an audit table, or delete evidence.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): FR-13; FR-14; Tables 21, 23, 24, 29, and 30; problem response example; API key and secret lifecycle; audit traceability.
- [Module boundaries](../architecture/module-boundaries.md)
- [Financial invariants](../architecture/financial-invariants.md)
- [ADR-0007](0007-idempotency-key-concurrency-and-response-snapshots.md)
- [ADR-0012](0012-payment-created-outbox-timing.md)
- [Payment Request plan](../plans/2026-08-01-payment-request-domain.md)

## Decision drivers

- Stable, machine-readable, non-leaking API errors.
- Attempt-level correlation without exposing credentials or raw bodies.
- Append-only audit only for specification-authorized privileged actions.
- Preservation of payment/idempotency/event evidence.
- Bounded storage and explicit deletion authority.
- Tenant-safe not-found and conflict behavior.

## Considered options

### Option A: Shared problem contract, privileged-only audit, conservative evidence retention

Map API failures to one RFC 9457-compatible shape, create no audit event for normal merchant create/read, and retain Payment Intents without physical deletion until an approved policy exists. Apply the specification's explicit retention windows to idempotency response bodies, terminal outbox/inbox, and telemetry.

### Option B: Audit every merchant Payment Intent request

This creates high-volume duplicate evidence, treats ordinary scoped merchant actions as privileged, and invents an Operations write not required by FR-14. It is not selected.

### Option C: Keep framework-default errors and log details for diagnosis

This produces unstable contracts and can leak database/validation/request data. It is rejected.

### Option D: Delete Payment Intents with idempotency expiry

This destroys business/event linkage and has no specification authorization. It is rejected.

## Decision

The decision is **Option A**.

### Problem-details contract

- Every API error uses `Content-Type: application/problem+json` and contains `type`, `title`, `status`, stable SettleFlow `code`, safe `detail`, and `requestId`. Optional bounded `violations` may contain only field names and stable reason codes, never rejected values or raw payloads.
- `type` uses the stable pattern `https://docs.settleflow.dev/problems/<code>` demonstrated by the specification. It identifies the problem class; it is not generated from exception text.
- Accept a caller `X-Request-Id` only when it is 1-128 characters from `[A-Za-z0-9._:-]`. Generate a high-entropy `req_` identifier when the header is absent or invalid; never echo or log an invalid value. Return the canonical request ID in `X-Request-Id` and the problem body, and propagate it to approved records/traces.
- Map only recognized domain/database conditions. Unknown exceptions become generic `500 internal_error`; PostgreSQL unavailability or exhausted approved transaction retries become `503 service_unavailable`. Never expose stack traces, SQL, constraint text, URLs, credentials, keys, or bodies.
- The Payment Intent mapping is:
  - `400 invalid_request` for malformed JSON, required command headers, or payment identifiers; wrong types/ranges; unknown fields; or missing required fields;
  - `401 unauthorized` for missing/invalid merchant credentials;
  - `403 insufficient_scope` for a valid key without the handler scope;
  - `404 payment_intent_not_found` for both missing and foreign-merchant IDs;
  - `422 unsupported_currency` or `422 unsupported_capture_method` for well-formed unsupported semantic values;
  - `409 idempotency_key_reused`, `idempotency_request_in_progress`, or `idempotency_key_expired` under ADR-0007;
  - `409 external_reference_conflict` for a different command colliding on the merchant business key;
  - `503 service_unavailable` for required database unavailability.
- Problem `detail` is stable/safe prose and is not used for client branching. Codes and documented extensions are the compatibility surface.
- Idempotent successful replay returns the stored logical response. The current HTTP attempt keeps its own `X-Request-Id`; durable command/event correlation remains separately recorded as described by ADR-0007.

### Audit interpretation

- Normal merchant-authenticated Payment Intent creation and retrieval are not FR-14 privileged operational actions and do not create `audit_events`.
- Their durable evidence is the merchant-owned Payment Intent, idempotency record/result, stable event/outbox record, and request/command/event correlation. Logs are supporting telemetry, not authoritative audit or financial state.
- Operations owns `audit_events`. Privileged API-key/secret lifecycle commands, authorized replay, settlement execution, reconciliation import, and future manual recovery record actor, action, target, reason, timestamp, and correlation ID through an Operations port.
- The word “creation” in the secret-lifecycle security paragraph is interpreted as credential/secret creation, not every Payment Intent. Project-owner approval confirms this interpretation; a later requirement to audit ordinary payment creation requires a superseding ADR and an Operations-owned design.
- Authentication failures, validation errors, reads, and ordinary merchant writes are counted/logged safely but are not append-only audit actions unless a later threat/control requirement explicitly promotes them.

### Retention boundaries

- Payment Intents and their stable public/business references have no delete endpoint and are retained indefinitely in the reference case-study environment until an approved specification policy authorizes archival/purge. No soft-delete field is added merely to imply disposal behavior.
- Idempotency response replay data follows ADR-0007: minimum 24 hours, default seven days, then response-body/header purge with a minimal INV-10/audit-link tombstone retained. Further tombstone deletion is separately decided.
- Unpublished outbox rows are never age-purged. Terminal outbox/inbox data follows the specification's 30-day baseline once Eventing defines terminal processing.
- Privileged `audit_events` are append-only and retained indefinitely in the reference environment; no purge is authorized until a specification retention policy and restricted deletion mechanism are approved.
- Logs/traces follow the 7-30 day environment baseline and contain no authorization, idempotency-key value, secret, raw financial request body, or response snapshot. Problems are not separately persisted except when an approved idempotency result requires a safe logical snapshot.
- Retention/cleanup jobs belong to their owning modules/Operations, use bounded batches, preserve referential evidence, and are never part of synchronous command success.

Project-owner approval records the code matrix, replacement of invalid caller request IDs, privileged-only audit interpretation, and conservative retention boundaries above. No destructive retention job is authorized without the later policy and restricted mechanism identified here.

## Consequences

### Positive

- Clients receive stable, documented errors without framework/database leakage.
- Cross-tenant resources remain indistinguishable from missing resources.
- Operations audit stays focused, append-only, and attributable.
- Payment, idempotency, and event evidence cannot be casually deleted.
- Telemetry retention remains bounded and non-authoritative.

### Negative

- A shared exception/request-ID layer is required before Payment Intent endpoints.
- Indefinite reference retention needs storage monitoring and a future disposal decision.
- Clients must branch on stable codes rather than framework messages.
- Caller request-ID validation is another public contract.

### Risks and mitigations

- **Sensitive detail leak:** Central allowlisted mapping, redaction tests, and no raw exception serialization.
- **Audit gap for a truly privileged action:** Explicitly classify commands at design review and require an Operations port.
- **Audit over-collection:** Do not audit ordinary merchant requests; retain bounded operational telemetry instead.
- **Unbounded evidence growth:** Monitor counts/age/storage and approve retention before any destructive job.
- **Request-ID spoof/log injection:** Strict character/length validation and structured logging.

## Implementation notes

- Replace NestJS default error bodies only in the later approved implementation and update existing Merchant Access contract tests at the same time.
- Use named domain errors and named database constraints; never branch on vendor error message text.
- Problem type documentation may be static initially, but each URI/code must remain stable once public.
- Reads do not create idempotency or audit records.
- No audit or retention schema/job is authorized by this ADR milestone itself.

## Affected requirements and invariants

- **Requirements:** FR-02, FR-05, FR-13, and FR-14.
- **Invariants:** INV-10 evidence is retained; ledger/payment invariants remain unchanged.
- **Acceptance:** Contract, redaction, tenant-isolation, audit immutability, retention, and failure tests are required where implemented.

## Impact assessment

- **Affected modules and dependency direction:** API owns transport mapping; Operations owns audit; Payments/Idempotency/Eventing expose typed outcomes/evidence through ports.
- **Financial invariants and money representation:** Problems never echo raw financial bodies; no rule changes.
- **Database schema, migration, locking, and transaction boundaries:** No Payment Intent audit write; future audit/cleanup schemas remain module-owned and restricted.
- **Idempotency, outbox/inbox, retries, and partial failure:** Defines public conflict errors and retention boundaries for replay/event evidence.
- **API, event, webhook, or CSV compatibility:** Establishes global error/request-ID compatibility; no event payload change.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Generic 401, tenant-safe 404, scoped 403, and strict redaction.
- **Observability, alerting, and runbooks:** Stable codes/request IDs support diagnostics; retention/backlog/storage signals and runbooks required.
- **Production dependencies and supply-chain impact:** None.

## Verification

- Contract-test every listed status/code/content type and exact required fields.
- Prove missing/invalid credentials are indistinguishable and missing/foreign Payment Intents return the same 404.
- Inject validation, named constraint, unknown exception, and database-outage failures; scan for SQL, stack, credential, key, and body leakage.
- Test accepted/replaced/generated request IDs and log-injection attempts.
- Prove normal create/read creates no `audit_event`, while future privileged commands require complete append-only evidence.
- Test retention jobs only when authorized: bounded batches, unpublished-event exclusion, tombstone preservation, and restricted audit deletion.

## Rollout and recovery

Introduce the shared problem/request-ID contract before Payment Intent routes and update existing API contract tests atomically. Accepted ADR-0008 records the pre-release compatibility decision. Retention changes are forward-only after evidence exists. Disable a faulty cleanup job and forward-fix; never restore space by deleting financial/audit evidence manually.

## Documentation and traceability

The [ADR index](README.md) records acceptance. Update the Payment Request plan, API problem catalog, OpenAPI, Merchant Access docs/tests, security logging classification, retention/runbooks, and future Operations plan during their affected milestones. Project-owner approval records the audit interpretation and retention boundaries.
