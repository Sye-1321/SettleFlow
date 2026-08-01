# ADR-0017: Webhook endpoint lifecycle audit

- **Status:** Accepted
- **Date:** 2026-08-01
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through Webhook Endpoint Foundation approval
- **Supersedes:** None
- **Superseded by:** None

## Context

Webhook endpoint creation, secret rotation, disablement/reactivation, and subscription changes alter where merchant event data may be sent or how that data is authenticated. The specification requires audit for credential/secret lifecycle and privileged actions, while [ADR-0013](0013-problem-details-audit-and-retention-boundaries.md) assigns append-only audit ownership to Operations and excludes ordinary reads and failed validation/authentication from durable audit.

Best-effort logs or after-commit audit writes can leave a successful endpoint mutation without durable evidence. Letting Webhooks own a second audit table would violate module ownership. The cross-module transaction contract therefore must be explicit before endpoint persistence is implemented.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): FR-09; FR-14; audit traceability; API-key and secret lifecycle security.
- [Architecture overview](../architecture/README.md)
- [Module boundaries](../architecture/module-boundaries.md)
- [Security policy](../../SECURITY.md)
- [ADR-0013](0013-problem-details-audit-and-retention-boundaries.md)
- [ADR-0015](0015-webhook-signing-secret-encryption-and-rotation.md)
- [ADR-0016](0016-webhook-endpoint-api-ownership-and-subscriptions.md)

## Decision drivers

- Never report a lifecycle mutation successful without append-only evidence.
- Preserve Operations ownership and avoid direct cross-module table writes.
- Attribute merchant-authenticated changes to the merchant and API key.
- Keep audit content useful but free of secrets and sensitive destination values.
- Make audit failure behavior and retention explicit.
- Avoid high-volume audit rows for reads and rejected requests.

## Considered options

### Option A: Operations-owned audit appended atomically with each endpoint lifecycle mutation

Webhooks calls an Operations application port within the same PostgreSQL unit of work. Endpoint mutation and audit append either both commit or both roll back.

### Option B: Emit audit asynchronously after endpoint commit

A crash or unavailable broker can leave a successful mutation without audit evidence. It is rejected for these actions.

### Option C: Write lifecycle changes only to application logs

Telemetry is mutable, retention-bounded, and not authoritative audit evidence. It is rejected.

### Option D: Add a Webhooks-owned endpoint audit table

This duplicates the Operations responsibility and fragments privileged-action evidence. It is rejected.

### Option E: Audit reads and every rejected request

This creates high-volume records and conflicts with ADR-0013's classification. Safe metrics/logs cover those attempts. It is rejected.

## Decision

The decision is **Option A**.

### Audited actions

An Operations audit record is required for each successful:

- webhook endpoint creation;
- webhook signing-secret rotation;
- endpoint status change, including deactivate and reactivate; and
- endpoint subscription-set change.

One PATCH that changes both status and subscriptions must atomically record complete evidence for both action dimensions. Whether that is one bounded combined record or two correlated records is an implementation-plan detail; neither change may be omitted. A no-op PATCH is rejected or returns without a mutation and creates no audit event; exact no-op HTTP behavior is also set in the implementation plan.

List/read requests, authentication or authorization failures, validation/precondition failures, URL/DNS rejection, database rollbacks, and other unsuccessful commands create no append-only audit record. They remain subject to safe bounded telemetry.

### Atomicity and ownership

- Operations owns the `audit_events` model, table, repository, retention policy, and append-only controls.
- Webhooks invokes a typed Operations audit port and supplies a transaction-scoped persistence context. It never writes or imports the Operations repository/table directly.
- The endpoint aggregate change, subscription/secret rows, version increment, and audit append commit in one PostgreSQL transaction. An audit validation or persistence failure rolls back the complete endpoint mutation.
- DNS resolution, URL policy checks, secret generation, and encryption occur before the short transaction. No network or cryptographic key-service call is made while database locks are held; the future production KMS adapter must preserve this boundary.
- Audit append does not publish a RabbitMQ event and is not substituted by an outbox row.

### Audit-safe record

Each record contains the minimum stable evidence required by the specification:

- actor type `merchant_api_key`, authenticated merchant ID, and internal API-key ID;
- a stable action code for endpoint creation, secret rotation, status change, or subscription change, with any combined mutation represented without losing either action dimension;
- target type `webhook_endpoint` and the public `whe_<ULID>` target ID;
- bounded system-derived reason code `merchant_api_request`;
- authoritative UTC occurrence time;
- canonical request/correlation ID; and
- safe structured change metadata limited to endpoint version and changed field names or non-sensitive enum/event-type values needed for review.

