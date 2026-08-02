# Implementation Plan: `payment.created.v1` Webhook Projection Consumer

- **Status:** Approved
- **Owner:** SettleFlow Project
- **Created:** 2026-08-02
- **Last updated:** 2026-08-02
- **Related issue/PR:** To be decided
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0004](../adr/0004-rabbitmq-outbox-inbox-and-message-delivery.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md), [ADR-0012](../adr/0012-payment-created-outbox-timing.md), [ADR-0013](../adr/0013-problem-details-audit-and-retention-boundaries.md), [ADR-0016](../adr/0016-webhook-endpoint-api-ownership-and-subscriptions.md), and [ADR-0017](../adr/0017-webhook-endpoint-lifecycle-audit.md)

## Goal

Consume committed `payment.created.v1` events from the durable RabbitMQ queue `settleflow.webhook-projection.payment-created.v1`, validate the exact approved message contract, and atomically record one durable Webhook projection effect per logical event. The effect consists of Eventing-owned inbox evidence, one Webhooks-owned processed-event marker, and one pending Webhooks-owned delivery for every merchant endpoint that is active and subscribed when the event is processed.

The consumer must provide at-least-once transport with exactly-one durable projection effect, acknowledge only after PostgreSQL commit, recover from dependency and process failure without losing messages, and dead-letter invalid or unsupported messages through the existing topology. Successful completion creates projection records only; it performs no outbound network request.

### Non-goals

- No HTTP webhook request, signing, signature header/body contract, DNS re-resolution, destination connection, redirect handling, response capture, or webhook attempt record.
- No automatic delivery claim, delivery lease, HTTP delivery retry, delivery status transition, dead-lettered delivery, or manual delivery replay.
- No new RabbitMQ exchange, queue, retry queue, binding, policy, Compose service, or incompatible topology declaration.
- No Payment Intent endpoint or behavior change; no capture, authorization, refund, ledger, balance, settlement, reconciliation, provider, or financial-table work.
- No new API route, OpenAPI operation, merchant scope, API-key behavior, or endpoint-management behavior.
- No new Operations audit action for routine automated projection. Future manual replay remains separately authenticated, reasoned, and audited.
- No inbox, processed-event marker, or delivery deletion/retention job.
- No new external dependency, metrics backend, dashboard, or production alert destination.

## Specification traceability

- **Sections:** Initial event catalog; FR-07 transactional outbox; FR-08 consumer inbox; FR-09 endpoint ownership and subscriptions; FR-10 future webhook delivery; outbox relay design; module ownership; core data model; retention; reliability and failure model; webhook security; threat model; observability; verification strategy.
- **Requirement IDs:** FR-08 is implemented directly. FR-09 supplies endpoint ownership and processing-time subscription eligibility. FR-07 and the `payment.created.v1` event catalog supply the committed input. FR-10 is compatibility evidence for the future delivery milestone only.
- **Invariant IDs:** INV-10 is enforced for asynchronous duplicate effects. INV-01 through INV-09 remain unchanged because this consumer neither mutates payment/ledger state nor moves funds.
- **Acceptance/release gates:** Real PostgreSQL/RabbitMQ tests must prove inbox deduplication, commit-before-ack, redelivery after both crash boundaries, active/subscribed tenant-safe fanout, zero-endpoint completion, poison-message DLQ routing, reconnect, shutdown, migration compatibility, least privilege, and no regression to Payment Intent or the outbox relay.

The specification identifies Payments as producer and the Webhook projection as primary consumer of `payment.created.v1`. Its minimum payload is refined by the already committed flat nine-field contract. The core model assigns `(consumer_name, message_id)` uniqueness to the inbox and one endpoint/event effect to webhook delivery. ADR-0004 requires manual acknowledgement, bounded concurrency, poison handling, and dead-letter recovery; ADR-0016 requires eligibility in the inbox-protected consumer transaction and prohibits historical fanout after processing.

## Existing behavior

The approved implementation baseline is commit `73887ed` on `main`. The following committed evidence was inspected before this plan:

- [The module boundaries](../architecture/module-boundaries.md) assign `outbox_events` and `inbox_messages` to Eventing; endpoints, deliveries, attempts, and signing metadata to Webhooks; and privileged audit to Operations.
- [The financial invariants](../architecture/financial-invariants.md) require every state-changing RabbitMQ consumer to use inbox uniqueness and acknowledge only after its effect commits.
- [The transactional-outbox relay plan](2026-08-01-transactional-outbox-relay.md) and Eventing implementation declare the existing durable topology and publish exact consumer-ready AMQP metadata.
- [The event contract](../events/README.md) defines the exact nine-field body, stable `messageId`, schema header, correlation, aggregate, merchant, persistence, timestamp, and producer metadata.
- [The Webhook Endpoint Foundation plan](2026-08-01-webhook-endpoint-foundation.md), schema, and Webhooks module provide merchant-owned endpoints, normalized `payment.created.v1` subscriptions, active/inactive status, immutable URL, encrypted current/previous secrets, and append-only endpoint lifecycle audit.
- The Prisma schema contains `Merchant`, `ApiKey`, `PaymentIntent`, `IdempotencyKey`, `OutboxEvent`, `WebhookEndpoint`, `WebhookEndpointSubscription`, `WebhookEndpointSecret`, and `AuditEvent`. It contains no inbox, processed-event marker, delivery, or attempt table.
- The worker is a NestJS application context that composes the outbox relay. It owns one Prisma lifecycle, one RabbitMQ publisher-confirm connection/channel, internal readiness, heartbeat, and a 10-second relay drain.
- The worker uses the non-owner PostgreSQL role `settleflow_app`; the latest migration grants only the approved table operations and denies audit update/delete/truncate.
- The consumer queue intentionally accumulates events until this milestone. Existing accumulated events have stable event IDs and are eligible for processing without changing Payment Intent or outbox rows.

Current topology is authoritative and unchanged:

| Purpose                 | Approved value                                                               |
| ----------------------- | ---------------------------------------------------------------------------- |
| Domain exchange         | `settleflow.domain-events`; durable topic exchange                           |
| Event routing key       | `payment.created.v1`                                                         |
| Consumer queue          | `settleflow.webhook-projection.payment-created.v1`; durable quorum queue     |
| Dead-letter exchange    | `settleflow.dead-letter`; durable topic exchange                             |
| Dead-letter routing key | `settleflow.webhook-projection.payment-created.v1`                           |
| Dead-letter queue       | `settleflow.webhook-projection.payment-created.v1.dlq`; durable quorum queue |

## Proposed design

### Ownership and dependency direction

The runtime call direction is:

```text
Worker lifecycle/composition
  -> Eventing RabbitMQ consumer adapter
  -> Eventing inbox application service/repository
  -> Webhooks payment-created projection application port/repository
```

