# Implementation Plan: Transactional outbox relay for `payment.created.v1`

- **Status:** Approved
- **Owner:** SettleFlow maintainers
- **Created:** 2026-08-01
- **Last updated:** 2026-08-01
- **Related issue/PR:** None
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0004](../adr/0004-rabbitmq-outbox-inbox-and-message-delivery.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md), [ADR-0012](../adr/0012-payment-created-outbox-timing.md), and [ADR-0013](../adr/0013-problem-details-audit-and-retention-boundaries.md)

## Goal

Reliably relay every committed `payment.created.v1` outbox event from authoritative PostgreSQL state to RabbitMQ. The worker must safely claim competing batches, publish outside database transactions through a confirmed and routable channel, and mark only confirmed events published. Broker or process failure may cause the same stable event to be published again, but it must never cause an event to be silently discarded or falsely marked published.

The slice is successful when real PostgreSQL/RabbitMQ tests prove disjoint claims, confirmation-before-marking, broker-outage recovery, lease reclamation, mandatory-return handling, and the intentional crash-after-publish duplicate with the same event ID.

### Non-goals

- Payment authorization, capture, void, refunds, ledger postings, balances, settlement eligibility, settlement processing, or reconciliation.
- New or changed HTTP endpoints, Payment Intent behavior, OpenAPI paths, or synchronous RabbitMQ publication from the API.
- A RabbitMQ business-event consumer, consumer inbox, webhook projection/delivery, manual acknowledgement handler, retry consumer, or operator replay command.
- Prometheus-compatible metrics, dashboards, or a telemetry backend. Those remain deferred to the Operations/observability milestone.
- Durable per-attempt error columns, an outbox terminal-failure column, retention deletion, archival, or purging unpublished events.
- Claiming exactly-once transport, global event ordering, or a guarantee that a broker confirmation represents a completed consumer effect.

## Specification traceability

- **Sections:** Executive Summary; Design principles; Domain events; Functional Requirements; Architecture and Technical Design; Outbox relay design; Data Architecture and Integrity Controls; Reliability and Operational Design; Verification and Quality Strategy; Delivery and Repository Plan.
- **Requirement IDs:** FR-07 directly; FR-13 for worker readiness, correlation, and operational signals. FR-08 consumer inbox and acknowledgement behavior remains deferred until a state-changing consumer exists.
- **Invariant IDs:** INV-10 directly. INV-01 through INV-09 remain authoritative in PostgreSQL and are unaffected by transport.
- **Acceptance/release gates:** outbox publish lag p95 below 10 seconds while RabbitMQ is healthy; real PostgreSQL/RabbitMQ integration coverage; competing relay race; broker-outage recovery; crash after publish/before mark; versioned event-schema validation; clean build, documentation, and recovery guidance.

FR-07 requires an event to exist only with committed state, permits duplicates, and requires failed publication to retry. The specification and ADR-0004 require a short lease transaction using `FOR UPDATE SKIP LOCKED`, broker I/O after commit, publisher confirms, durable topology, and explicit at-least-once behavior. ADR-0012 fixes the creation-event timing and approved nine-field contract. This plan resolves the exact topology and runtime values that ADR-0004 delegated to the Eventing implementation plan; it does not change the specification or an accepted ADR.

## Existing behavior

- The repository baseline is clean at commit `e3aa2e7`, which implements the M1 Payment Intent create/read API.
- `POST /v1/payment-intents` already commits one Payment Intent, one completed idempotency response snapshot, and one `payment.created.v1` outbox row atomically. It performs no RabbitMQ network call.
- `packages/modules/eventing` owns the creation-event contract, `EventingService`, and `PrismaOutboxRepository`. The approved payload contains exactly `eventId`, `eventType`, `occurredAt`, `requestId`, `merchantId`, `paymentId`, `amountMinor`, `currency`, and `status`.
- `outbox_events` already contains `available_at`, `attempt_count`, `locked_by`, `locked_at`, `lease_expires_at`, and `published_at`. Named constraints enforce event identifiers, the only currently supported event type, lease/publish consistency, and the exact payload contract.
- The partial `outbox_events_pending_available_at_idx` index covers `(available_at, id) WHERE published_at IS NULL`. It was created for the future availability-ordered relay claim path.
- The worker is a standalone Nest application context. It currently performs internal PostgreSQL/RabbitMQ readiness checks on bootstrap and heartbeat, reports process-only liveness, and closes `DependencyConnections` plus the singleton `PrismaDatabase` during shutdown. It does not claim or publish events.
- `compose.yaml` provides pinned PostgreSQL 18.4 and RabbitMQ 4.3.4 Management services, persistent named volumes, loopback ports, and health checks. RabbitMQ uses the configured environment-specific vhost.
- Exact `amqplib@2.0.1` is already installed in Infrastructure for readiness and supplies promise-based confirm channels, publisher callbacks, `waitForConfirms`, mandatory-return events, channel backpressure, and connection/channel lifecycle events. No new external production dependency is required.
- Existing Testcontainers 12.0.4 packages provide disposable real PostgreSQL and RabbitMQ services. The Jest configuration already includes Eventing unit tests and all `test/integration/**/*.int-spec.ts` files.
- The completed [Payment Request plan](2026-08-01-payment-request-domain.md) deliberately deferred relay/topology work while fixing the durable event contract and requiring pending rows never to be age-purged.

