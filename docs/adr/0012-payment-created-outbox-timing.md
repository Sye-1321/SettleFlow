# ADR-0012: `payment.created.v1` outbox timing

- **Status:** Accepted
- **Date:** 2026-08-01
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through payment-request ADR acceptance review
- **Supersedes:** None
- **Superseded by:** None

## Context

The event catalog defines `payment.created.v1`, and Payments is the producer. FR-07 and accepted ADR-0004 require every committed domain event that must be published to be inserted into an Eventing-owned transactional outbox with its state change. However, the delivery roadmap places Payment Intent create/read in M1 and the Eventing/webhook milestone in M2. No outbox table, relay, queue, or event schema exists yet.

If creation is exposed without recording the event, later enabling an outbox publishes events only for new rows unless a historical backfill is invented. Direct RabbitMQ publication is an unsafe dual write. This ADR decides whether durable event intent is part of creation or explicitly deferred.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): event catalog; FR-02; FR-07; Critical workflow: capture; outbox relay design; reliability model; M1/M2 roadmap.
- [ADR-0004](0004-rabbitmq-outbox-inbox-and-message-delivery.md)
- [Module boundaries](../architecture/module-boundaries.md)
- [Financial invariants](../architecture/financial-invariants.md)
- [ADR-0007](0007-idempotency-key-concurrency-and-response-snapshots.md)
- [Payment Request plan](../plans/2026-08-01-payment-request-domain.md)

## Decision drivers

- Never lose a specification-defined event between database commit and publication.
- Keep RabbitMQ/network availability outside the request transaction.
- Preserve Eventing ownership of outbox persistence.
- Produce one stable logical event under retries.
- Avoid an unverifiable or lossy historical backfill.
- Keep relay/topology scope separate from minimal durable event intent.

## Considered options

### Option A: Persist creation event now; publish in the Eventing milestone

Add the minimum Eventing-owned outbox persistence/port needed by Payment Intent creation. Insert `payment.created.v1` in the same PostgreSQL transaction as the Payment Intent and completed idempotency result. Leave relay, RabbitMQ topology, consumers, inbox, webhooks, dead letters, and replay tooling to M2.

This creates a visible pending backlog but loses no event and follows ADR-0004.

### Option B: Explicitly defer the event and backfill later

Create Payment Intents without outbox rows, keep the endpoint non-public, then generate deterministic historical creation events before Eventing release. This needs a cutoff, stable event/time derivation, duplicate/backfill markers, and proof that no consumer observed an incomplete history.

This is bounded but adds a one-off recovery path not required by the specification.

### Option C: Publish directly to RabbitMQ from the API

This can lose either the state or event, makes command success depend on a network, and contradicts ADR-0004. It is rejected.

### Option D: Omit `payment.created.v1` permanently

This contradicts the event catalog and producer responsibility. It is rejected absent specification change control.

## Decision

The decision is **Option A**.

- Do not expose `POST /v1/payment-intents` until an Eventing-owned outbox persistence port and schema can atomically record `payment.created.v1`.
- The winning create transaction writes exactly one Payment Intent, exactly one stable `payment.created.v1` outbox row, and the ADR-0007 completion snapshot; all commit or roll back together.
- Payments constructs the specification-authorized event data and calls an Eventing application port with the existing transaction context. Payments never imports or writes Eventing tables directly.
- Eventing owns the outbox row, event identifier, pending/lease/publish state, retention, and future relay. No direct RabbitMQ publish occurs in the API transaction or immediately after it without the outbox.
- A same-key completed replay returns its snapshot and creates no new event. A changed fingerprint, active idempotency owner, validation failure, or external-reference loser creates no event.
- The event uses one stable ID, occurrence time, merchant ID, public payment ID, `amountMinor`, currency, and status `CREATED` as required by the catalog and integer-minor-unit API convention. This ADR fixes event timing and those minimum semantics; a versioned event contract must approve the exact envelope before implementation without reopening the atomic outbox decision.
- RabbitMQ topology, relay code, publisher confirms, consumers, inbox, webhook projection/delivery, dead-letter handling, and operator replay remain deferred to M2. Pending rows may accumulate until the relay exists, and their age/count must be inspectable in development and tests.
- Broker availability is not a prerequisite for the database commit. Existing readiness policy may report RabbitMQ down, but no creation transaction performs broker I/O.
- No historical backfill is part of the design. If project scope cannot include minimal outbox persistence, the create endpoint remains unavailable unless a superseding ADR selects Option B and approves its cutoff, backfill, and non-public-release controls before any Payment Intent row is created.

