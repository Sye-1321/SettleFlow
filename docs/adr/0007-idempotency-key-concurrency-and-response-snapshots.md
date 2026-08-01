# ADR-0007: Idempotency keys, concurrency, and response snapshots

- **Status:** Proposed
- **Date:** 2026-08-01
- **Decision owners:** SettleFlow project owner and Idempotency owner (approval pending)
- **Reviewers:** Financial/domain, database, security, and API reviewers (To be decided)
- **Supersedes:** None
- **Superseded by:** None

## Context

FR-05 and INV-10 require a duplicate money command to create no second financial effect. The specification scopes an idempotency record by merchant, method, normalized route, and key; fingerprints the canonical validated request; replays a completed response for the same fingerprint; returns 409 for a changed fingerprint; and requires recoverable in-progress ownership. It specifically warns that `INSERT ... ON CONFLICT DO NOTHING` can block on an uncommitted conflicting row that remains invisible to the command snapshot.

The Payment Intent create example includes `Idempotency-Key`, and duplicate `externalRef` handling cannot replace response replay. Although creation does not yet post ledger entries, the public create command must use the same governed mechanism so retries cannot create multiple aggregates or events.

The specification's capture workflow says to commit and then persist the HTTP response snapshot, while the architecture overview identifies the exact finalization/recovery sequence as undecided. A durable choice is required before code. This ADR proposes an atomic completion design; specification-owner approval is required to confirm it as the intended refinement.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): FR-02, FR-05; Critical workflow: capture; Idempotency concurrency model; Tables 19, 21, 23, and 24; problem example; traceability requirement for an Idempotency ADR.
- [ADR-0003](0003-postgresql-prisma-and-financial-data-access.md)
- [Financial invariants](../architecture/financial-invariants.md)
- [Module boundaries](../architecture/module-boundaries.md)
- [Payment Request plan](../plans/2026-08-01-payment-request-domain.md)

## Decision drivers

- One durable effect and one logical event under retries and races.
- Correct PostgreSQL snapshot/uniqueness behavior.
- Exact, bounded, recoverable command ownership.
- Replay without re-running domain logic or reading later-mutated state.
- Tenant isolation and no idempotency-key leakage.
- A reusable Idempotency module without cross-module table writes.

## Considered options

### Option A: Short acquisition plus atomic effect and response-snapshot completion

Acquire a committed `IN_PROGRESS` lease in a short transaction. The winning command then locks/verifies that record in the domain transaction, writes domain state, ledger/outbox where applicable, and the replayable response snapshot, marks the record `COMPLETED`, and commits everything together. A crash before commit leaves no effect; a crash after commit leaves a replayable response.

This closes the post-commit snapshot gap but requires confirmation that the specification's workflow wording permits the snapshot to be persisted before the transaction commit and returned after it.

### Option B: Persist the response snapshot in a second transaction after the domain commit

This follows the literal workflow order. It requires a durable command-result reference and a deterministic recovery procedure for a crash after the financial commit but before the response snapshot. For future mutable payment state, reconstructing the historical response from the current aggregate is unsafe unless the command transaction stores an immutable result projection.

This remains the bounded fallback if specification change control rejects Option A.

### Option C: Hold one database transaction open while waiting for duplicate callers or broker I/O

This increases lock time and couples correctness to network latency. It is rejected.

### Option D: Use only `externalRef`, in-memory locks, RabbitMQ, or a cache

These mechanisms cannot scope/fingerprint/replay the HTTP command transactionally and are not authoritative. They are rejected.

## Decision

The proposed decision is **Option A**, subject to specification-owner approval of the response-snapshot ordering.

### Scope and validation

- Require `Idempotency-Key` on every specification-defined money-mutating POST and on `POST /v1/payment-intents` as shown in the contract sample.
- Validate 1-255 characters; reject empty values, control characters, and surrounding whitespace. Never normalize an accepted value, log it, return it, or include it in telemetry.
- Scope uniqueness by authenticated `merchant_id`, uppercase HTTP method, normalized route template, and SHA-256 key digest. Query strings, raw URLs, hostnames, and path parameter values are not part of the normalized route.
- Authenticate, authorize, and strictly validate the request before acquisition or fingerprinting.
- Each command defines a versioned canonical representation of validated semantic fields. Hash the deterministic UTF-8 representation with SHA-256. Include relevant command parameters; exclude transport-only request/correlation IDs.

