# Webhook projection consumer and dead-letter recovery

## Purpose and trigger

Use this runbook when worker readiness reports the RabbitMQ projection consumer down, `webhook.projection.consumer.unavailable` or reconnect signals persist, the `settleflow.webhook-projection.payment-created.v1` queue grows, pending projections stop advancing, or the `.dlq` count/age rises.

Severity, paging thresholds, alert destination, incident system, and authorized production operator identities are **To be decided**. Required access is read-only PostgreSQL/RabbitMQ diagnostics; deployment, credential, topology, or future replay actions require the environment's authorized operator and change record.

## Safety rules

PostgreSQL inbox, marker, and delivery rows are durable processing evidence. RabbitMQ messages are at-least-once transport. Preserve both.

Never:

- purge, delete, shovel, republish, or manually move the consumer queue or DLQ;
- update, delete, truncate, or synthesize inbox, event-marker, delivery, endpoint, outbox, audit, payment, ledger, balance, or settlement rows;
- change a message ID, event ID, payload, fingerprint, tenant, delivery ID, subscription, or endpoint status to force processing;
- expose exact event bytes, URLs, encrypted secrets, credentials, API/idempotency keys, or connection strings in logs or incident records;
- treat an endpoint activated after event processing as historically eligible;
- send an HTTP webhook from an operator shell. HTTP delivery and authorized replay tooling are not implemented.

## Diagnose safely

Record incident time, environment, deployed revision, worker readiness checks, safe event/request/delivery IDs, and the observed signal code. Inspect local RabbitMQ health and queue depth:

```shell
pnpm infra:ps
docker compose exec rabbitmq rabbitmq-diagnostics -q ping
docker compose exec rabbitmq rabbitmqctl -p settleflow list_queues name type state consumers messages_ready messages_unacknowledged
```

Use the approved read-only query interface outside local development. These local queries expose identifiers and bounded timing/count data, not payload bytes or endpoint destinations:

```shell
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT count(*) AS completed_count, min(completed_at) AS oldest_completion FROM inbox_messages WHERE consumer_name = 'webhook-projection.payment-created.v1';"
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT count(*) AS projected_count, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id = p.event_id)) AS zero_delivery_events, min(projected_at) AS oldest_projection FROM webhook_event_projections p;"
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT count(*) AS pending_count, min(next_attempt_at) AS oldest_next_attempt_at FROM webhook_deliveries WHERE status = 'pending';"
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT p.event_id, p.payment_id, p.request_id, p.projected_at, d.public_id AS delivery_id, d.created_at FROM webhook_event_projections p LEFT JOIN webhook_deliveries d ON d.event_id = p.event_id AND d.merchant_id = p.merchant_id WHERE p.event_id = 'evt_REPLACE_WITH_APPROVED_IDENTIFIER' ORDER BY d.id;"
```

Interpretation:

- ready messages with no active consumer: inspect the separate consumer connection, topology declaration, credentials, and worker registration;
- unacknowledged messages: allow the bounded serializable transaction or 10-second shutdown drain to finish; after connection loss RabbitMQ requeues them;
- matching inbox and marker with no delivery can be a valid zero-endpoint result;
- one marker with endpoint/event-unique pending rows is a completed projection; repeated broker delivery must not add effects;
- DLQ growth with contract/fingerprint/error codes is poison or exhausted safe retries, not authority to replay;
- PostgreSQL/RabbitMQ outage or connection closure is transient; the message remains unacknowledged and reconnect uses full jitter from one to 60 seconds.

## Contain and recover

1. If message contents or credentials may have leaked, restrict access and follow the security incident process before ordinary recovery.
2. Restore PostgreSQL or RabbitMQ using its approved platform procedure. Do not repeatedly restart against a known schema, permission, or topology conflict.
3. For a topology conflict, stop the affected worker, capture read-only exchange/queue/binding definitions, and prepare a reviewed forward-compatible correction. Preserve both queues.
4. For a database migration or permission error, compare the committed migration and `settleflow_app` grants. Apply only the reviewed owner migration/provisioning workflow; never grant ownership or row mutation as a workaround.
5. Start one worker. It becomes ready only when PostgreSQL, the publisher-confirm path, complete topology, and active consumer registration are all healthy.
6. Let broker redelivery and inbox/marker deduplication recover automatically. Serialization/deadlock handling retries the complete transaction three times; connection recovery uses capped full jitter.
7. If a poison message remains in the DLQ, preserve it and escalate for a code/contract correction plus a future authenticated, reasoned, Operations-audited replay capability. No such replay command exists in this milestone.

## Validate and close

Confirm all of the following with read-only evidence:

- worker readiness is `ready` and signals show consumer registration plus resumed received/processed or duplicate outcomes;
- consumer ready/unacknowledged counts return to their normal bounds and new valid events advance inbox and marker counts;
- each event has at most one retained marker and each endpoint/event pair has at most one pending delivery;
- cross-merchant, inactive, or not-subscribed endpoints received no projection, while zero-endpoint events retained a marker;
- no row, queue, message identity, endpoint lifecycle, Payment Intent behavior, or financial invariant was manually changed;
- DLQ depth is unchanged unless an approved future replay procedure explicitly records disposition.

Escalate immediately for identity/fingerprint conflict, repeated transaction retry exhaustion, unexpected tenant fanout, missing marker after acknowledgement, topology incompatibility, runtime mutation privilege, payload/secret exposure, manual data/queue changes, or possible financial/audit impact. Record root cause, scope, timestamps, safe identifiers, authorized actions, and follow-up work.

Owner: SettleFlow Eventing/Webhooks/Operations maintainers. Review cadence: after consumer contract, schema, topology, retry, readiness, or replay policy changes and at least quarterly. Last exercised: 2026-08-02 through disposable PostgreSQL 18/RabbitMQ 4.3 commit-before-ack, duplicate, tenant eligibility, zero-fanout, poison-DLQ, and runtime-permission integration tests; environment evidence link is **To be decided**.