Evidence inspected includes `AGENTS.md`, `PLANS.md`, `CONTRIBUTING.md`, the complete specification including Word tables, architecture/module-boundary and financial-invariant documents, ADR-0001 through ADR-0013 as relevant, the complete Payment Request plan, Prisma schema and M1 migration, Eventing implementation/tests, worker bootstrap/configuration/readiness/shutdown, package scripts and manifests, Compose, readiness integration tests, README, and the installed `amqplib@2.0.1` declarations/runtime.

## Proposed design

### Approved topology

Topology is asserted idempotently through the worker's confirm channel before any row is claimed. The RabbitMQ vhost provides environment isolation; names do not contain environment suffixes.

| Element                 | Approved value and properties                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Domain exchange         | `settleflow.domain-events`; durable, non-auto-delete topic exchange                                          |
| Routing key             | `payment.created.v1`                                                                                         |
| Consumer queue          | `settleflow.webhook-projection.payment-created.v1`; durable, non-exclusive, non-auto-delete quorum queue     |
| Dead-letter exchange    | `settleflow.dead-letter`; durable, non-auto-delete topic exchange                                            |
| Dead-letter routing key | `settleflow.webhook-projection.payment-created.v1`                                                           |
| Dead-letter queue       | `settleflow.webhook-projection.payment-created.v1.dlq`; durable, non-exclusive, non-auto-delete quorum queue |

The consumer queue binds to `settleflow.domain-events` with `payment.created.v1`. It declares `x-queue-type=quorum`, `x-dead-letter-exchange=settleflow.dead-letter`, and `x-dead-letter-routing-key=settleflow.webhook-projection.payment-created.v1`. The dead-letter queue binds to `settleflow.dead-letter` with that dead-letter routing key.

The queue is consumer-specific so a later Webhook projection and any other future consumer can receive independent copies rather than compete on a shared domain-event queue. It is approved for this queue to retain messages until the Webhook projection consumer milestone. This relay slice creates no consumer and does not acknowledge, reject, or mutate queued messages in production.

The worker declares topology in application code rather than a Compose definitions file so local Compose, Testcontainers, and production-like environments exercise one contract. An inequivalent existing declaration closes the channel, makes the worker not ready, and prevents claims; the worker must not delete or recreate a non-empty topology automatically.

### Approved event and AMQP contract

The UTF-8 JSON body is the existing flat nine-field event, serialized from validated outbox data in this fixed property order:

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

The relay neither adds to nor removes from the body. It defensively validates the exact field set and cross-checks duplicated outbox columns before publication. It never publishes API keys, authorization values, idempotency keys, `externalRef`, raw request/response bodies, response snapshots, internal Payment Intent UUIDs, provider data, or settlement state.

| AMQP property/header           | Approved value                                                |
| ------------------------------ | ------------------------------------------------------------- |
| `messageId`                    | Stable body `eventId`; identical across every retry/republish |
| `type`                         | `payment.created.v1`                                          |
| `correlationId`                | Original body `requestId`                                     |
| `contentType`                  | `application/json`                                            |
| `contentEncoding`              | `utf-8`                                                       |
| `persistent`                   | `true` / delivery mode 2                                      |
| `timestamp`                    | `occurredAt` expressed as epoch seconds                       |
| `appId`                        | `settleflow-worker`                                           |
| `x-settleflow-schema-version`  | Integer `1`                                                   |
| `x-settleflow-aggregate-type`  | `payment_intent`                                              |
| `x-settleflow-aggregate-id`    | Public `paymentId`                                            |
| `x-settleflow-merchant-id`     | Merchant UUID                                                 |
| `x-settleflow-publish-attempt` | Current outbox `attempt_count`                                |

Future consumers deduplicate with `(consumer_name, messageId)` and must not treat a RabbitMQ delivery tag, publish attempt, or correlation ID as the logical message identity. The version remains in `eventType` and the schema-version header; there is no new body version field or wrapper. No global ordering promise is introduced.

### Approved operating values

