# Domain event contracts

SettleFlow publishes versioned domain events from the PostgreSQL transactional outbox. PostgreSQL remains authoritative; RabbitMQ delivery is at least once. A confirmed event can be delivered more than once when a process fails after broker confirmation but before `published_at` is recorded. Consumers must deduplicate by `(consumer_name, messageId)` before applying a state-changing effect.

## `payment.created.v1`

The versioned body contract is [payment.created.v1.schema.json](payment.created.v1.schema.json). Its body contains exactly nine fields.

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

## `payment.captured.v1` and `payment.refunded.v1`

The exact contracts are [payment.captured.v1.schema.json](payment.captured.v1.schema.json) and [payment.refunded.v1.schema.json](payment.refunded.v1.schema.json). Capture contains exactly ten fields; refund contains exactly eleven. Capture `availableOn` equals `occurredAt` for the deterministic direct-capture simulation. Refund `cumulativeRefundedAmountMinor` is at least the event amount and never exceeds the captured amount enforced by the financial transaction.

```json
{
  "eventId": "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "eventType": "payment.captured.v1",
  "occurredAt": "2026-08-02T10:20:12.345Z",
  "requestId": "req_capture_example",
  "merchantId": "11111111-1111-4111-8111-111111111111",
  "paymentId": "pi_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "capturedAmountMinor": 125000,
  "currency": "ETB",
  "availableOn": "2026-08-02T10:20:12.345Z",
  "ledgerTransactionId": "ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV"
}
```

```json
{
  "eventId": "evt_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "eventType": "payment.refunded.v1",
  "occurredAt": "2026-08-02T11:20:12.345Z",
  "requestId": "req_refund_example",
  "merchantId": "11111111-1111-4111-8111-111111111111",
  "paymentId": "pi_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "refundId": "rf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "amountMinor": 25000,
  "currency": "ETB",
  "cumulativeRefundedAmountMinor": 25000,
  "ledgerTransactionId": "ltx_01ARZ3NDEKTSV4RRFFQ69G5FAW"
}
```

All three bodies exclude credentials, authorization data, idempotency keys, `externalRef`, response snapshots, internal UUIDs, provider data, and settlement state.

## `settlement.finalized.v1` and `reconciliation.completed.v1`

The exact contracts are [settlement.finalized.v1.schema.json](settlement.finalized.v1.schema.json) and [reconciliation.completed.v1.schema.json](reconciliation.completed.v1.schema.json). Settlement finalization represents internal simulated clearing only; it is not a bank payout confirmation. Reconciliation completion summarizes a bounded mock-provider comparison and never carries raw CSV rows, external/provider references, credentials, idempotency material, or internal UUIDs.

```json
{
  "eventId": "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "eventType": "settlement.finalized.v1",
  "occurredAt": "2026-08-03T10:20:12.345Z",
  "requestId": "req_settlement_example",
  "merchantId": "11111111-1111-4111-8111-111111111111",
  "batchId": "stb_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "cutoffAt": "2026-08-01T21:00:00.000Z",
  "grossAmountMinor": 120000,
  "feeAmountMinor": 3000,
  "netAmountMinor": 117000,
  "currency": "ETB",
  "itemCount": 1
}
```

```json
{
  "eventId": "evt_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "eventType": "reconciliation.completed.v1",
  "occurredAt": "2026-08-03T10:30:12.345Z",
  "requestId": "req_reconciliation_example",
  "merchantId": "11111111-1111-4111-8111-111111111111",
  "importId": "rec_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "matchedExactCount": 4,
  "mismatchCount": 1,
  "unexplainedDifferenceMinorByCurrency": { "ETB": -500, "USD": 0 }
}
```

## RabbitMQ and projection contract

The worker declares durable topic exchange `settleflow.domain-events`, with one routing key and durable quorum queue per event:

| Routing key                   | Projection queue                                            | Dead-letter queue                                               |
| ----------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| `payment.created.v1`          | `settleflow.webhook-projection.payment-created.v1`          | `settleflow.webhook-projection.payment-created.v1.dlq`          |
| `payment.captured.v1`         | `settleflow.webhook-projection.payment-captured.v1`         | `settleflow.webhook-projection.payment-captured.v1.dlq`         |
| `payment.refunded.v1`         | `settleflow.webhook-projection.payment-refunded.v1`         | `settleflow.webhook-projection.payment-refunded.v1.dlq`         |
| `settlement.finalized.v1`     | `settleflow.webhook-projection.settlement-finalized.v1`     | `settleflow.webhook-projection.settlement-finalized.v1.dlq`     |
| `reconciliation.completed.v1` | `settleflow.webhook-projection.reconciliation-completed.v1` | `settleflow.webhook-projection.reconciliation-completed.v1.dlq` |

All use durable topic DLX `settleflow.dead-letter` and the consumer queue name as the dead-letter routing key. The projection consumer uses a separate connection/channel with prefetch 2 and registers all three queues before readiness.

AMQP `messageId` is the stable body `eventId`, `type` and routing key equal the body `eventType`, and `correlationId` is `requestId`. Persistent delivery, the original timestamp, application ID `settleflow-worker`, schema version, aggregate type/ID, merchant ID, and publish attempt are carried in the approved properties and headers. Delivery tags and attempt counts are diagnostics, not logical identities.

The consumer accepts no body larger than 16 KiB and validates exact UTF-8 JSON, the event-specific exact field set, and every application-controlled property/header before persistence. Durable consumer identity is `(webhook-projection.<payment-event-name>.v1, messageId)`. One serializable transaction inserts completed inbox evidence, retains the exact validated bytes and SHA-256 fingerprint in the Webhooks marker, evaluates active/subscribed endpoints for that merchant and event type, and inserts pending projections. A matching duplicate is acknowledged without another effect; an identity/fingerprint conflict is poison. RabbitMQ acknowledgement occurs only after the transaction commits.

## Signed HTTP delivery

The outbound `POST` body is the exact retained event byte sequence; SettleFlow does not parse and reserialize it. Each request carries `Content-Type: application/json`, `User-Agent: SettleFlow-Webhooks/1.0`, `SettleFlow-Webhook-Id`, `SettleFlow-Event-Id`, `SettleFlow-Event-Type`, `SettleFlow-Event-Schema-Version`, `SettleFlow-Timestamp`, and `SettleFlow-Signature`, plus the exact byte `Content-Length`.

For each eligible secret, the `v1` signature is the unpadded base64url HMAC-SHA-256 of:

```text
ASCII(timestamp) + "." + ASCII(deliveryId) + "." + rawBodyBytes
```

`SettleFlow-Signature` is `v1,<current-signature>` or, during an unexpired rotation overlap, `v1,<current-signature>;v1,<previous-signature>` in that order and without whitespace. A receiver must read the raw request bytes, require the event/delivery headers to match the body and supported contract, reject timestamps outside a five-minute default recency window, calculate candidate HMACs, compare equal-length values in constant time, and durably deduplicate by `SettleFlow-Webhook-Id` before applying an effect. The stable event ID alone is not a delivery-attempt identifier. An automatic retry keeps the same delivery ID and exact body but gets a new timestamp/signature.

The sender follows no redirects and treats delivery as at least once: a remote system can accept a request before SettleFlow loses the response or its final database write. Receivers must therefore make the durable deduplication write and their business effect atomic. Do not parse JSON before verifying the signature over the original bytes.

Run `pnpm test:event-contract` after changing a schema, serializer, example, route, or metadata mapping. A new field or incompatible semantic change requires a new version and a reviewed producer/relay/consumer rollout; never silently change a `v1` contract.