- Eventing owns AMQP consumption, topology assertion, consumer-side contract validation, inbox persistence, deduplication result, acknowledgement/rejection ordering, and consumer connection recovery.
- Webhooks owns the processed-event marker, eligible-endpoint query, delivery identifiers, and delivery projection rows.
- The worker composes public Eventing and Webhooks ports. It does not contain eligibility, deduplication, or persistence rules and does not write tables directly.
- Eventing does not import Webhooks internals. A typed effect/handler port allows the Eventing inbox service to invoke the Webhooks effect inside the shared transaction.
- Webhooks may depend on Eventing's public event/inbox types or port but never writes `inbox_messages` directly.
- Operations receives no call for routine automated projection. A future authenticated replay command must call the Operations audit port under a separately approved plan.

### Approved consumer identity and limits

| Setting                                    |                          Approved value |
| ------------------------------------------ | --------------------------------------: |
| Consumer name                              | `webhook-projection.payment-created.v1` |
| Queue prefetch                             |                                       2 |
| Maximum concurrent projection transactions |                                       2 |
| Maximum raw message body                   |                   16 KiB / 16,384 bytes |
| Serialization/deadlock transaction retries |                      3 complete retries |
| RabbitMQ reconnect base                    |                                1 second |
| RabbitMQ reconnect cap                     |                              60 seconds |
| Reconnect delay                            |                      Capped full jitter |
| Shutdown drain                             |                              10 seconds |
| Delivery public ID                         |                            `whd_<ULID>` |
| Delivery-ID collision attempts             |                               At most 3 |

The conservative concurrency fits the current five-connection worker Prisma pool while leaving capacity for the outbox relay and readiness probes. A later measured change to prefetch/concurrency requires a reviewed plan update and real backlog/concurrency evidence; it must not be changed implicitly in configuration defaults.

### AMQP and payload validation

Validation occurs before the PostgreSQL transaction. The consumer must reject a message unless all application-controlled fields match the committed contract:

- `fields.exchange` is `settleflow.domain-events`.
- `fields.routingKey` is `payment.created.v1`.
- `properties.messageId` is a valid `evt_<ULID>` and equals body `eventId`.
- `properties.type` and body `eventType` are `payment.created.v1`.
- `properties.correlationId` equals body `requestId`.
- `properties.contentType` is `application/json`.
- `properties.contentEncoding` is `utf-8`.
- Delivery mode is `2`/persistent.
- `properties.timestamp` equals `floor(occurredAt milliseconds / 1000)`.
- `properties.appId` is `settleflow-worker`.
- `x-settleflow-schema-version` is integer `1`.
- `x-settleflow-aggregate-type` is `payment_intent`.
- `x-settleflow-aggregate-id` equals body `paymentId`.
- `x-settleflow-merchant-id` equals body `merchantId`.
- `x-settleflow-publish-attempt` is a positive integer.

Broker-managed headers such as quorum delivery count/redelivery evidence are diagnostics and may be present. They do not become application contract fields. Publish attempt, delivery tag, consumer tag, and broker delivery count are not logical identities and are excluded from the inbox fingerprint.

The raw content must be no larger than 16,384 bytes, decode as strict UTF-8, parse as JSON, and contain exactly these nine fields in the approved semantics:

```json
{
  "eventId": "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "eventType": "payment.created.v1",
  "occurredAt": "2026-08-01T10:20:12.345Z",
  "requestId": "req_example",
  "merchantId": "11111111-1111-4111-8111-111111111111",
  "paymentId": "pi_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "amountMinor": 125000,
  "currency": "ETB",
  "status": "CREATED"
}
```

Validation requires exact event/payment/request/UUID formats, canonical date-time semantics, `amountMinor` from 1 through `Number.MAX_SAFE_INTEGER`, currency `ETB` or `USD`, status `CREATED`, no missing field, and no additional field. Native `JSON.parse` is sufficient because the committed producer emits canonical JSON numbers and the consumer rejects fractional or unsafe results. The API's lossless request parser is not reused and no dependency is added.

The consumer calculates SHA-256 over the exact validated raw bytes. A valid relay republish must produce the same bytes even when its publish-attempt header changes.

### Inbox and projection flow

For a structurally valid message:

1. Open one PostgreSQL `SERIALIZABLE` transaction through the Eventing inbox service.
2. Obtain one database projection timestamp for inbox completion, processed-event projection, delivery creation, and `next_attempt_at`.
3. Reserve `(consumer_name, message_id)` in `inbox_messages` with event type, schema version, correlation ID, raw-body SHA-256, and timestamps.
4. When the inbox insert wins, invoke the Webhooks projection port using the same transaction client.
5. Insert the Webhooks processed-event marker. If a marker already exists because a future inbox-retention job removed only inbox evidence, compare its immutable identity and fingerprint before treating the event as already projected.
6. Query Webhook endpoints for the event's merchant that are `active` and have a normalized `payment.created.v1` subscription in the same transaction database view.
7. Generate one `whd_<ULID>` for every eligible endpoint and insert one `pending` delivery with `attempt_count = 0` and `next_attempt_at = projected_at`.
8. Commit the inbox row, marker, and complete delivery set together.
9. Acknowledge the RabbitMQ message only after the transaction promise returns successfully.

If the inbox primary key already exists, load the completed record:

- Matching consumer, event type, schema version, correlation, and raw-body hash is a completed duplicate. Do not call the Webhooks effect; return a deduplication result and acknowledge after the read transaction completes.
- Any mismatch under the same logical message ID is a poison-message identity conflict. Create no effect and reject to the DLQ.

If the inbox row has been removed in a future approved retention process but the Webhooks marker remains:

- A matching marker makes the Webhooks effect a no-op; the new inbox evidence commits and the message is acknowledged.
- A mismatched marker is poison and rolls back the new inbox row.

An event with zero eligible endpoints still commits the inbox and processed-event marker, then acknowledges. This makes the no-historical-fanout decision durable even when no delivery exists.

### Processing-time eligibility

Eligibility is the `SERIALIZABLE` transaction's database view, not event occurrence time:

```sql
WHERE webhook_endpoints.merchant_id = event.merchantId
  AND webhook_endpoints.status = 'active'
  AND webhook_endpoint_subscriptions.event_type = 'payment.created.v1'
```

- An endpoint active and subscribed in that serialization order receives one initial delivery.
- An endpoint disabled before the projection serialization order receives none.
- Registration/reactivation after durable processing does not create historical fanout.
- An event accumulated before consumer deployment may create a delivery for an endpoint registered before that event is eventually processed. That is the accepted processing-time rule.
- Later endpoint disablement does not mutate or delete a committed projection. Whether the future HTTP sender suppresses an already-projected delivery is explicitly deferred.

