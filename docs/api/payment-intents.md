# M1 Payment Intent API

This slice exposes specification-authorized creation, merchant-owned retrieval, deterministic direct full capture, and full/partial refunds. All behavior is simulated: it records immutable balanced accounting and durable event intent but never moves real funds or calls a payment rail.

## Routes

| Route                                   | Required scope   | Success |
| --------------------------------------- | ---------------- | ------- |
| `POST /v1/payment-intents`              | `payments:write` | 201     |
| `POST /v1/payment-intents/{id}/capture` | `payments:write` | 200     |
| `POST /v1/payment-intents/{id}/refunds` | `payments:write` | 201     |
| `GET /v1/payment-intents/{id}`          | `payments:read`  | 200     |

All routes require `Authorization: Bearer <merchant_api_key>`. Every POST also requires exactly one `Idempotency-Key` header of 1-255 scalar characters with no surrounding whitespace or control characters. The authenticated merchant ID is the sole ownership source; it is never accepted in a body or query.

The committed machine-readable contract is [openapi.json](openapi.json). Swagger UI is available at `/docs` while the API is running.

## Create contract

The JSON body contains exactly these fields:

```json
{
  "externalRef": "order_1001",
  "amountMinor": 125000,
  "currency": "ETB",
  "captureMethod": "manual"
}
```

- `externalRef` is case-sensitive, 1-255 Unicode scalar values, preserved exactly, and unique within one merchant.
- `amountMinor` is an exact integer from 1 through 9,007,199,254,740,991. Equivalent JSON-number forms such as `1000`, `1000.0`, and `1e3` canonicalize to the same integer. Fractional or unsafe values are rejected before JavaScript number conversion.
- `currency` is exactly `ETB` or `USD`.
- `captureMethod` is exactly lowercase `manual`.
- Unknown, duplicate, missing, merchant-owned, lifecycle, projection, identifier, provider, or timestamp fields are rejected.

A success returns a `pi_<ULID>` identifier, the accepted creation fields, lowercase `paymentStatus: "created"`, derived `settlementStatus: "NOT_ELIGIBLE"`, zero captured/refunded projections, version zero, and UTC timestamps. Later reads compose the Settlement-owned lifecycle as `NOT_ELIGIBLE`, `ELIGIBLE`, `BATCHED`, `SETTLED`, or `ADJUSTMENT_PENDING`; settlement status is never stored on `payment_intents`.

## Direct full capture

`POST /v1/payment-intents/{id}/capture` accepts exactly:

```json
{
  "amountMinor": 125000,
  "currency": "ETB"
}
```

The Payment Intent must be merchant-owned and `created`; currency must match and `amountMinor` must equal the entire requested amount. Partial capture is not supported. The deterministic mock provider approves valid commands by default and performs no I/O. A 200 response is the Payment Intent representation in `captured` state plus an `ltx_<ULID>` `ledgerTransactionId`. Capture debits `provider_clearing` and credits `merchant_payable` in one currency. `capturedAt` and internal `availableAt` use the same transaction timestamp; no settlement-status column is added.

## Full and partial refunds

`POST /v1/payment-intents/{id}/refunds` accepts exactly:

```json
{
  "externalRef": "refund_1001",
  "amountMinor": 25000,
  "currency": "ETB"
}
```

The Payment Intent must be captured or partially refunded, and amount/currency follow the same lossless rules as creation. The amount cannot exceed `capturedAmountMinor - refundedAmountMinor`. Each success creates an immutable `rf_<ULID>` Refund and an `ltx_<ULID>` Ledger transaction, returns 201, and reports `paymentStatus` as `partially_refunded` or `refunded` plus the exact cumulative refunded amount. Refund posting debits `merchant_payable` and credits `provider_clearing`. Refund external references are case-sensitive and unique per merchant.

## Idempotency and durable event intent

The key is SHA-256 hashed at rest and scoped by merchant, method, and normalized route. The validated command is canonically fingerprinted. Each successful create/capture/refund commits its Payment/Refund state, completed response snapshot, one exact outbox row, and—where applicable—the immutable balanced Ledger posting in one PostgreSQL transaction.

- Same key and fingerprint: replay the stored response with its original 200 or 201 status without a second financial effect or event.
- Same key with changed fingerprint: `409 idempotency_key_reused`.
- Same key while an unexpired owner is active: `409 idempotency_request_in_progress` with `Retry-After: 1`.
- Expired in-progress lease: one conditional takeover may finish the command.
- Different key with the same merchant Payment/Refund `externalRef`: a durable, replayable conflict result.
- Different capture keys racing one Payment Intent: exactly one can capture; locked losers receive `409 payment_intent_not_capturable` without a second posting or event.
- Concurrent refunds: the payment row lock and database constraints prevent their committed sum from exceeding capture.

The API never contacts RabbitMQ in a financial transaction. The worker later relays `payment.created.v1`, `payment.captured.v1`, and `payment.refunded.v1` at least once after publisher confirmation. Webhook projection and signed delivery remain asynchronous.

For safe local diagnosis, use `pnpm db:inspect` and correlate only with public payment/refund/ledger/event IDs or a validated request ID. Never copy API-key hashes, idempotency hashes, response snapshots, amounts, external references, or raw payloads into logs or tickets. Do not manually update/delete Payment, Refund, Ledger, idempotency, or outbox evidence. An abandoned in-progress request becomes eligible for conditional takeover after its lease expires; retry the exact command with the same key. Use the [capture/refund recovery runbook](../runbooks/payment-capture-and-refunds.md) for invariant failures.

## Errors and correlation

Every API error uses `application/problem+json` with RFC 9457 fields `type`, `title`, `status`, safe `detail`, stable `code`, and `requestId`. Missing/foreign-merchant reads both return `404 payment_intent_not_found`. Problems never expose credentials, keys, rejected values, raw bodies, SQL, constraints, or stack traces.

A caller may supply one `X-Request-Id` containing 1-128 characters from `[A-Za-z0-9._:-]`. Missing, duplicate, or invalid values are replaced with a high-entropy `req_` value. Each HTTP attempt gets its current request ID; the winning create request ID remains in the outbox event.

## Verification

```shell
pnpm test:payments
pnpm test:api
pnpm test:integration
pnpm openapi:check
```

The PostgreSQL integration suite covers atomic Payment/Refund/Ledger/outbox/snapshot persistence, replay and changed-key conflicts, active/stale owners, 50-way capture contention, concurrent over-refund prevention, exact number handling, scopes, tenant isolation, problem responses, and OpenAPI metadata. RabbitMQ integration proves routing, exact-byte projection, and durable deduplication for all three events.