| Setting                        |              Approved default |
| ------------------------------ | ----------------------------: |
| Claim batch size               |                            50 |
| Idle poll interval             |                        500 ms |
| Lease duration                 |                    30 seconds |
| Publisher-confirm timeout      |                     5 seconds |
| Transient retry base           |                      1 second |
| Transient retry cap            |                    60 seconds |
| Shutdown drain timeout         |                    10 seconds |
| Relay loops per worker process |      One non-overlapping loop |
| Maximum in-flight publications | The claimed batch, at most 50 |

Full-jitter retry delay is computed with an injected random source as `uniform(0, min(60 seconds, 1 second * 2^(attemptCount - 1)))`. Total transient retry attempts are unlimited. Each attempt and wait is bounded, but no required event is silently discarded after an arbitrary attempt budget.

### Claim, publish, and finalization flow

1. Establish a RabbitMQ connection and confirm channel within the existing bounded connection/readiness behavior.
2. Assert the complete approved topology and mark the publisher ready only after every assertion and binding succeeds.
3. When the publisher and PostgreSQL are ready, begin a short Read Committed PostgreSQL transaction in the Eventing-owned repository.
4. Select at most 50 rows where `published_at IS NULL`, `available_at <= clock_timestamp()`, and the lease is absent or expired. Order by `available_at, id` and lock through reviewed parameterized `FOR UPDATE SKIP LOCKED` SQL.
5. In the same claim transaction, set a unique process-scoped `locked_by`, database-clock `locked_at`, `lease_expires_at = locked_at + 30 seconds`, increment `attempt_count`, and return the complete claimed records. Commit before RabbitMQ I/O.
6. Validate and serialize every claimed event. Publish outside PostgreSQL through the confirm channel with routing key `payment.created.v1`, `mandatory: true`, persistent delivery, and the approved AMQP metadata.
7. Respect channel backpressure: a false publish return pauses additional writes until `drain`; it is not itself a negative broker confirmation.
8. Track each message's confirm callback, mandatory return, channel failure, and five-second timeout independently. A broker acknowledgement is successful only if no mandatory return occurred for that message.
9. Partition the batch into confirmed/routed and retryable results. A partial batch must finalize its confirmed subset without falsely marking failures.
10. In a second short Eventing-owned PostgreSQL transaction, condition every update on row ID, `published_at IS NULL`, and the exact process `locked_by` value:
    - confirmed/routed: set database-clock `published_at`, clear all three lease fields, and update `updated_at`;
    - failed/timed-out/nacked/returned: set `available_at` to the calculated retry time, clear all three lease fields, and update `updated_at`.
11. A zero-row finalization means ownership was lost or the row was already finalized. Record a safe operational signal and do not overwrite the new owner or published state.
12. Continue immediately when a batch is full or backlog remains; use the approved 500 ms idle poll when no due row exists.

A process-scoped worker identifier uses a non-secret random identifier that fits `locked_by` and is unique per process lifetime. Database time, not application time, determines due rows, lease expiry, and publication timestamps. The relay does not renew leases: the five-second confirm timeout, bounded batch, and 30-second lease provide the approved safety margin. If measurement disproves that margin, implementation stops for concurrency-plan review rather than silently adding renewal behavior.

### Rejected alternatives

- Publish inside the Payment Intent transaction or directly from the API: unsafe database/broker dual write and prohibited network work in a financial transaction.
- Hold row locks while waiting for RabbitMQ: increases contention and contradicts the specification.
- Mark published before confirmation or after confirmation without checking mandatory returns: can lose unrouted events.
- Use a shared queue for unrelated future consumers: causes consumers to compete instead of receiving independent domain-event copies.
- Generate a new event ID for retry: defeats consumer deduplication and audit correlation.
- Stop after a finite number of transient publisher attempts: can permanently lose required event delivery.
- Delete, mutate, or regenerate an unpublished row to recover: destroys authoritative event intent and stable identity.
- Add a consumer/inbox merely to drain the approved queue: expands beyond this relay milestone.

## Affected modules and files