The Webhooks repository owns the tenant/status/subscription query. Eventing and the AMQP adapter must not query Webhooks tables. Parameterized reviewed raw SQL is permitted only if Prisma cannot safely express the exact isolation, fingerprint reservation, locking, or bulk insert/collision behavior.

### Delivery identifiers and collisions

Use the existing process-scoped monotonic ULID generator to construct `whd_<ULID>` identifiers. Identifier generation performs no I/O. A unique public-ID violation rolls back the full projection transaction, regenerates every candidate ID, and retries at most three times. Only the named delivery public-ID constraint triggers this retry; tenant, endpoint/event uniqueness, foreign-key, payload, or other constraint failures must not be misclassified as random collisions.

The public ID is created now because future signing and replay correlation require a stable delivery identity. No signature or outbound header is produced in this milestone.

### RabbitMQ connection and readiness

The projection consumer owns a RabbitMQ connection and regular consumer channel separate from the relay's publisher-confirm connection/channel. Consumer reconnect or channel cancellation therefore cannot invalidate in-flight publisher confirms.

The consumer idempotently asserts the existing approved exchanges, queues, arguments, and bindings through a shared Eventing topology declaration. It never deletes/recreates a conflicting queue. A declaration mismatch fails closed, marks the consumer unavailable, and requires a forward topology correction.

After topology assertion, configure `prefetch(2)` and register `consume` with `noAck: false`. Consumer readiness is true only while the connection/channel are open and the broker has returned an active consumer registration. The complete worker is ready only when:

- PostgreSQL connectivity is healthy;
- the publisher-confirm channel and full topology are ready; and
- the projection consumer channel, topology, and consumer registration are ready.

Liveness remains process-only. During connection/channel loss, consumer cancellation, topology failure, or reconnect wait, worker readiness is `not_ready` even if the publisher remains healthy.

### Acknowledgement, retry, and dead-letter behavior

- Valid new event: `ack` only after inbox/marker/deliveries commit.
- Matching duplicate: `ack` only after durable duplicate detection completes.
- Invalid UTF-8/JSON, oversize body, unsupported version/type, malformed payload, metadata mismatch, or logical-identity mismatch: no domain transaction/effect; `nack(requeue=false)` immediately so the existing DLX routes the original message to the approved DLQ.
- Serialization failure (`40001`/Prisma equivalent) or deadlock (`40P01`): roll back and retry the complete transaction, with bounded jitter, at most three times. Exhaustion is a poison/terminal processing failure and is rejected to the DLQ with a safe stable signal.
- Deterministic Webhooks invariant/constraint failure after a valid contract: roll back, never acknowledge, classify with a safe code, and reject to the DLQ. Do not retry a known permanent violation in a hot loop.
- PostgreSQL connection/unavailability or RabbitMQ connection/channel failure: do not classify the message as poison and do not acknowledge it. Cancel/close the consumer path as needed; RabbitMQ requeues unacknowledged deliveries. Mark readiness down and reconnect with unlimited capped full-jitter waits from 1 to 60 seconds.
- Unknown failure: fail closed with no acknowledgement or partial commit. If connectivity is healthy and the error is deterministically repeatable, classify it as poison through the bounded processing path; otherwise stop/reconnect rather than guessing success.

There is no consumer retry exchange or delayed queue. Dependency recovery is connection lifecycle behavior, while the three-attempt limit applies to one message's complete serializable database transaction. No required message is silently dropped, purged, or acknowledged on failure.

The DLQ is durable broker evidence. This milestone creates no DLQ database table, automated DLQ consumer, replay command, or queue purge path. Manual replay remains controlled and audited future work.

### Reconnection and graceful shutdown

Connection/channel error, close, cancellation, blocked topology initialization, and explicit readiness probe failure invalidate only the consumer's owned resources. Reconnect uses injected randomness and:

```text
uniform(0, min(60 seconds, 1 second * 2^(attemptCount - 1)))
```

Successful topology declaration plus active consumer registration resets the connection attempt counter.

Shutdown order is:

1. Mark the worker stopping/not ready and stop scheduling new outbox relay claims.
2. Cancel the RabbitMQ consumer by consumer tag so the broker sends no new deliveries.
3. Drain active relay work and active projection transactions for at most 10 seconds.
4. Acknowledge only work whose transaction committed during the drain.
5. Close the consumer channel/connection; any remaining unacknowledged message is requeued by RabbitMQ.
6. Close the publisher-confirm channel/connection.
7. Close the shared Prisma client/pool.

No timer or retry promise may keep the process alive after shutdown starts. Closing Prisma before active transaction settlement is prohibited.

### Rejected alternatives

- Acknowledge before or during the database transaction: can lose the projection after a crash.
- Use the queue delivery tag, publish attempt, or correlation ID for deduplication: these are not the stable logical message identity.
- Store only a delivery row and omit a zero-fanout marker: permits historical fanout after inbox retention when no initial endpoint was eligible.
- Retain only the 30-day inbox record: does not permanently preserve ADR-0016's processed-event decision.
- Query eligibility before or outside the inbox transaction: status/subscription races can create an effect inconsistent with the accepted processing-time rule.
- Share the publisher confirm channel with the consumer: couples distinct reliability boundaries and makes reconnect/shutdown unsafe.
- Add a retry queue or mutate the existing quorum-queue arguments: changes the approved topology without need and risks a declaration conflict with retained messages.
- Query Payments to re-authorize the event: violates event-driven module boundaries and creates unnecessary synchronous coupling. The committed outbox event plus strict internal broker contract is the input.
- Decrypt endpoint secrets or resolve destination DNS during projection: expands into the excluded HTTP delivery milestone and holds database work across external operations.
- Add an Operations audit row for each automatic projection: routine event handling is not a privileged action and high-volume audit would contradict ADR-0013/ADR-0017 boundaries.

## Affected modules and files

