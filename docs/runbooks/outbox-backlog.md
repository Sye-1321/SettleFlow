# Outbox backlog and relay recovery

## Purpose and trigger

Use this runbook when the worker is not ready, `outbox.relay.dependency_unavailable`, `outbox.topology.failed`, returned/timeout signals, or an increasing unpublished backlog indicates that `payment.created.v1`, `payment.captured.v1`, or `payment.refunded.v1` delivery is delayed. The specification release target is publish-lag p95 below 10 seconds while RabbitMQ is healthy; the production alert threshold and severity remain **To be decided** by the Operations owner.

Required role: read-only database and RabbitMQ diagnostic access. Any deployment restart, credential change, topology migration, or future manual replay requires the environment's authorized operator role and incident change record; those environment-specific identities are **To be decided**.

## Safety rules

PostgreSQL `outbox_events` is authoritative event intent. RabbitMQ is at-least-once transport. Preserve both while diagnosing.

Never:

- edit or delete an unpublished outbox row, its payload, event ID, attempt count, lease, availability, or publication timestamp;
- clear `published_at` to force replay or generate a replacement event ID;
- purge or delete a queue containing messages, auto-recreate conflicting production topology, or move messages by hand;
- patch Payment Intent, ledger, balance, settlement, audit, inbox, or webhook state;
- expose payloads, API keys, idempotency keys, credentials, connection URLs, or response snapshots in tickets or logs.

## Diagnose

Record the incident time, environment, deployed revision, worker readiness transition, and safe event/correlation identifiers. Communication owner and incident system are **To be decided**.

For the local reference environment, inspect process/container state and bounded relay signals:

```shell
pnpm infra:ps
pnpm infra:logs
docker compose exec rabbitmq rabbitmq-diagnostics -q ping
docker compose exec rabbitmq rabbitmqctl -p settleflow list_exchanges name type durable
docker compose exec rabbitmq rabbitmqctl -p settleflow list_queues name type state messages_ready messages_unacknowledged
```

Run these read-only PostgreSQL queries locally. Use the approved read-only query interface in other environments; never paste credentials into a command:

```shell
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT count(*) AS pending_count, min(created_at) AS oldest_created_at, extract(epoch FROM (clock_timestamp() - min(created_at)))::bigint AS oldest_age_seconds FROM outbox_events WHERE published_at IS NULL;"
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT count(*) FILTER (WHERE available_at <= clock_timestamp()) AS due_count, count(*) FILTER (WHERE lease_expires_at > clock_timestamp()) AS active_leases, count(*) FILTER (WHERE lease_expires_at <= clock_timestamp()) AS expired_leases FROM outbox_events WHERE published_at IS NULL;"
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT attempt_count, count(*) AS events FROM outbox_events WHERE published_at IS NULL GROUP BY attempt_count ORDER BY attempt_count;"
```

Inspect only identifiers and timing columns for a specific event. Do not select `payload`:

```shell
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT event_id, event_type, aggregate_id, request_id, available_at, attempt_count, locked_at, lease_expires_at, published_at FROM outbox_events WHERE event_id = 'evt_REPLACE_WITH_APPROVED_IDENTIFIER';"
```

Interpretation:

- pending and unleased before RabbitMQ readiness: expected; the relay deliberately does not claim;
- active lease under 30 seconds: allow the bounded publish/finalize cycle to finish;
- expired lease: recoverable by any healthy relay instance, without an operator row edit;
- increasing attempts with topology failures or returned messages: compare the declared exchange, binding, queue type, and DLX arguments with [the event contract](../events/README.md);
- growing consumer queue with published rows: the projection consumer is unavailable or falling behind; use the [Webhook projection consumer runbook](webhook-projection-consumer.md) without purging or moving messages;
- DLQ messages: the consumer rejected poison or exhausted its bounded safe processing retries; classify through the Webhook projection runbook without purging it.

## Contain and recover

1. If PostgreSQL or RabbitMQ is unhealthy, restore that service through its approved platform procedure. Do not keep restarting the worker against a known topology conflict.
2. If topology declaration conflicts, leave the queue and messages intact. Capture read-only definitions, stop the affected relay deployment, compare them with the approved contract, and prepare a separately reviewed additive/forward topology change.
3. If credentials or permissions are invalid, rotate or correct them through the environment secret manager. Never place credentials in repository files, commands, logs, or the incident record.
4. Once both dependencies and topology are healthy, start one worker instance. Readiness must require PostgreSQL, a healthy publisher confirm channel, complete topology, and an active projection consumer registration.
5. Allow expired leases and due retry times to be reclaimed automatically. Unlimited transient retries use full jitter capped at 60 seconds; do not bypass the delay by editing rows.
6. Scale relay workers only through the approved deployment process. `FOR UPDATE SKIP LOCKED` provides disjoint active claims, but duplicates remain possible after confirmation-before-mark failure.

There is no operator replay command in this milestone. If automatic lease recovery cannot progress, preserve state and escalate for a controlled forward code/configuration fix. Manual replay remains deferred and would require authentication, reason capture, audit, and separate approval.

## Validate and close

Repeat the read-only backlog queries until due and expired-lease counts return to zero and oldest pending age is within the approved threshold. Confirm:

- worker readiness is `ready` and recent signals include `outbox.topology.ready`;
- `outbox.publish.confirmed` and `outbox.finalize.completed` resume;
- no event was falsely marked published during the outage;
- any duplicate retained its original `messageId`/event ID;
- consumer queue depth falls as completed inbox/marker/delivery counts rise consistently;
- Payment Intent API behavior and financial invariants remain unchanged.

Escalate immediately if an unpublished row cannot be reclaimed after dependency recovery, topology remains incompatible, the pending index is not used, publish lag stays above the approved target, data was edited/purged, or a financial/audit invariant may be affected. Record root cause, customer/merchant impact, duplicate-delivery impact, commands and timestamps, the authorized recovery action, and follow-up work.

Owner: SettleFlow Operations/Eventing maintainers. Review cadence: after every relay schema, topology, retry, readiness, or deployment change and at least quarterly. Last exercised: 2026-08-01 through disposable PostgreSQL/RabbitMQ outage, return, lease-expiry, duplicate, and catch-up integration tests; environment evidence link is **To be decided**.
