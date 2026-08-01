# M1 Payment Intent API

This slice exposes only specification-authorized creation and merchant-owned retrieval. It creates simulated payment state and durable event intent; it never moves funds and does not publish to RabbitMQ.

## Routes

| Route                          | Required scope   | Success |
| ------------------------------ | ---------------- | ------- |
| `POST /v1/payment-intents`     | `payments:write` | 201     |
| `GET /v1/payment-intents/{id}` | `payments:read`  | 200     |

Both routes require `Authorization: Bearer <merchant_api_key>`. POST also requires exactly one `Idempotency-Key` header of 1-255 scalar characters with no surrounding whitespace or control characters. The authenticated merchant ID is the sole ownership source; it is never accepted in a body or query.

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

A success returns a `pi_<ULID>` identifier, the accepted creation fields, lowercase `paymentStatus: "created"`, derived `settlementStatus: "NOT_ELIGIBLE"`, zero captured/refunded projections, version zero, and UTC timestamps. Settlement status is not stored on `payment_intents`.

## Idempotency and durable event intent

The key is SHA-256 hashed at rest and scoped by merchant, method, and normalized route. The validated command is canonically fingerprinted. Creation commits the Payment Intent, completed response snapshot, and one exact nine-field `payment.created.v1` outbox row in a single PostgreSQL transaction.

- Same key and fingerprint: replay the stored 201 representation without a second payment or event.
- Same key with changed fingerprint: `409 idempotency_key_reused`.
- Same key while an unexpired owner is active: `409 idempotency_request_in_progress` with `Retry-After: 1`.
- Expired in-progress lease: one conditional takeover may finish the command.
- Different key with the same merchant `externalRef`: a durable, replayable `409 external_reference_conflict` result.

M1 does not relay or publish the outbox row. RabbitMQ availability remains part of API readiness, but no broker interaction occurs in the create transaction.

For safe local diagnosis, use `pnpm db:inspect` and correlate only with the public payment ID or validated request ID. Never copy API-key hashes, idempotency hashes, response snapshots, or raw payloads into logs or tickets. Do not manually update/delete payment, idempotency, or unpublished outbox rows. An abandoned in-progress request becomes eligible for conditional takeover after its lease expires; retry the same validated command with the same key. Privileged replay/repair tooling is deferred and must not be improvised with SQL.

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

The PostgreSQL integration suite covers atomic persistence, replay and changed-key conflicts, active/stale owners, concurrent same-key requests, external-reference races, exact number handling, scopes, tenant isolation, problem responses, and OpenAPI metadata.