| Module/file area                                                         | Ownership or change                                                                    | Boundary impact                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `docs/plans/2026-08-01-transactional-outbox-relay.md`                    | Living approved execution record                                                       | Governs this Eventing/worker slice                   |
| `packages/modules/eventing/package.json`                                 | Declare direct exact use of existing `amqplib@2.0.1`                                   | No new external version or module direction          |
| `packages/modules/eventing/src/outbox-relay.types.ts`                    | Claimed-event, repository, publisher, outcome, and signal ports                        | Eventing owns relay semantics                        |
| `packages/modules/eventing/src/outbox-relay.service.ts`                  | Claim/publish/finalize orchestration                                                   | Contains no Payment or worker-entrypoint rules       |
| `packages/modules/eventing/src/prisma-outbox-relay.repository.ts`        | Reviewed parameterized claim/finalize SQL                                              | Writes only Eventing-owned `outbox_events`           |
| `packages/modules/eventing/src/rabbitmq-outbox.publisher.ts`             | Confirm connection/channel, topology, serialization, returns, and backpressure adapter | RabbitMQ remains non-authoritative infrastructure    |
| `packages/modules/eventing/src/payment-created-event.contract.ts`        | Defensive validation and fixed UTF-8 serialization                                     | Preserves the approved event contract                |
| `packages/modules/eventing/src/index.ts`                                 | Export stable Eventing application/adapter APIs                                        | Worker imports Eventing's public surface only        |
| Eventing unit specifications                                             | Contract, backoff, confirmation, partial failure, and service orchestration            | Fakes do not replace real dependency proof           |
| `apps/worker/package.json`                                               | Add `@settleflow/eventing` workspace dependency                                        | Entrypoint composes Eventing application services    |
| `apps/worker/src/config/environment.ts` and `.env.example`               | Safe validated relay defaults                                                          | No secrets or topology drift through unchecked input |
| `apps/worker/src/worker.module.ts`                                       | Compose Prisma repository, publisher, relay, and runtime                               | No direct table mutation from worker code            |
| `apps/worker/src/runtime/worker-runtime.service.ts`                      | Run one loop and coordinate readiness/shutdown                                         | Entrypoint remains orchestration-only                |
| Worker health/runtime specifications                                     | Actual publisher readiness and graceful-stop behavior                                  | Preserves process-specific health semantics          |
| Root `package.json` and `pnpm-lock.yaml`                                 | Build Eventing before worker and record workspace edges                                | One lockfile; no version upgrade                     |
| `test/integration/outbox-relay.int-spec.ts`                              | Real PostgreSQL/RabbitMQ relay, race, and recovery proof                               | Testcontainers owns disposable dependencies          |
| `docs/events/payment-created.v1.schema.json` and `docs/events/README.md` | Versioned body/AMQP compatibility contract                                             | No OpenAPI change                                    |
| `docs/runbooks/outbox-backlog.md` and runbook index                      | Safe inspection and recovery guidance                                                  | Prohibits direct event/data mutation                 |
| Root and package READMEs                                                 | Commands, topology, guarantees, and limitations                                        | Documents at-least-once behavior                     |

`packages/modules/eventing` already depends on Infrastructure for the lifecycle-managed Prisma client and transaction type. The worker adds the permitted `worker -> Eventing application service` direction. Eventing does not import Payments or write Payment-owned tables. No reverse dependency or direct cross-module write is introduced.

## API and integration impact

- **REST/OpenAPI:** None. No endpoint, status, error, request, response, or OpenAPI artifact changes.
- **Synchronous behavior:** Payment Intent create success remains independent of RabbitMQ. The API records event intent in PostgreSQL and never waits for relay or consumer completion.
- **Event body:** No change to the approved nine-field `payment.created.v1` contract.
- **RabbitMQ:** Introduces the approved durable exchanges, quorum queues, bindings, AMQP properties, confirm publication, and mandatory-return handling.
- **Delivery guarantee:** At least once. `published_at` means RabbitMQ confirmed a persistent message that was routed to the durable queue; it does not mean a consumer processed it.
- **Consumer/inbox/manual acknowledgement:** None in this slice. The queue intentionally accumulates until the future Webhook projection consumer is authorized.
- **Webhook/CSV:** None.
- **Compatibility:** The relay supports only the schema-constrained `payment.created.v1`. A future event type requires compatible schema, relay, topology, and consumer rollout sequencing before producers can emit it.

## Database and migration impact

No Prisma schema change or migration is planned. The existing `outbox_events` columns, named constraints, ownership foreign key, exact payload check, lease/publish consistency checks, and pending partial index are sufficient.

The claim and conditional finalization require reviewed parameterized raw SQL under ADR-0003 because Prisma cannot express `FOR UPDATE SKIP LOCKED` claim/update semantics precisely. SQL remains in the Eventing persistence adapter, binds all values, uses the existing singleton Prisma client, and never interpolates identifiers or payload values.

Implementation must capture `EXPLAIN (ANALYZE, BUFFERS)` for the due-pending claim against a representative mix of published, leased, future, and due rows. If the existing index does not support the measured query, implementation pauses and updates this plan before any schema/migration change. It must not edit the committed M1 migration or add an unreviewed index.

There is no data backfill: all M1 Payment Intents already have durable outbox rows. Unpublished rows are valid backlog. Published and queued records remain compatible while API and worker deploy independently. No retention job may delete unpublished rows; terminal outbox retention remains deferred.