### Owned record and constraints

The Idempotency module owns `idempotency_keys`. The proposed durable fields are internal UUID, merchant FK, method, normalized route, 32-byte key hash, 32-byte request hash, state (`IN_PROGRESS` or `COMPLETED`), owner token, lease expiry, response status/content type/whitelisted headers/body, immutable result reference when applicable, completed time, response expiry, and created/updated times.

- Enforce unique `(merchant_id, http_method, normalized_route, key_hash)`.
- Enforce digest lengths, valid state, owner/lease presence while in progress, and response/result consistency when completed.
- Store no raw idempotency key. SHA-256 is an equality-preserving storage minimization measure, not an authentication mechanism; Merchant Access remains the security boundary.
- Use `ON DELETE RESTRICT` for merchant ownership.

### Acquisition and concurrency

- Use a reviewed, parameterized PostgreSQL `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` harmless-update pattern, or an equivalently proven acquire/read statement, inside the Idempotency adapter. Prisma does not safely express the required single-winner semantics; ADR-0003's raw-SQL exception applies.
- A new row receives a cryptographically random owner token and a proposed 30-second lease. The command transaction must start promptly, lock the idempotency row, and use bounded statement/lock timeouts shorter than the lease.
- Same scope/key with a different request hash returns `409 idempotency_key_reused` without changing ownership or executing domain logic.
- Same scope/key/hash in `COMPLETED` returns the stored result without re-running the command.
- Same scope/key/hash with an unexpired owner returns `409 idempotency_request_in_progress` and `Retry-After: 1`; the server does not hold an HTTP request open waiting for another command.
- After lease expiry, one contender atomically replaces the owner token using a conditional `UPDATE ... RETURNING`. If the original domain transaction holds the row lock, the contender waits only within the lock timeout and then observes commit/rollback before takeover.
- Deadlock or approved transient serialization retries restart the entire transaction with the same idempotency identity; partial statement retries are prohibited.

The proposed 30-second lease and one-second retry hint are operational defaults requiring database/latency review before acceptance. Any different values must be recorded in this ADR or its accepted implementation plan, not hidden in code.

### Completion and replay

- The winner's command transaction verifies the owner token, performs the complete domain effect and required ledger/outbox writes, builds a bounded replay snapshot from the committed result values, updates the idempotency record to `COMPLETED`, and commits atomically.
- Snapshot successful committed responses and deterministic terminal business outcomes reached after acquisition. Authentication/authorization/validation failures occur before acquisition. Transient dependency/transaction failures do not mark the command completed.
- Store the logical JSON/problem body, HTTP status, content type, and only explicitly approved replay-safe headers. Do not store authorization, cookies, idempotency key, raw request, secrets, or telemetry-only headers.
- `X-Request-Id` identifies each HTTP attempt and is not replayed from the snapshot. The durable result keeps its original command/event correlation separately; API documentation must distinguish attempt correlation from command identity.
- A completed replay returns the stored logical status/body and safe headers. It never reserializes current payment state, which may have changed since the original command.

### Retention

- The response replay window is configurable, never less than 24 hours, and defaults to seven days.
- After expiry, a bounded job purges response bodies/headers but retains the scope digest, request digest, state, result reference, and timestamps as a minimal tombstone needed for INV-10 and audit linkage. Reuse then returns `409 idempotency_key_expired`; it does not execute the command again.
- The owner and retention policy for tombstone deletion is **To be decided before any purge beyond response-body disposal**. No financial idempotency evidence is deleted merely to reclaim space.

If specification-owner review requires literal post-commit snapshot persistence, this ADR remains Proposed and must be revised to Option B with an immutable result record and crash-recovery algorithm before implementation.

## Consequences

### Positive