| Module/file area                                                                                  | Ownership or change                                                                        | Boundary impact                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `docs/plans/2026-08-02-payment-created-webhook-projection-consumer.md`                            | Approved plan and later execution evidence                                                 | This file is created before implementation.                        |
| `prisma/schema.prisma`                                                                            | Add Eventing inbox and Webhooks projection/delivery models and relations                   | No financial model or settlement column changes.                   |
| `prisma/migrations/<timestamp>_payment_created_webhook_projection_consumer/migration.sql`         | Add reviewed tables, types/checks, indexes, foreign keys, and runtime grants               | Owner applies migration; `settleflow_app` remains non-owner.       |
| `packages/modules/eventing/src/payment-created-event.contract.ts` and test                        | Add strict inverse body/metadata validation and exact-byte fingerprint input               | Contract semantics remain compatible with the committed producer.  |
| New Eventing inbox types/service/repository and tests                                             | Own reservation, duplicate comparison, shared transaction, and results                     | Webhooks effect is called through a typed port; no table crossing. |
| New Eventing RabbitMQ consumer/topology support and tests                                         | Own manual ack/reject, prefetch, connection, topology, reconnect, and drain                | Separate from the publisher-confirm channel.                       |
| `packages/modules/eventing/src/index.ts`                                                          | Export only public consumer/inbox contracts                                                | No Webhooks import or reverse dependency.                          |
| New Webhooks projection types/service/repository and tests                                        | Own marker, eligibility, `whd_` IDs, and pending deliveries                                | Does not write Eventing or Payments tables.                        |
| `packages/modules/webhooks/src/webhook.types.ts`, `webhook.errors.ts`, and `index.ts`             | Extend public internal projection contract and stable errors                               | Existing endpoint API behavior remains unchanged.                  |
| `packages/modules/webhooks/package.json`                                                          | Add only required workspace dependency edge if the public Eventing port/types are imported | No third-party dependency.                                         |
| `apps/worker/package.json`, module/config/health/runtime/signal files and tests                   | Compose consumer, Webhooks effect, readiness, reconnect, and shutdown                      | Worker stays an entrypoint/lifecycle owner, not a domain owner.    |
| Root `package.json` and `pnpm-lock.yaml`                                                          | Build/test the Webhooks dependency graph for worker and record workspace importer edges    | Exact external dependency set is unchanged.                        |
| `test/integration/webhook-projection-consumer.int-spec.ts`                                        | Real PostgreSQL/RabbitMQ contract, crash, duplicate, DLQ, and lifecycle proof              | Disposable synthetic infrastructure only.                          |
| Existing Prisma-foundation, outbox-relay, and worker integration tests                            | Update table/grant/readiness inventory and regression expectations                         | Existing API and relay guarantees remain required.                 |
| `README.md`, `packages/README.md`, `SECURITY.md`, `docs/events/README.md`                         | Document implemented ownership, consumer behavior, and redaction                           | No new API or webhook body/signature promise.                      |
| `docs/runbooks/outbox-backlog.md`, new projection-consumer runbook, and `docs/runbooks/README.md` | Replace absent-consumer guidance and add safe queue/inbox/projection diagnosis             | No automated/manual replay or destructive command.                 |

No change is expected in API controllers, API environment, OpenAPI source/artifact, Compose, Merchant Access, Payments, Idempotency, Operations audit code/schema, endpoint management, or the existing event body.

## API and integration impact

- **HTTP/OpenAPI:** No route, response, scope, problem type, or OpenAPI schema changes. `openapi:check` remains a no-drift regression gate.
- **Payment Intent:** Create/read behavior and atomic Payment Intent/idempotency/outbox transaction remain unchanged. API success still does not wait for relay or consumer completion.
- **Domain event:** Body and AMQP contract remain exactly `payment.created.v1` v1. This milestone adds a strict consumer, not a new field/version.
- **RabbitMQ:** Consume only the existing approved queue with manual acknowledgements. Existing exchange, routing, quorum, DLX, and DLQ declarations remain byte-for-byte compatible.
- **Webhook:** Creates internal pending delivery projections only. It does not define or send an external webhook payload, signature, timestamp, or request.
- **Compatibility:** Apply the additive migration before a worker version that requires the new tables. Old workers continue publishing/accumulating; new workers process the retained backlog. API versions tolerate the additive schema during rolling replacement.

## Database and migration impact

### Eventing-owned `inbox_messages`

Recommended Prisma/database fields:

| Field           | Database contract                                               |
| --------------- | --------------------------------------------------------------- |
| `consumerName`  | `consumer_name varchar(128)`; bounded safe consumer identity    |
| `messageId`     | `message_id varchar(30)`; valid `evt_<ULID>`                    |
| `eventType`     | `event_type varchar(128)`; bounded event type                   |
| `schemaVersion` | `schema_version integer`; positive and currently written as `1` |
| `payloadSha256` | `payload_sha256 bytea`; exactly 32 bytes                        |
| `correlationId` | `correlation_id varchar(128)`; approved request-ID format       |
| `receivedAt`    | `received_at timestamptz(6)`                                    |
| `completedAt`   | `completed_at timestamptz(6)`; not before received time         |

Use named primary key `inbox_messages_pkey` on `(consumer_name, message_id)`, named checks for identity/hash/time consistency, and `inbox_messages_completed_at_idx` for future terminal retention inspection. The table stores only completed visible rows because reservation and effect commit together; no independently visible in-progress state is introduced.

### Webhooks-owned `webhook_event_projections`

| Field           | Database contract                                                            |
| --------------- | ---------------------------------------------------------------------------- |
| `eventId`       | `event_id varchar(30)`; stable unique `evt_<ULID>`                           |
| `eventType`     | `event_type varchar(128)`; exact `payment.created.v1`                        |
| `schemaVersion` | `schema_version integer`; exact `1`                                          |
| `merchantId`    | `merchant_id uuid`; `RESTRICT` merchant ownership FK                         |
| `paymentId`     | `payment_id varchar(29)`; valid `pi_<ULID>`                                  |
| `occurredAt`    | `occurred_at timestamptz(6)`                                                 |
| `requestId`     | `request_id varchar(128)`                                                    |
| `amountMinor`   | `amount_minor bigint`; 1 through 9,007,199,254,740,991                       |
| `currency`      | `currency char(3)`; `ETB` or `USD`                                           |
| `paymentStatus` | `payment_status varchar(32)`; exact `CREATED` snapshot                       |
| `payloadBytes`  | `payload_bytes bytea`; exact validated UTF-8, 1 through 16,384 bytes         |
| `payloadSha256` | `payload_sha256 bytea`; exactly 32 bytes and matches application fingerprint |
| `projectedAt`   | `projected_at timestamptz(6)`                                                |

Use event ID as the stable primary/unique identity and add a composite unique key `(event_id, merchant_id)` if needed for tenant-safe composite delivery foreign keys. Do not add a foreign key to `payment_intents`; the Webhooks projection is an event-owned snapshot and must not synchronously join Payments.

The exact bytes are retained so the future delivery milestone has lossless event evidence and need not reconstruct data from Payment Intent or outbox state. This plan does not yet declare those bytes to be the external HTTP body; the later signing/body plan must make that compatibility decision explicitly.

### Webhooks-owned `webhook_deliveries`

