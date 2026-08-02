# Domain event contracts

SettleFlow publishes versioned domain events from the PostgreSQL transactional outbox. PostgreSQL remains authoritative; RabbitMQ delivery is at least once. A confirmed event can be delivered more than once when a process fails after broker confirmation but before `published_at` is recorded. Consumers must deduplicate by `(consumer_name, messageId)` before applying a state-changing effect.

## `payment.created.v1`

The versioned body contract is [payment.created.v1.schema.json](payment.created.v1.schema.json). Its body contains exactly nine fields and no credentials, authorization data, idempotency key, `externalRef`, request/response body, response snapshot, internal Payment Intent UUID, provider data, or settlement state.

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

The worker publishes through durable topic exchange `settleflow.domain-events` with routing key `payment.created.v1` and consumes durable quorum queue `settleflow.webhook-projection.payment-created.v1` through a separate channel/connection with prefetch 2. Invalid or unsupported messages dead-letter through `settleflow.dead-letter` to quorum queue `settleflow.webhook-projection.payment-created.v1.dlq` using the consumer queue name as the dead-letter routing key.

AMQP `messageId` is the stable body `eventId`, `type` is `payment.created.v1`, and `correlationId` is `requestId`. Persistent delivery, the original timestamp, application ID `settleflow-worker`, schema version, aggregate type/ID, merchant ID, and publish attempt are carried in the approved properties and headers. Delivery tags and attempt counts are diagnostics, not logical identities.

The consumer accepts no body larger than 16 KiB and validates exact UTF-8 JSON bytes, the nine-field payload, and every application-controlled property/header before persistence. Its durable identity is `(webhook-projection.payment-created.v1, messageId)`. One serializable transaction inserts completed inbox evidence, retains the exact validated bytes and SHA-256 fingerprint in the Webhooks marker, evaluates active/subscribed endpoints for that merchant, and inserts pending projections. A matching duplicate is acknowledged without another effect; an identity/fingerprint conflict is poison. RabbitMQ acknowledgement occurs only after the transaction commits.

Run `pnpm test:event-contract` after changing the schema, serializer, example, or metadata mapping. A new field, event type, or incompatible semantic change requires a new version and a reviewed producer/relay/consumer rollout; never silently change this `v1` contract.