## Transaction boundaries and concurrency

### Claim transaction

- Isolation: PostgreSQL Read Committed.
- Ownership: Eventing repository only.
- Locks: at most 50 due rows through `FOR UPDATE SKIP LOCKED`.
- Writes: process owner, database lock time, 30-second lease expiry, incremented attempt count.
- End: commit before validation serialization or broker work.
- Network calls: none.

### Publish phase

- No PostgreSQL transaction or row lock is held.
- At most 50 messages are pending confirmation.
- Confirm, mandatory return, channel backpressure, connection failure, and five-second timeout are evaluated per event.
- A duplicate is possible if the process loses the database or crashes after broker confirmation.

### Finalization transaction

- Isolation: PostgreSQL Read Committed.
- Locks/writes: only claimed Eventing rows still owned by the exact `locked_by` value.
- Confirmed rows receive `published_at` and lose the lease.
- Failed rows receive their full-jitter `available_at` and lose the lease.
- A lost-owner update affects zero rows and is never forced.

Two worker processes may run concurrently. Active claims are disjoint because PostgreSQL locks and `SKIP LOCKED` choose separate rows. An expired lease can be reclaimed, and the original owner can no longer finalize it after `locked_by` changes. Exactly-once publication is not claimed: if publish succeeds but marking fails, the stable event may be published again after lease expiry.

The relay does not retry serialization/deadlock errors inside an open transaction. An approved transient database error rolls back the entire short transaction and retries from the next loop with bounded jitter; no partial claim/finalization is retained. Lock/statement timeouts remain bounded according to the existing database-operation conventions and must be shorter than the lease.

## Security and privacy

- RabbitMQ credentials remain in the existing ignored environment configuration and are never logged or included in topology names, payloads, errors, examples, or telemetry.
- Use the configured vhost and a least-privilege worker credential permitted to declare/use only the approved exchanges and queues in production-like guidance.
- Validate the outbox payload and its duplicated columns before serialization. Reject extra fields, unexpected types, unsupported event versions, unsafe amounts, and identity mismatches without logging the payload.
- Structured signals may include service, safe worker ID, event ID, event type, merchant ID, aggregate ID, attempt count, duration, routing key, and stable result/error code. They exclude authorization, API keys, RabbitMQ URLs, idempotency-key values, `externalRef`, request/response bodies, response snapshots, credentials, SQL, and stack traces in public/operator-facing output.
- AMQP metadata repeats only non-secret identifiers already authorized in the event body. The retry-attempt header is diagnostic and never an authorization or deduplication input.
- Automatic relay is not a privileged FR-14 operator action and creates no `audit_event`. Future manual replay/dead-letter recovery remains separately authenticated, reasoned, and audited.
- No merchant-controlled destination, webhook URL, signing secret, or SSRF boundary is introduced.
- Test queues, merchants, events, and credentials are synthetic and isolated in disposable Testcontainers resources.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario              | Expected safe state                                        | Retry/recovery                                                                                | Evidence                              |
| ------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| RabbitMQ unavailable before claim          | Row remains pending and unleased; worker not ready         | Reconnect with capped full jitter; claim only after topology is healthy                       | Real outage/restart test              |
| PostgreSQL unavailable before claim        | No lease or publication; worker not ready                  | Retry the whole claim loop after connectivity returns                                         | Real dependency test                  |
| Competing relay instances                  | Active leases are disjoint                                 | Each publishes only its returned claim set                                                    | Two-relay race test                   |
| Process crashes after claim/before publish | Leased row remains unpublished                             | Another process reclaims after 30-second expiry                                               | Lease-expiry test                     |
| Connection/channel closes during publish   | No unconfirmed row is marked published                     | Clear/release when possible, otherwise lease expiry; reconnect and retry                      | Channel-close integration test        |
| Broker nacks a publish                     | Row remains unpublished                                    | Full-jitter retry with the same event/message ID                                              | Publisher test plus real failure seam |
| Confirm exceeds five seconds               | Outcome is treated as unknown, never success               | Close/discard channel; retry after release/lease expiry; duplicate is acceptable              | Timeout test                          |
| Mandatory publish is returned unroutable   | Broker confirm does not count as success                   | Keep unpublished, signal topology/routing failure, retry after topology recovery              | Unbind/return integration test        |
| Partial batch confirmation                 | Only confirmed and routed subset may be finalized          | Failed subset receives retry scheduling                                                       | Mixed-result unit/integration test    |
| Crash after publish/before mark            | Broker may contain the event while row remains leased      | Lease expires; same stable `messageId` is republished                                         | Required crash-injection test         |
| PostgreSQL fails after confirm             | Confirmed broker copy may exist; row is not falsely marked | Reclaim/republish after database recovery                                                     | Combined dependency-failure test      |
| Lease expires before original finalization | New owner may reclaim; old owner update affects zero rows  | Preserve new owner; tolerate duplicate                                                        | Ownership-loss race test              |
| Payload violates runtime contract          | Row remains unpublished and retained                       | Capped retry/incident signal; forward-fix code/data invariant without new ID                  | Contract-negative test                |
| Topology declaration conflicts             | Channel closes; no claim; worker not ready                 | Operator compares definitions and deploys a compatible forward fix; never auto-delete queue   | Topology mismatch test/runbook        |
| Worker receives shutdown                   | No new claims after stopping begins                        | Drain current work for at most 10 seconds, then close; unresolved rows recover through leases | Runtime shutdown test                 |
| Future consumer is absent                  | Published messages accumulate in durable quorum queue      | Accepted until Webhook projection milestone; monitor queue/backlog and disk                   | Queue-depth inspection test/runbook   |