| Field                   | Database contract/initial value                                     |
| ----------------------- | ------------------------------------------------------------------- |
| `id`                    | Internal UUID primary key                                           |
| `publicId`              | `public_id varchar(30)`; unique `whd_<ULID>`                        |
| `merchantId`            | `merchant_id uuid`                                                  |
| `endpointId`            | `endpoint_id uuid`                                                  |
| `eventId`               | `event_id varchar(30)`                                              |
| `status`                | Webhooks-owned initial enum/check; only `pending` in this milestone |
| `attemptCount`          | `attempt_count integer`; exact initial `0` and nonnegative          |
| `nextAttemptAt`         | `next_attempt_at timestamptz(6)`; equal to projection timestamp     |
| `createdAt`/`updatedAt` | `timestamptz(6)`; equal at projection                               |

Use named unique constraints for public ID and initial `(endpoint_id, event_id)`. Add tenant-safe composite foreign keys so the endpoint, event projection, and delivery share `merchant_id`; this may require redundant unique keys on `(webhook_endpoints.id, merchant_id)` and `(webhook_event_projections.event_id, merchant_id)`. All deletes use `RESTRICT`.

Add the specification's future-compatible due index on `(next_attempt_at, id)` for `pending` rows. Do not add `retrying`, `delivered`, `dead_lettered`, attempt, response, error, signing, URL, secret-version, or lease state until the delivery milestone approves their behavior. Future manual replay must refine the initial endpoint/event uniqueness so a new delivery ID can reference the same event without weakening the initial-projection guarantee.

### Eligibility and operational indexes

Add a Webhooks-owned index supporting merchant/status endpoint selection, for example `(merchant_id, status, id)`. The existing subscription primary key supports endpoint/event membership. Inspect `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` with representative synthetic fanout and require the intended access paths without forcing a planner-specific exact tree.

### Runtime-role grants

The migration must verify that `settleflow_app` was provisioned, create all objects as the migration owner, revoke implicit privileges, and grant only:

- `SELECT, INSERT` on `inbox_messages`;
- `SELECT, INSERT` on `webhook_event_projections`;
- `SELECT, INSERT` on `webhook_deliveries`;
- existing read access required for merchant-scoped endpoint/subscription eligibility.

Do not grant update/delete/truncate on new evidence/projection tables. The future HTTP sender will require a separately reviewed migration before it can transition delivery state. Do not expand audit privileges or run either process with owner credentials.

### Migration ordering and compatibility

1. Provision/verify `settleflow_app` through the existing owner-controlled path.
2. Apply the additive migration before deploying the consumer-capable worker.
3. Old API/worker code remains compatible and continues producing/relaying events.
4. New worker readiness remains false until both the schema and RabbitMQ consumer are available.
5. Process the existing queue under processing-time eligibility; do not backfill directly from Payments or outbox tables.
6. Test both an empty database and upgrade from the committed Webhook Endpoint Foundation schema.

No data backfill or destructive DDL is required. The new migration must contain exact named checks/indexes/foreign keys/grants and a forward-fix note.

## Transaction boundaries and concurrency

The inbox reservation, processed-event marker, eligibility query, and complete delivery set use one Prisma interactive transaction with PostgreSQL `SERIALIZABLE` isolation. Set bounded lock, statement, max-wait, and transaction timeouts below the 10-second shutdown drain. All RabbitMQ operations and identifier generation occur outside database network waits; acknowledgements are after commit.

Within the transaction:

1. Parameterized `INSERT ... ON CONFLICT DO NOTHING RETURNING` or an equivalently safe Eventing-owned operation reserves the inbox identity.
2. A conflict is followed by an exact stored fingerprint/metadata comparison under the same transaction.
3. A winning reservation calls the Webhooks application port with the same transaction-scoped Prisma client.
4. The Webhooks marker insert provides a second durable guard across future inbox retention.
5. The tenant-scoped active/subscribed query and delivery inserts share the serializable database view.
6. Commit makes the inbox and every delivery visible together; rollback removes all of them.

PostgreSQL serialization failure or deadlock retries the entire operation at most three times. No retry begins from a partial delivery set. `whd_` public-ID collision retries are independently limited to three complete attempts and only follow the named public-ID unique constraint. Unknown constraint or database errors are never assumed to be collisions.

With two unacknowledged/concurrent messages, inbox uniqueness serializes duplicate logical messages. Two distinct events may process concurrently and can each legitimately create one delivery for the same endpoint because uniqueness is endpoint plus event, not endpoint alone.

## Security and privacy

- RabbitMQ is an internal asynchronous boundary, not financial authority. Validate every application-controlled AMQP property/header and every payload field before persistence.
- Enforce the 16 KiB limit before decoding/parsing and strict UTF-8/JSON/type/range checks before beginning a domain transaction.
- The event contains only the committed minimum payment snapshot. It excludes API keys, idempotency keys, `externalRef`, raw API requests/responses, internal Payment Intent UUID, provider data, settlement state, endpoint URL, and secrets.
- Merchant ID is included in every endpoint eligibility predicate and reinforced by composite tenant foreign keys.
- Do not query Payments to validate a broker event and do not trust a cross-merchant endpoint result.
- Do not decrypt current/previous signing secrets, resolve DNS, inspect the endpoint URL, or initiate HTTP during projection.
- Store exact event bytes as bounded Webhooks evidence, but never emit them to routine logs, traces, tickets, or errors.
- Structured telemetry may contain event ID, merchant ID, request ID, delivery count, duration, redelivery flag, and stable code. It must exclude raw bodies, destinations, credentials, hashes, ciphertext, secrets, connection URLs, and stack traces.
- The `settleflow_app` grants are additive and least privilege. Owner-only migration and future retention/replay remain separate controls.
- Routine projection is not privileged audit. No fabricated actor/API-key ID may be used to write an audit row.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario                      | Expected safe state                                              | Retry/recovery                                                                    | Evidence                                 |
| -------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------- |
| Invalid/oversized UTF-8 or JSON                    | No inbox, marker, or delivery                                    | Immediate `nack(requeue=false)` to existing DLQ                                   | Unit contract and real DLQ test          |
| Unsupported event/schema or AMQP metadata mismatch | No domain effect                                                 | Immediate DLQ; deploy compatible code before controlled future replay             | Contract matrix and RabbitMQ integration |
| First valid delivery                               | Inbox, one marker, zero-or-more unique pending deliveries commit | Ack after commit                                                                  | PostgreSQL/RabbitMQ integration          |
| Duplicate after completed inbox                    | No second Webhooks effect                                        | Compare fingerprint, record dedup signal, then ack                                | Concurrent/redelivery tests              |
| Same message ID with different bytes/metadata      | Existing effect remains unchanged                                | Reject conflicting message to DLQ                                                 | Fingerprint mismatch test                |
| Zero eligible endpoints                            | Inbox and marker commit; zero deliveries                         | Ack; later endpoint changes do not fan out                                        | Zero-fanout/late-registration test       |
| Future inbox expiry plus matching marker           | New inbox evidence may commit; no new deliveries                 | Ack after marker comparison                                                       | Retention-boundary simulation            |
| Crash before PostgreSQL commit                     | No inbox/marker/delivery visible                                 | Broker redelivers unacknowledged message                                          | Forced rollback/channel-close test       |
| Crash after commit before ack                      | Exactly one committed effect                                     | Redelivery hits inbox and is acknowledged                                         | Post-commit/pre-ack failure seam         |
| Serialization/deadlock                             | Complete transaction rolls back                                  | Full transaction retry, maximum 3; exhausted message DLQ                          | Injected SQL/race test                   |
| PostgreSQL unavailable                             | No partial commit and no ack                                     | Consumer becomes unready; unacknowledged message requeues; reconnect 1–60 seconds | Container outage/recovery test           |
| RabbitMQ channel/connection lost                   | Committed effects remain; unacked messages requeue               | Consumer-only reconnect and topology/registration restore                         | Connection interruption test             |
| Delivery public-ID collision                       | Full transaction rolls back                                      | Regenerate all IDs, maximum 3; then terminal safe failure                         | Injected generator/named-constraint test |
| Deterministic projection constraint failure        | No partial effect                                                | Safe signal and DLQ; forward-fix code/migration before replay                     | Constraint failure test                  |
| Topology declaration conflict                      | Queue/messages remain untouched; worker not ready                | Stop affected worker and deploy compatible forward topology fix                   | Declaration-conflict test                |
| Shutdown during active processing                  | Committed work may ack; incomplete work stays unacked            | Drain 10 seconds, then close consumer for redelivery                              | Graceful/timeout integration tests       |