Audit content never includes the plaintext secret, ciphertext, nonce, authentication tag, encryption key ID, full or normalized URL, hostname, resolved IP addresses, authorization/API-key material, raw request body, ETag/If-Match value, or failure exception.

### Immutability and retention

- Audit records are append-only. Application paths expose insert and read/report behavior only; update/delete is restricted by database privilege/control and negative tests.
- Consistent with ADR-0013, lifecycle audit is retained indefinitely in the reference environment. No deletion, compaction, or cleanup job is authorized by this ADR.
- Correction of bad descriptive metadata uses an additional authorized corrective audit record; it does not modify the original.

Project-owner approval accepts the audited action set, same-transaction requirement, Operations ownership, safe field boundary, and retention interpretation above.

## Consequences

### Positive

- Every committed endpoint lifecycle change has durable attributable evidence.
- Audit ownership remains centralized in Operations.
- Partial success between endpoint state and audit state is impossible under the local transaction.
- Secrets, destinations, and credentials remain outside audit storage.

### Negative

- The first endpoint migration requires an Operations-owned audit foundation or coordinated migration.
- Webhooks and Operations need a transaction-aware port contract.
- Audit failure makes an otherwise valid endpoint mutation fail.
- Indefinite reference retention requires storage monitoring and a future policy decision.

### Risks and mitigations

- **Cross-module coupling:** Depend only on a narrow Operations application port and shared unit-of-work abstraction, never the table/repository implementation.
- **Audit omission:** Make the audit append mandatory in each command handler and prove rollback/failure paths in PostgreSQL integration tests.
- **Sensitive-data capture:** Allowlist fields/actions and scan database/log fixtures for secret and URL material.
- **Audit mutation/deletion:** Restrict database privileges and add negative tests; use append-only corrective records.
- **Transaction held during DNS/KMS work:** Complete external validation/encryption before beginning the database transaction.

## Implementation notes

- The endpoint implementation plan must define the exact action-code vocabulary, safe metadata schema, transaction-port interface, named constraints, and database privilege enforcement.
- The actor is the already authenticated merchant API-key principal; this ADR does not introduce user/JWT/operator authentication.
- Manual replay and delivery-attempt audit remain governed by ADR-0013 and future delivery/Operations milestones.
- This ADR milestone creates no audit schema, migration, API, endpoint, or runtime behavior.

## Affected requirements and invariants

- **Requirements:** FR-09 endpoint/secret lifecycle; FR-13 correlation; FR-14 append-only privileged audit.
- **Invariants:** No financial invariant changes. Append-only evidence and merchant tenant attribution are strengthened.
- **Acceptance:** Atomic commit/rollback, concurrent mutation, actor/target/correlation, immutability, safe-field, and retention tests are required when implemented.

## Impact assessment

- **Affected modules and dependency direction:** Webhooks calls an Operations port; Operations exclusively owns audit persistence.
- **Financial invariants and money representation:** None.
- **Database schema, migration, locking, and transaction boundaries:** Future Operations audit schema and same-transaction append are required; external work remains outside locks.
- **Idempotency, outbox/inbox, retries, and partial failure:** Audit is neither an outbox event nor eventual; retrying a rolled-back command must not duplicate committed audit.
- **API, event, webhook, or CSV compatibility:** No new endpoint beyond ADR-0016; establishes durable evidence for successful mutations.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Captures authenticated actor while excluding credentials, secrets, URL, and DNS details.
- **Observability, alerting, and runbooks:** Alert on audit-write failure rates and storage growth; diagnose with request ID and stable action/target identifiers.
- **Production dependencies and supply-chain impact:** None.

## Verification

- With PostgreSQL, prove each successful action commits exactly one complete audit record and each forced audit failure rolls back every endpoint/secret/subscription/version change.
- Prove reads and all listed failed attempts create no audit row while safe telemetry remains bounded.
- Race endpoint mutations and confirm only the ETag winner and its audit row commit.
- Verify actor, merchant, target, action, reason, time, and request ID correctness and scan for every prohibited field/value class.
- Verify application/database roles cannot update or delete audit rows and that corrective evidence is append-only.

## Rollout and recovery

Create and verify the Operations audit persistence/port before exposing endpoint mutation routes. If auditing is unavailable, mutation routes fail closed; they do not fall back to logs or asynchronous audit. Recovery uses forward fixes and additional audit records, never direct edits to endpoint or audit evidence.

## Documentation and traceability

The [ADR index](README.md) records acceptance. The Webhook Endpoint and Operations implementation plans, schema documentation, OpenAPI, security guidance, review checklist, and incident/audit runbooks must cite this ADR.