Transient publication retries are unlimited with a full-jitter delay capped at 60 seconds. No failed, unknown, or invalid event is marked published, deleted, regenerated, or silently discarded. Broker DLX/DLQ topology is created and tested, but production dead-lettering begins only when a future consumer explicitly rejects/nacks messages according to its approved retry policy.

## Observability and operations

Prometheus metrics and durable per-attempt failure columns are explicitly deferred. This slice provides bounded structured signals, readiness, existing attempt/lease/publication state, read-only backlog queries, and an outbox runbook.

Required structured events include:

- `outbox.relay.started` and `outbox.relay.stopping`;
- `outbox.topology.ready` and `outbox.topology.failed`;
- `outbox.claim.completed` with claimed count and duration;
- `outbox.publish.confirmed`, `outbox.publish.retry_scheduled`, and `outbox.publish.returned`;
- `outbox.finalize.completed` and `outbox.finalize.ownership_lost`;
- `outbox.relay.dependency_unavailable` with only the dependency class and stable code.

Logs use stable codes and bounded safe identifiers, never raw payloads, connection URLs, credentials, keys, or arbitrary broker/database exception text. Event IDs, request IDs, merchant IDs, and payment IDs may be used as structured log fields but never as future metric labels.

Worker liveness remains process-only. Readiness requires:

- valid configuration;
- reachable PostgreSQL through the singleton Prisma lifecycle;
- a live publisher connection and confirm channel;
- successful declaration of the complete approved topology;
- worker lifecycle state `running`.

Backlog inspection reports pending count, oldest unpublished age, due rows, active/expired leases, and attempt-count distribution without exposing payloads. The runbook covers broker outage, topology mismatch, stuck/expired leases, returned messages, confirm timeouts, queue growth, and catch-up verification. It prohibits direct row edits, resetting `published_at`, changing event IDs/payloads, deleting queues with messages, purging unpublished rows, or manually patching financial state.

## Test strategy

- **Unit:** exact nine-field fixed-order UTF-8 serialization; AMQP properties/headers; prohibited/extra field rejection; stable event ID across retry; full-jitter boundary vectors with injected randomness; publisher confirm/nack/return/timeout/backpressure; partial-result partitioning; no overlapping relay loop; graceful shutdown ordering.
- **Database constraints/migrations:** no new migration; re-run Prisma validation/generation and committed migration status. Real PostgreSQL repository tests prove due ordering, batch limit, active-lease exclusion, expired-lease reclaim, attempt increment, owner-conditional success/failure finalization, lease clearing, and zero-row lost-owner behavior. Capture the pending-claim query plan.
- **Integration with real dependencies:** Testcontainers PostgreSQL 18.4 and RabbitMQ 4.3.4 prove idempotent topology, exact confirmed message, published marking, broker outage/catch-up, mandatory return, connection loss, database loss after confirm, and clean resource shutdown.
- **Contract:** validate `payment.created.v1` examples against the committed versioned JSON schema; assert exact body fields, exact routing key, consumer-ready message properties, JSON-safe integer amount, uppercase currency/status, and prohibited-field scan.
- **Concurrency/race:** two relay instances over one backlog produce disjoint active leases; normal operation publishes each logical event once; expired-lease and ownership-loss races remain safe; crash-after-publish demonstrates an allowed duplicate with the same `messageId`.
- **Failure injection/recovery:** deterministic seams at after-claim, before-publish, after-confirm, before-mark, partial-confirm, and shutdown-timeout points. Verify no unknown outcome becomes `published_at` and every unpublished event remains reclaimable.
- **Security:** scan structured signals/message content for credentials, authorization, idempotency keys, `externalRef`, raw bodies, snapshots, and connection URLs. Test topology/payload errors are redacted.
- **Performance:** drain a representative backlog and record publish-lag distribution while the broker is healthy. Pass condition is specification p95 below 10 seconds in the documented reference environment; correctness gates remain blocking if the target is missed.
- **Documentation/link checks:** event schema/example drift, README/runbook commands, local Markdown links, Prettier, `git diff --check`, complete diff inspection, and final status.