No handler acknowledges in `finally`. No recovery edits `inbox_messages`, projection markers, delivery rows, outbox state, endpoint lifecycle, audit evidence, or Payment Intent state. Queue purge and manual broker/database movement are prohibited normal recovery paths.

## Observability and operations

Add bounded structured signals or the repository's equivalent telemetry abstraction for:

- consumer starting, ready, unavailable, reconnect scheduled, reconnected, stopping, drained, drain timeout, and stopped;
- message received, projection committed, zero-endpoint projection, duplicate detected, poison rejected, transaction retry, and dependency unavailable;
- delivery count and processing duration without payload or destination content.

Worker heartbeat/readiness should expose independent publisher and projection-consumer RabbitMQ checks or an equally diagnostic structure while retaining an overall `ready`/`not_ready` result. A consumer reconnect cannot falsely report ready merely because the relay publisher remains ready.

The specification names `rabbit.consume` and `inbox_dedup_hits_total`. This milestone must expose equivalent structured operational signals even if no Prometheus exporter exists. Environment-specific alert thresholds, dashboards, severity, operator identities, and contact destinations remain **To be decided** by Operations before production-like deployment.

Create read-only local queries/commands for:

- queue ready/unacknowledged count and DLQ count/age;
- completed inbox count and oldest completion;
- processed-event count and zero-delivery events;
- pending delivery count and oldest `next_attempt_at`;
- tenant-safe event/delivery correlation using stable IDs only.

Add a Webhook projection consumer/dead-letter runbook. It must prohibit queue purge, direct replay, and row edits; classify contract poison versus dependency outage; restore connectivity/topology; validate catch-up/deduplication; and require a future authorized, reasoned, audited replay tool rather than manual message movement.

## Test strategy

- **Unit — event/AMQP contract:** Accept exact publisher output; reject every wrong/missing property/header, unsupported schema/type, invalid/extra body field, invalid ID/time/UUID, unsafe/fractional amount, unsupported currency/status, invalid UTF-8/JSON, and body above 16 KiB. Prove broker diagnostics and publish attempt are not logical identity.
- **Unit — inbox:** Prove new, matching duplicate, mismatched duplicate, rollback, concurrent duplicate, marker fallback, and effect invocation behavior. Assert the Webhooks effect is never called twice.
- **Unit — Webhooks projection:** Prove merchant/status/subscription eligibility, zero fanout, marker fingerprint comparison, exact pending values, shared timestamp, `whd_` format, named collision mapping, and three-attempt exhaustion. Assert no secret, URL-policy, Operations audit, or HTTP dependency is invoked.
- **Unit — RabbitMQ adapter:** Prove `prefetch(2)`, `noAck: false`, topology declaration, active-registration readiness, ack-after-success, immediate poison reject, no ack on dependency failure, separate connection ownership, full-jitter reconnect, cancel, drain, and close ordering.
- **Unit — worker lifecycle:** Prove readiness requires PostgreSQL, publisher, topology, and active consumer; one unavailable path makes the worker not ready; shutdown cancels consumer before RabbitMQ/Prisma close and respects 10 seconds.
- **Database constraints/migrations:** Apply the full history to an empty PostgreSQL 18 database and upgrade the committed prior schema. Test every named ID, hash, amount, currency, status, tenant, unique, time, and permission constraint. Verify the runtime role cannot update/delete/truncate new tables.
- **Integration with real dependencies:** Relay a real committed event through RabbitMQ and consume it using runtime-role PostgreSQL. Assert queue acknowledgment only after one inbox, one marker, and the exact eligible delivery set commit.
- **Contract:** Reuse the committed JSON schema and publisher serializer tests. Assert the consumer accepts the publisher's exact bytes/metadata and that no event/OpenAPI artifact drifts.
- **Concurrency/race:** Concurrent duplicate deliveries create one effect; concurrent distinct events create independent effects; endpoint disable/reactivation races produce a valid serializable ordering; public-ID collision and SQL retry budgets are bounded.
- **Failure injection/recovery:** Crash before commit, crash after commit/before ack, PostgreSQL stop/restart, RabbitMQ connection interruption, topology conflict, poison DLQ, retry exhaustion, consumer cancellation, graceful drain, and drain timeout.
- **Security:** Cross-merchant endpoints are never selected; exact bytes and destination/secret data do not reach logs/errors; prohibited payload fields are rejected; runtime permissions remain least privilege.
- **Performance:** Project representative events with synthetic endpoint fanout, inspect the eligibility/due index plans, prove prefetch/concurrency stay at 2, and measure backlog catch-up without asserting the later HTTP `webhook_fanout` target.
- **Regression:** Payment Intent create/read, readiness, endpoint APIs, audit immutability, outbox relay, Prisma foundation, and production builds remain green.
- **Documentation/link checks:** Prettier/Markdown formatting, local-link resolution, JSON schema contract, `git diff --check`, and full status inspection.

Required implementation verification commands:

