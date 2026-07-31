# ADR-0004: RabbitMQ, outbox, inbox, and message delivery

- **Status:** Accepted
- **Date:** 2026-07-31
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through the architecture-decision milestone
- **Supersedes:** None
- **Superseded by:** None

## Context

SettleFlow must publish committed domain events, process state-changing messages, deliver webhooks, and run asynchronous settlement/reconciliation work without making financial transactions depend on broker availability. A database commit and broker publish cannot form one atomic distributed transaction. Worker crashes can occur before or after publish, database commit, or acknowledgement.

The specification selects RabbitMQ, transactional outbox and consumer inbox records, publisher confirms, manual acknowledgements, leases, bounded retries, and dead-letter recovery. It explicitly rejects exactly-once claims: duplicate delivery is expected and must not create duplicate financial effects.

This ADR records the RabbitMQ part of specification baseline ADR-002 and specification baseline ADR-003. It does not change the specification.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): Executive Summary; Functional Requirements FR-07 through FR-10; Outbox relay design; Reliability model; Failure modes; Recorded baseline decisions.
- [Module boundaries](../architecture/module-boundaries.md)
- [Financial invariants](../architecture/financial-invariants.md)
- [Operational runbooks](../runbooks/README.md)

## Decision drivers

- No unsafe PostgreSQL/RabbitMQ dual write.
- Financial commands can commit while RabbitMQ is unavailable.
- At-least-once publication and consumption are explicit and recoverable.
- Duplicate messages cannot create duplicate state-changing effects.
- Broker confirms and consumer acknowledgements cover their distinct failure boundaries.
- Poison messages and exhausted retries reach auditable terminal states.
- Network calls never hold financial or outbox-claim row locks.

## Considered options

### Option A: RabbitMQ with transactional outbox, inbox, confirms, manual acknowledgements, and dead-letter recovery

Persist domain events with authoritative state, relay them after commit, deduplicate consumers in PostgreSQL, and acknowledge only after durable effects. Use RabbitMQ for routing/backpressure, not financial truth.

Selected because it matches the specification's reliability and failure model.

### Option B: Publish directly to RabbitMQ inside or after the financial transaction

Publishing inside the transaction holds database work open during network I/O and still cannot atomically commit broker and database state. Publishing after commit without an outbox can lose events when the process crashes.

Rejected as an unsafe dual-write pattern.

### Option C: Synchronous calls without a broker

This would make API success depend on webhook and downstream availability, remove durable backlog behavior, and couple failure domains.

Rejected for asynchronous delivery and worker jobs.

### Option D: Kafka or event sourcing

Kafka could provide a log-oriented transport but is not required for the v1.0 workload and would add operational scope. Event sourcing would change the authoritative persistence and replay model.

Rejected for v1.0. Neither is introduced as an optional parallel path.

### Option E: Claim exactly-once delivery

Broker redelivery and crash-after-publish-before-mark make exactly-once transport claims false without broader assumptions. Attempting to hide duplicates would weaken failure transparency.

Rejected. SettleFlow guarantees idempotent effects, not exactly-once delivery.

## Decision

- Use **RabbitMQ** for durable asynchronous routing, backpressure, retries, and dead-letter routing. PostgreSQL remains authoritative financial state.
- Every domain event that must be published is inserted into the transactional outbox in the same PostgreSQL transaction as its producing state change.
- The relay claims a bounded batch in a short PostgreSQL transaction using lease fields and `FOR UPDATE SKIP LOCKED`, commits the lease, publishes outside the transaction through a RabbitMQ confirm channel, then marks confirmed rows published.
- A crash after publish but before marking may republish the same stable event ID after lease expiry. This is intentional at-least-once behavior.
- Every state-changing consumer uses an inbox uniqueness key of consumer name plus message ID. The inbox record and domain effect commit atomically. Manual acknowledgement occurs only after commit; completed duplicates are detected, produce no second effect, and are then acknowledged.
- RabbitMQ topology uses durable exchanges/queues, explicit bindings, publisher confirms, manual acknowledgements, bounded prefetch/concurrency, bounded retry policy, and dead-letter exchanges/queues.
- Poison or exhausted messages reach a recorded dead-letter state. Replay is controlled, authorized, reasoned, observable, and audited where it can change state.
- Messages carry stable event/message ID, schema version, occurrence time, producer, correlation identifiers, and the minimum required payload. Consumers reject unsupported versions safely.
- Broker availability is never a prerequisite for committing a valid financial command.

Exact exchange, queue, routing-key, retry-delay, attempt-budget, prefetch, concurrency, confirm-timeout, and dead-letter naming values are **To be decided** in the approved Eventing implementation plan. They must not be selected implicitly in code.