Expected repository verification commands after implementation:

```shell
pnpm install --frozen-lockfile
pnpm prisma:validate
pnpm prisma:generate
pnpm db:migrate:status
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
git diff --check
git status --short --branch --untracked-files=all
```

`pnpm test` must include the Eventing and worker unit suites. `pnpm test:integration` must run the real PostgreSQL/RabbitMQ relay scenarios; an in-memory broker/database cannot satisfy the gate. Event-schema validation may use a focused repository script if implementation adds one; until then, the exact script is **To be defined during implementation** and recorded here before the plan can become Complete.

## Documentation impact

- Add a versioned `payment.created.v1` event schema and event-routing/compatibility guide.
- Add an outbox backlog and relay recovery runbook and index it.
- Update root/package READMEs with the worker's new responsibility, topology, tuning defaults, Testcontainers commands, at-least-once limitation, and intentional queue accumulation.
- Update this plan throughout implementation with query-plan evidence, test commands/results, deviations, and final status.
- No OpenAPI, Payment Intent API, ADR, financial invariant, Compose, contribution, or security-policy change is expected. A discovered contradiction must stop implementation and follow governance rather than being hidden in documentation.

## Rollback or forward-recovery strategy

The proposed implementation is application/topology-only and introduces no schema migration. Before publication, worker wiring can be reverted. After messages exist, safe rollback means stop or scale the relay to zero and leave PostgreSQL outbox rows plus durable RabbitMQ queues intact; it does not mean deleting topology or data.

If relay code is faulty, mark the worker unready, stop new claims, allow active leases to expire, preserve confirmed messages and outbox evidence, and deploy a forward fix. Never clear `published_at` to force replay, change an event ID, delete/regenerate an event, purge a queue, or edit a Payment Intent. If a confirmed event is republished during recovery, its stable `messageId` supports the future inbox deduplication guarantee.

Topology changes after messages exist use additive/compatible rollout: declare new consumer topology, deploy compatible consumers, then change bindings/producers under a separately reviewed plan. Do not redeclare an existing queue with incompatible arguments or automatically delete it. Terminal retention remains disabled until an approved bounded policy exists.

## Risks and assumptions

| Risk or assumption                                             | Impact                                              | Mitigation/validation                                                                               | Owner/deadline                                  |
| -------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Confirmed publish followed by crash/database failure           | Duplicate broker delivery                           | Stable event/message ID, lease recovery, required crash test, future inbox dedupe                   | Eventing owner / before merge                   |
| Mandatory return races with publisher confirmation             | Unrouted event could be falsely marked              | Correlate return by message ID and require confirmed plus not returned; real RabbitMQ test          | Eventing owner / before merge                   |
| Publish/confirm work exceeds 30-second lease                   | Another worker may reclaim while original is active | Five-second confirm timeout, batch limit, backpressure bound, ownership predicate, timing test      | Worker/Eventing owners / before merge           |
| Future Webhook queue has no consumer                           | RabbitMQ disk/backlog grows                         | Approved accumulation, queue/backlog inspection, disk monitoring guidance, later consumer milestone | Operations owner / until Webhook milestone      |
| Single-node local quorum queue is not highly available         | Compose cannot prove multi-node failover            | State limitation; use it for durable semantics only, not an HA claim                                | Architecture owner / documentation review       |
| Topology already exists with incompatible properties           | Channel closes and worker cannot publish            | Fail readiness, no claims, read-only inspection, controlled forward topology plan                   | Operations owner / before deployment            |
| Existing pending index is inefficient at representative ratios | Slow claims and missed lag target                   | `EXPLAIN (ANALYZE, BUFFERS)`; stop for reviewed schema plan if inadequate                           | Database owner / before merge                   |
| Runtime contract rejects a database-constrained row            | Persistent unpublished incident                     | Retain row, capped retry/signal, preserve ID/evidence, forward-fix; never discard                   | Eventing owner / before release                 |
| Unlimited transient retry increases attempt count/backlog      | Operational noise and storage pressure              | 60-second cap, non-hot-looping jitter, structured signals, backlog runbook                          | Operations owner / before merge                 |
| No Prometheus metric exporter in this slice                    | Automated backlog alerting remains incomplete       | Retain queryable state and structured signals; explicitly deliver metrics in Operations milestone   | Operations owner / M4                           |
| No durable per-attempt error columns                           | Historical failure detail depends on bounded logs   | Stable attempt count plus safe logs/runbook; add columns only through later approved plan           | Eventing owner / observability review           |
| Future event types are blocked by current database constraint  | Old worker cannot relay an unapproved type          | Expand schema/contract/topology only with compatible producer/worker rollout                        | Architecture/Eventing owners / before new event |