```shell
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm infra:up
pnpm db:provision-runtime-role
pnpm infra:ps
pnpm prisma:validate
pnpm prisma:generate
pnpm db:migrate:apply
pnpm db:migrate:status
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:event-contract
pnpm test:webhooks
pnpm test:worker
pnpm test:integration
pnpm test
pnpm build
pnpm openapi:check
git diff --check
git status --short --branch
```

The real-dependency verification must also inspect RabbitMQ ready/unacknowledged/DLQ counts and read-only inbox/projection/delivery counts through normal, duplicate, poison, outage, reconnect, and shutdown scenarios. Any unavailable Docker runtime is a documented blocker, not permission to replace PostgreSQL/RabbitMQ evidence with mocks.

## Documentation impact

- Update the root README and package ownership README from "consumer absent" to the implemented projection behavior, exact worker configuration, readiness, shutdown, and safe inspection commands.
- Update the event contract guide to document the consumer identity, inbox key, accepted AMQP metadata, acknowledgment boundary, and projection-only meaning.
- Update the outbox-backlog runbook so queue accumulation is no longer described as intentionally consumerless.
- Add and index a Webhook projection consumer/dead-letter runbook with safe diagnostics, redaction, recovery, and explicit prohibited actions.
- Update the security policy for poison-message validation, exact-byte retention, payload redaction, tenant filtering, and runtime-role grants.
- Do not add an HTTP webhook body/signature example, delivery retry schedule implementation, replay command, or OpenAPI operation in this milestone.
- No architecture or financial-invariant change is expected. Any implementation discovery that changes topology, table ownership, no-historical-fanout, audit/replay boundaries, or external webhook compatibility requires ADR/change-control review before continuation.

## Rollback or forward-recovery strategy

The migration is additive and must precede the consumer deployment. If consumer code is faulty, mark the worker not ready, cancel/stop the projection consumer, preserve the queue, DLQ, inbox, markers, and delivery rows, and deploy a forward fix. The old worker version can continue relaying events while the durable consumer queue accumulates.

Do not roll back by dropping tables with retained evidence, deleting inbox/marker/delivery rows, purging either queue, rebinding messages manually, generating replacement event IDs, or editing Payment Intent/outbox/endpoint/audit state. A schema defect is corrected with a reviewed forward migration compatible with already committed rows.

If the consumer falsely created a delivery because of a code defect, disable the future delivery path and preserve the row for investigation; no HTTP sender exists in this milestone. A later approved correction/replay policy must define how invalid projection evidence is dispositioned without silent deletion. No financial row or ledger invariant is changed by stopping or repairing this consumer.

## Risks and assumptions

| Risk or assumption                                                              | Impact                                                                        | Mitigation/validation                                                                                               | Owner/deadline                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Existing queue contains events older than some endpoints                        | Those endpoints may receive pending projections when the backlog is processed | Explicit processing-time semantics, owner approval, documented rollout, zero/late fanout tests                      | Project owner / before enabling consumer           |
| Inbox has a 30-day baseline but endpoint eligibility cannot be recomputed later | Very late duplicate could create historical fanout                            | Retain Webhooks marker without deletion; marker-level dedupe survives inbox cleanup                                 | Project owner / approved in this plan              |
| Marker retention is currently indefinite                                        | Storage grows with processed events                                           | Minimal bounded bytes/fields, count/age/storage signals, later retention policy that preserves no-historical-fanout | Operations owner / before retention implementation |
| Exact event bytes duplicate outbox/broker data                                  | Additional bounded storage and sensitive-data handling                        | 16 KiB cap, minimum event contract, no logs, retention monitoring                                                   | Webhooks owner / implementation review             |
| Two consumer transactions plus relay/readiness use a five-connection pool       | Pool contention could produce false readiness degradation or latency          | Approved concurrency 2, bounded transactions, real backlog/readiness tests; tune only with evidence                 | Worker owner / before merge                        |
| Repeated serialization/deadlock reaches the three-attempt limit                 | A valid event can enter DLQ under extreme contention                          | Short transaction, correct indexes/order, retry metric, DLQ runbook, controlled future replay                       | Eventing owner / before merge                      |
| RabbitMQ reports broker-managed headers differently on redelivery               | Strict validator could misclassify a valid duplicate                          | Validate only approved application headers and tolerate documented broker diagnostics                               | Eventing owner / contract tests                    |
| Public delivery-ID collision in a multi-endpoint batch                          | Whole projection rolls back                                                   | Named-constraint mapping and at most three complete regeneration attempts                                           | Webhooks owner / before merge                      |
| Future manual replay conflicts with initial endpoint/event uniqueness           | Replay cannot reuse the initial uniqueness model unchanged                    | Defer replay and require an additive schema/Operations plan before implementation                                   | Project owner / replay milestone                   |
| Endpoint disabled after projection but before future HTTP send                  | Delivery disposition is not yet defined                                       | Preserve pending projection; decide in delivery plan before sender code                                             | Project owner / delivery milestone                 |
| Production RabbitMQ permissions are not separated by publisher/consumer role    | Excess broker capability could widen blast radius                             | Document least privilege and decide environment-specific broker users/policies before production-like deployment    | Operations/Security / deployment milestone         |
| Metrics backend and alert thresholds do not yet exist                           | Signals may not page an operator automatically                                | Structured signals/read-only queries/runbook now; destinations/thresholds **To be decided**                         | Operations / before production-like release        |

All material consumer decisions listed by the read-only design review were approved by the project owner on 2026-08-02. There are no unresolved design choices blocking implementation. Environment-specific alerting identities/destinations and later delivery/replay/retention behavior remain explicitly deferred and do not authorize scope expansion.

## Implementation order

1. Reconfirm clean `73887ed` baseline, this approved plan, ADRs, event schema, module boundaries, and financial invariants.
2. Add the Eventing inbox, Webhooks event marker, and pending delivery Prisma models plus one reviewed additive migration with named constraints/indexes/foreign keys and exact `settleflow_app` grants.
3. Generate Prisma and implement the strict consumer-side event/AMQP parser and raw-byte fingerprint contract before RabbitMQ consumption.
4. Implement the Eventing inbox repository/application service with serializable shared transaction, matching/mismatched duplicate results, exact timeouts, and three complete SQL retries.
5. Implement the Webhooks projection port/repository with durable marker, active/subscribed tenant query, zero-fanout behavior, `whd_` generation, and atomic bulk delivery creation.
6. Extract/reuse the approved topology declaration and implement the consumer-owned RabbitMQ connection/channel, prefetch 2, manual ack/reject, reconnect, and failure classification.
7. Compose Eventing and Webhooks in the worker; extend validated environment, readiness, heartbeat/signals, startup, cancel/drain, and close ordering without changing the relay behavior.
8. Add exhaustive Eventing/Webhooks/worker unit tests and update build/test scripts/workspace dependency edges without adding an external dependency.
9. Add real PostgreSQL/RabbitMQ migration, runtime-permission, normal, duplicate, concurrency, crash, outage, poison/DLQ, reconnect, and shutdown tests.
10. Update README, package/event/security documentation and add/index the projection/dead-letter runbook.
11. Run the complete verification matrix, inspect every changed file and migration, record results/deviations in this plan, and confirm the final scope/status before handoff.