This uses accepted ADR-0004 rather than changing its delivery semantics. Project-owner approval authorizes the minimum Eventing-owned persistence port and schema in the Payment Intent implementation milestone; it does not authorize RabbitMQ delivery work.

## Consequences

### Positive

- Every created Payment Intent has durable event intent from its original transaction.
- Relay/webhook delivery can be added without fabricating historical events.
- RabbitMQ outages cannot cause a lost creation event or invalidate committed state.
- Idempotent replay cannot create duplicate logical events.

### Negative

- Payment Intent implementation crosses into minimal Eventing persistence earlier than M2.
- Pending rows accumulate until relay implementation and need inspection/retention protection.
- The Eventing schema/port and event contract must be reviewed before the create endpoint.

### Risks and mitigations

- **Outbox scope expands into messaging:** Limit M1 to schema, transaction port, and database tests; no broker topology/relay.
- **Unbounded pending backlog:** Expose counts/oldest age and document that no terminal-row purge applies before publication.
- **Event schema ambiguity:** Define and approve a versioned envelope and contract tests before the create endpoint is implemented; the payload uses `amountMinor` and the minimum semantics fixed above.
- **Cross-module write:** Eventing adapter owns persistence; Payments calls a port in the shared transaction.
- **Duplicate event:** Stable event ID plus idempotency and unique outbox constraints; race/failure tests.

## Implementation notes

- The outbox design must remain compatible with ADR-0004's later lease/attempt/publication fields and 30-day terminal retention.
- Creation outbox rows remain pending indefinitely until published; never purge an unpublished event because of age alone.
- Store only the minimum event payload. Exclude API keys, idempotency keys, authorization data, `externalRef`, raw request bodies, and provider data.
- Event persistence is database-local; it does not change API readiness or graceful shutdown connection ownership.

## Affected requirements and invariants

- **Requirements:** FR-02 and FR-07 directly; FR-09 later consumes the committed event.
- **Invariants:** INV-10 prevents a second event under duplicate commands; financial atomicity rules remain unchanged.
- **Acceptance:** Atomic commit/rollback, replay/no-duplicate, broker-outage, pending-backlog, and future relay tests are required.

## Impact assessment

- **Affected modules and dependency direction:** Payments -> Eventing port inside one database transaction; Eventing owns outbox persistence and future worker behavior.
- **Financial invariants and money representation:** Event money uses exact integer minor units/currency; no ledger effect occurs on creation.
- **Database schema, migration, locking, and transaction boundaries:** Requires a minimal Eventing-owned outbox schema before create; one shared transaction.
- **Idempotency, outbox/inbox, retries, and partial failure:** Creation event and completed response are single-winner; relay remains at-least-once.
- **API, event, webhook, or CSV compatibility:** Defines event timing; exact versioned payload remains a pre-code contract gate.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Minimal payload and merchant identity only; no secret/untrusted destination involved.
- **Observability, alerting, and runbooks:** Pending count/oldest age and transaction failures require signals; relay alerts wait for M2.
- **Production dependencies and supply-chain impact:** None beyond accepted PostgreSQL/RabbitMQ baseline; no RabbitMQ client use is introduced by persistence alone.

## Verification

- Prove Payment Intent, outbox row, and idempotency completion commit or roll back together in real PostgreSQL.
- Run same-key and different-key duplicate races and assert one event ID/row.
- Inject failures before/after each insert/update and before commit.
- Verify RabbitMQ unavailable causes no direct publish attempt and cannot split database state.
- Validate the versioned event schema and prohibited-field scan.
- Apply migrations from empty/current prior state and prove module dependency/write boundaries.

## Rollout and recovery

Deploy the Eventing schema/port before the create endpoint. Pending rows are valid recoverable backlog, not a rollback reason. If creation must be disabled, retain payment/idempotency/outbox evidence and forward-fix. Never delete and regenerate events with new IDs; controlled repair preserves the original logical event identity.

## Documentation and traceability

The [ADR index](README.md) records acceptance and the earlier minimum Eventing persistence scope. Update the Payment Request plan, Eventing architecture/plan, versioned event contract, migration notes, pending-backlog runbook, and tests during implementation.