- Domain effects, outbox intent, and replay evidence cannot separate at commit.
- PostgreSQL uniqueness and row locking establish an observable single winner.
- Raw caller keys are not retained or exposed.
- A stale process can be recovered without permitting a second effect.
- The same mechanism can protect later capture/refund commands.

### Negative

- Idempotency completion participates in the domain transaction and increases its schema/locking surface.
- A pre-acquisition transaction and lease state add operational complexity.
- Response snapshots consume storage and require bounded retention jobs.
- Exact response creation must be deterministic before commit.

### Risks and mitigations

- **Specification sequence mismatch:** Require specification-owner approval before acceptance; otherwise adopt documented Option B.
- **Lease expires during a live transaction:** Lock the idempotency row in the command transaction and keep transaction timeouts below the lease.
- **Hash/canonicalization mismatch:** Version canonical forms and publish fixed test vectors.
- **Raw SQL defect:** Parameterize, isolate in the owning adapter, database-review, and race-test against real PostgreSQL.
- **Response contains sensitive data:** Whitelist fields/headers, bound size, and security-review snapshots and diagnostics.
- **Expired replay creates duplicate:** Keep a tombstone and return a stable expired-key conflict.

## Implementation notes

- Payments calls an Idempotency application port; it never imports or writes the table directly.
- The create-intent fingerprint follows the accepted body values and exact `externalRef`, base-10 `amountMinor`, uppercase currency, and `manual` capture method.
- No Redis, distributed lock, broker round trip, or in-memory ownership is introduced.
- Cleanup must use bounded batches, skip active leases, expose age/count metrics, and never be part of command success.

## Affected requirements and invariants

- **Requirements:** FR-02 and FR-05 directly; FR-03, FR-04, and later state-changing commands reuse the policy.
- **Invariants:** INV-10 directly; INV-01 through INV-09 must remain inside their authoritative PostgreSQL transactions.
- **Acceptance:** Replay, mismatch, in-progress, stale-owner, retry-storm, crash-point, and changed-key/business-key races are release-blocking.

## Impact assessment

- **Affected modules and dependency direction:** Idempotency owns records and exposes a port; API orchestrates; Payments supplies the command callback/result.
- **Financial invariants and money representation:** Canonical money fields are exact integer minor units and currency; no floating point.
- **Database schema, migration, locking, and transaction boundaries:** New unique/checked Idempotency-owned table; raw SQL acquisition; explicit lease and command transactions.
- **Idempotency, outbox/inbox, retries, and partial failure:** Defines the command-side policy; inbox remains separate message deduplication.
- **API, event, webhook, or CSV compatibility:** Adds required header, 409 conflict/in-progress/expired behavior, and stored replay semantics.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Merchant-scoped after auth; raw key/body prohibited from storage/logs except approved response fields.
- **Observability, alerting, and runbooks:** Acquisition/replay/conflict/stale lease/cleanup metrics and recovery guidance required.
- **Production dependencies and supply-chain impact:** None; uses PostgreSQL and standard cryptographic hashing already in the baseline.

## Verification

- Apply migrations from empty and current prior state; test every unique/check/FK constraint.
- Run concurrent same-key/same-hash storms and prove one effect/event plus identical replay.
- Run changed-hash, different-key/same-business-reference, cross-merchant, active-owner, and stale-owner races.
- Inject crashes before acquisition commit, before domain commit, after domain/snapshot commit, and before HTTP response.
- Verify parameterization and PostgreSQL snapshot behavior of the acquisition SQL.
- Test retention/body purge and expired-key conflict without a second effect.
- Scan logs, traces, errors, and snapshots for raw idempotency keys and prohibited data.

## Rollout and recovery

Deploy the Idempotency schema and module before exposing any protected endpoint. An unapplied migration can be reverted before data exists; after commands run, preserve records and use forward fixes. If a defect is found, disable the affected command surface while retaining payment, ledger, outbox, and idempotency evidence. Never clear a stuck row manually without an authorized, reasoned recovery command.

## Documentation and traceability

If accepted, update the [ADR index](README.md), architecture open matters, Payment Request plan, API/problem contracts, migration notes, idempotency runbook, and test evidence. Record the specification-owner decision on Option A versus Option B and the approved lease/retention values.