## Execution checklist

- [x] Design and boundaries reviewed.
- [x] Required specification/ADR decisions and implementation constants approved by the project owner on 2026-08-02.
- [x] Prisma schema, migration, constraints, indexes, and runtime grants implemented.
- [x] Eventing inbox and strict consumer contract implemented.
- [x] Webhooks marker and initial delivery projection implemented.
- [x] RabbitMQ consumer lifecycle/readiness implemented without topology drift.
- [x] Unit, migration, PostgreSQL/RabbitMQ, concurrency, and failure scenarios pass.
- [x] Security, tenant-isolation, least-privilege, and sensitive-data review pass.
- [x] Existing Payment Intent, endpoint, audit, readiness, and relay regressions pass.
- [x] Documentation and runbooks updated.
- [x] Commands/results and deviations recorded below.

## Verification record

| Command or review                                   | Result | Date/evidence                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline `git status --short --branch` and HEAD     | Pass   | 2026-08-02: clean `## main...origin/main` at `73887ed` before this documentation-only plan change                                                                                                                                                                                                                                                                                                                                         |
| Governance/template and committed design inspection | Pass   | 2026-08-02: PLANS.md, plan template, ADRs, event/topology, schema, Webhooks foundation, worker lifecycle, and prior plans reviewed                                                                                                                                                                                                                                                                                                        |
| Project-owner approval                              | Pass   | 2026-08-02: consumer identity, limits, lifecycle, retry/DLQ, serializable transaction, IDs, marker bytes, and retention explicitly approved                                                                                                                                                                                                                                                                                               |
| Plan-specific Markdown formatting                   | Pass   | 2026-08-02: direct Prettier check passed after formatting only this plan                                                                                                                                                                                                                                                                                                                                                                  |
| Local Markdown-link validation                      | Pass   | 2026-08-02: all 13 Markdown links in this plan resolve locally                                                                                                                                                                                                                                                                                                                                                                            |
| `git diff --check` and untracked whitespace check   | Pass   | 2026-08-02: tracked diff and the new untracked plan contain no whitespace errors                                                                                                                                                                                                                                                                                                                                                          |
| Implementation baseline                             | Pass   | 2026-08-02: clean `main` at `55fc4e0` before implementation                                                                                                                                                                                                                                                                                                                                                                               |
| Pinned install                                      | Pass   | `corepack pnpm@11.18.0 install`; all 10 workspace projects current and lockfile policy passed                                                                                                                                                                                                                                                                                                                                             |
| Prisma/local migration                              | Pass   | Prisma 7.9.1 validate/generate; Compose PostgreSQL/RabbitMQ healthy; migration `20260802092702_payment_created_webhook_projection_consumer` applied; 5 migrations up to date                                                                                                                                                                                                                                                              |
| Formatting, lint, and type-check                    | Pass   | Full `format:check`, `lint`, and `typecheck` passed after final implementation                                                                                                                                                                                                                                                                                                                                                            |
| Unit and contract tests                             | Pass   | Full 8-project unit run: 27 suites/106 tests; focused event contract: 15 tests; strict consumer parser additionally covers raw unsafe fractional and duplicate-key input                                                                                                                                                                                                                                                                  |
| Real PostgreSQL/RabbitMQ integration                | Pass   | Full integration rerun: 7 suites/43 tests; focused projection consumer: 3 tests proving commit-before-ack, duplicate/zero-fanout, tenant eligibility, poison DLQ, and runtime immutability                                                                                                                                                                                                                                                |
| Production builds and OpenAPI                       | Pass   | API and worker production builds passed; committed OpenAPI check passed with no API operation change                                                                                                                                                                                                                                                                                                                                      |
| Worker runtime/lifecycle smoke                      | Pass   | Healthy Compose startup reported PostgreSQL, publisher, and active consumer `up`; readiness `ready`; Nest application close completed cleanly                                                                                                                                                                                                                                                                                             |
| Documentation and local links                       | Pass   | Prettier passed; all 27 local links in changed Markdown resolve; README/event/security/runbook guidance updated                                                                                                                                                                                                                                                                                                                           |
| Verification deviations                             | Pass   | First full integration run exposed one timing-sensitive pre-existing Payment Intent storm HTTP 500; unchanged isolated test and complete rerun passed. `pnpm build` nested global pnpm 10.32.1 locally; equivalent pinned Corepack 11.18.0 build stages and both deployable build scripts passed. Windows child-process `SIGTERM` terminated directly, so graceful close was verified through Nest lifecycle plus unit shutdown ordering. |

## Definition of done

Implementation under this plan is complete only when:

- the worker consumes only `settleflow.webhook-projection.payment-created.v1` through a separately owned channel/connection with prefetch/concurrency 2 and no topology drift;
- every application-controlled AMQP field and exact nine-field payload is validated under the approved 16 KiB limit before persistence;
- Eventing-owned inbox uniqueness and the Webhooks-owned retained marker jointly prevent duplicate and post-retention historical fanout;
- one serializable transaction commits inbox completion, exact validated event bytes, processing-time endpoint eligibility, and the complete set of unique pending `whd_` deliveries, including a durable zero-endpoint result;
- acknowledgement occurs only after commit, crash at either boundary is safe, dependency failure remains unacknowledged/recoverable, and invalid/unsupported or exhausted poison reaches the existing DLQ;
- worker readiness requires PostgreSQL, the existing publisher-confirm path, and an actively registered projection consumer, while shutdown cancels and drains for 10 seconds before closing RabbitMQ and Prisma;
- new schema objects use named constraints/indexes/foreign keys and least-privilege runtime grants, with empty/upgrade migration and permission evidence;
- exhaustive unit and real PostgreSQL/RabbitMQ tests prove normal, duplicate, race, crash, outage, reconnect, poison, DLQ, and shutdown behavior with no cross-merchant effect;
- no HTTP request/signing/delivery attempt/retry/replay, financial behavior, new API/OpenAPI operation, external dependency, Compose change, or destructive retention enters the implementation diff;
- documentation and runbooks contain exact safe diagnostics/recovery and prohibited actions, and the full formatting, lint, type, test, build, OpenAPI, migration, link, whitespace, and status gates pass;
- this plan records final commands/results/deviations and no commit or push occurs unless separately authorized.