No unresolved design decision blocks implementation. The project owner approved the topology, queue accumulation, batch/poll/lease/confirm/shutdown values, unlimited capped full-jitter retries, publisher-aware readiness, and observability deferrals on 2026-08-01.

## Implementation order

1. Keep this plan current and confirm the implementation starts from a clean tree.
2. Add the versioned event schema, fixed serializer, AMQP metadata mapping, and contract tests.
3. Implement the Eventing-owned parameterized claim/finalization repository and real PostgreSQL concurrency/query-plan tests.
4. Implement RabbitMQ connection/confirm-channel lifecycle, approved topology assertion, mandatory returns, backpressure, and per-message confirm outcomes.
5. Implement the relay application service with batch partitioning, full-jitter retry scheduling, ownership-safe finalization, and deterministic failure seams.
6. Wire the worker configuration, actual publisher/topology readiness, one non-overlapping loop, and ordered 10-second shutdown drain.
7. Add combined Testcontainers scenarios for normal relay, two-worker race, outage/recovery, mandatory return, partial failure, lease expiry, and publish-before-mark crash.
8. Add event documentation, README commands, backlog inspection, and the recovery runbook.
9. Run the full affected verification matrix, review the complete diff for scope/secrets, record evidence/deviations here, and leave commit/push to an explicitly authorized later action.

## Execution checklist

- [x] Governance, specification, architecture, ADRs, schema/migration, Eventing, worker, Compose, dependencies, tests, and prior Payment Request plan reviewed.
- [x] Design and module/transaction boundaries reviewed.
- [x] Required topology, timing, retry, readiness, queue-accumulation, and observability-deferral decisions approved.
- [x] Read-only implementation plan created.
- [ ] Event contract artifact and relay implementation completed.
- [ ] No unexpected schema/migration or dependency-version change introduced.
- [ ] Unit, contract, real dependency, concurrency, and failure scenarios pass.
- [ ] Security and sensitive-data review passes.
- [ ] Documentation and runbooks updated.
- [ ] Commands/results, query-plan evidence, performance result, and deviations recorded below.

## Verification record

| Command or review                                    | Result            | Date/evidence                                                                                                      |
| ---------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Initial repository status                            | Pass              | 2026-08-01: `git status --short --branch --untracked-files=all` returned only `## main...origin/main` at `e3aa2e7` |
| Complete design evidence review                      | Pass              | 2026-08-01: sources listed under Existing behavior; no specification/schema blocker identified                     |
| Owner approval                                       | Pass              | 2026-08-01: exact topology, operating constants, retry/readiness behavior, accumulation, and deferrals approved    |
| Initial plan formatting, links, and diff checks      | Pass              | 2026-08-01: targeted Prettier check passed, all 7 local links resolved, and `git diff --check` passed              |
| Application/dependency/database/runtime verification | Not run by design | Planning-only task; code and runtime changes are not authorized                                                    |

## Definition of done

This plan can become Complete only when:

- Every existing committed `payment.created.v1` outbox row is eligible for the approved relay without changing Payment Intent API behavior.
- Two workers claim disjoint active leases through reviewed PostgreSQL SQL, publish outside transactions, and condition finalization on lease ownership.
- Only confirmed and routed persistent messages receive `published_at`; nacks, returns, timeouts, outages, partial failures, and lost ownership never create false success.
- Crash after publish/before mark is proven to republish the same stable `messageId`, with no exactly-once claim.
- RabbitMQ topology exactly matches this plan, remains durable/idempotent, and safely accumulates for the future Webhook projection consumer.
- Worker readiness requires PostgreSQL plus a healthy confirm channel and successfully declared topology; shutdown stops claims, drains for 10 seconds, and leaves unresolved work lease-recoverable.
- The event body/schema and AMQP metadata are versioned, exact, consumer-ready, and free of prohibited data.
- Real PostgreSQL/RabbitMQ unit, integration, concurrency, failure-injection, contract, security, build, and publish-lag gates pass without skipped required tests.
- Backlog inspection and recovery guidance are usable without direct row edits, event regeneration, queue purge, or financial-state mutation.
- No capture, refund, ledger, settlement, webhook consumer, inbox, retention deletion, new API, Prometheus exporter, or durable attempt-error schema is introduced.
- The full diff is focused, documented, free of secrets, passes repository checks, and records all commands, results, residual risks, and review evidence.