## Consequences

### Positive

- Financial state and event intent are committed atomically in PostgreSQL.
- Broker outages create observable backlog rather than lost or rolled-back valid payments.
- Stable IDs and inbox uniqueness turn redelivery into one durable effect.
- Publisher and consumer failure boundaries are explicit and testable.
- Short claim transactions avoid holding locks during broker network calls.

### Negative

- Delivery can repeat, so every state-changing consumer must implement deduplication correctly.
- Outbox, inbox, leases, attempts, retries, and dead-letter state add schema and operational complexity.
- Ordering is not globally guaranteed; consumers must rely only on documented partition/aggregate rules.
- Operators need backlog/dead-letter metrics, alerts, runbooks, and audited replay controls.

### Risks and mitigations

- **Crash after publish:** Stable event ID, lease expiry, inbox deduplication, and failure-injection test.
- **Crash before acknowledgement:** Commit inbox/effect first; redelivery becomes a no-op.
- **Lease held too long:** Bounded lease and reclamation; monitor oldest/pending age.
- **Poison-message loop:** Bounded attempts, version validation, dead-letter routing, redacted diagnostics.
- **Premature acknowledgement:** Encapsulate consumer transaction/ack ordering and test it with real RabbitMQ/PostgreSQL.
- **Duplicate financial effect:** Unique business keys and idempotency/inbox constraints enforce INV-10.

## Implementation notes

- Keep outbox/inbox persistence in the Eventing module and broker code in its infrastructure adapter.
- Do not acknowledge a message in a `finally` block or before the database commit result is known.
- Confirm channels and consumer acknowledgements are separate mechanisms and both are required.
- Mark only confirmed outbox rows published; a failed or timed-out confirm remains retryable under policy.
- Do not hold outbox claim locks while publishing or waiting for confirms.
- Record retry/deduplication/backlog metrics and correlate request, event, message, delivery, and merchant IDs without logging secrets or sensitive payloads.
- Dead-letter recovery must use application/operator commands; direct queue/database manipulation is not the normal recovery path.
- No RabbitMQ configuration, queue declaration, outbox/inbox schema, or worker code is created by this ADR milestone.

## Affected requirements and invariants

- **Requirements:** FR-07 transactional outbox; FR-08 inbox deduplication; FR-09 and FR-10 webhook event/delivery behavior; FR-13 readiness/correlation; FR-14 audit of privileged replay.
- **Invariants:** INV-10 is directly protected. INV-01 through INV-09 remain within PostgreSQL and are never delegated to RabbitMQ.
- **Acceptance:** Architecture, concurrency, recovery, operations, and documentation gates require crash/outage/duplicate evidence.

## Impact assessment

- **Affected modules and dependency direction:** Eventing owns outbox/inbox; worker invokes Eventing and consumer module services; producers call the Eventing port inside their transaction.
- **Financial invariants and money representation:** RabbitMQ is not authoritative and cannot weaken ledger/payment constraints.
- **Database schema, migration, locking, and transaction boundaries:** Future outbox/inbox/lease schema is required; exact artifacts are deferred.
- **Idempotency, outbox/inbox, retries, and partial failure:** This ADR defines the baseline semantics.
- **API, event, webhook, or CSV compatibility:** Events require versioned envelopes; exact schemas are deferred to contract work.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Replay is authorized/audited; message payloads and errors remain minimal/redacted.
- **Observability, alerting, and runbooks:** Backlog age, pending count, publish failures, dedup hits, dead letters, and recovery need signals/runbooks.
- **Production dependencies and supply-chain impact:** Approves RabbitMQ and a compatible Node.js client; exact versions/digests are deferred.

## Verification

- With real PostgreSQL and RabbitMQ, prove publish-after-commit, publisher confirms, manual acknowledgements, and inbox-protected effects.
- Inject crash after publish/before mark and crash after effect commit/before acknowledgement.
- Run competing relay claims and verify disjoint active leases plus safe republish after expiry.
- Verify broker outage permits financial commit with pending outbox and changes worker readiness.
- Verify poison/unsupported messages reach dead-letter state after bounded attempts.
- Verify authorized replay is audited and no duplicate financial effect occurs.

## Rollout and recovery

This ADR creates no runtime topology. Future rollout must create topology idempotently, support backward-compatible message schemas, and deploy consumers before producers of a required new version. Recovery relies on lease expiry, retry, dead-letter inspection, and controlled replay; it never edits posted financial records.

## Documentation and traceability

Index this ADR in [the ADR register](README.md). Future Eventing, Webhooks, Settlements, Reconciliation, observability, and runbook plans must cite it.
