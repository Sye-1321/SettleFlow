# ADR-0018: Signed webhook delivery contract

- **Status:** Accepted
- **Date:** 2026-08-02
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through Signed HTTP Webhook Delivery approval
- **Supersedes:** None
- **Superseded by:** None

## Context

SettleFlow must deliver `payment.created.v1` to merchant webhook endpoints as signed HTTP requests. The projection consumer already retains the exact validated event bytes, a stable event ID, and a stable `whd_<ULID>` delivery ID. The endpoint foundation encrypts one current signing secret and may retain one immediately previous secret for an exact 24-hour overlap.

The specification requires HMAC-SHA-256 over exact serialized UTF-8 bytes, a delivery ID, event ID, schema version, timestamp, constant-time verification, and a five-minute default verifier recency window. It gives a single-secret signature example but leaves the exact HTTP header set and current/previous overlap representation unresolved. [ADR-0015](0015-webhook-signing-secret-encryption-and-rotation.md) explicitly defers that representation until HTTP delivery.

The contract must be fixed before sender code exists. Re-serializing the event, wrapping it in another envelope, or choosing an implicit multi-secret syntax would create signature drift and an unstable merchant integration surface.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): FR-09, FR-10, initial event catalog, webhook envelope and signature, secret lifecycle, webhook threat model, and contract/security verification gates.
- [Module boundaries](../architecture/module-boundaries.md)
- [Financial invariants](../architecture/financial-invariants.md)
- [ADR-0004](0004-rabbitmq-outbox-inbox-and-message-delivery.md)
- [ADR-0013](0013-problem-details-audit-and-retention-boundaries.md)
- [ADR-0014](0014-webhook-endpoint-url-and-ssrf-policy.md)
- [ADR-0015](0015-webhook-signing-secret-encryption-and-rotation.md)
- [`payment.created.v1` event contract](../events/README.md)
- [`payment.created.v1` projection-consumer plan](../plans/2026-08-02-payment-created-webhook-projection-consumer.md)

This ADR refines an implementation detail left open by the specification and ADR-0015. It does not require a specification version change.

## Decision drivers

- Sign exactly the bytes the worker sends.
- Preserve the committed `payment.created.v1` v1 contract without reconstruction or a second source of truth.
- Give merchant receivers stable correlation, verification, replay-protection, and deduplication inputs.
- Support the accepted 24-hour current/previous secret overlap without exposing signing material.
- Keep automatic retries compatible and explicitly at least once.
- Keep secrets, signatures, payloads, and sensitive destination data out of persistence and telemetry except where the specification already authorizes bounded event evidence.

## Considered options

### Option A: Exact retained body with one versioned signature header containing current and optional previous signatures

Send the exact bytes retained by the Webhooks projection. Put stable delivery/event metadata in explicit headers. Sign one canonical timestamp/delivery/body input with the current secret and, while eligible, the previous secret. Encode both signatures deterministically in one versioned header.

### Option B: Reconstruct or wrap the event at delivery time

Re-serializing database fields or adding a webhook-specific JSON wrapper could change property order, number representation, whitespace, or future compatibility. It would also create a second payload definition and weaken the exact-byte guarantee. This option is rejected.

### Option C: Sign only with the current secret after rotation

This would make a merchant cut over its verifier immediately and would not implement ADR-0015's approved previous-secret overlap. It is rejected.

### Option D: Use separate duplicate signature headers or expose secret versions

Repeated headers may be coalesced inconsistently by HTTP intermediaries, while public secret-version identifiers are unnecessary for verification. This option is rejected in favor of one deterministic header containing ordered signature entries.

## Decision

The decision is **Option A**.

### HTTP body

- The HTTP request method is `POST`.
- The body is the exact validated UTF-8 bytes retained in `webhook_event_projections.payload_bytes` for the delivery's `payment.created.v1` event.
- The sender does not parse and re-serialize those bytes, query Payments or the outbox to rebuild them, add an outer webhook envelope, or change the nine-field event.
- The body remains bounded by the committed 16 KiB projection contract.
- Automatic retries for one delivery reuse the same delivery ID and exact body bytes.

### Required request headers

| Header                            | Exact value                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `Content-Type`                    | `application/json`                                                                |
| `User-Agent`                      | `SettleFlow-Webhooks/1.0`                                                         |
| `SettleFlow-Webhook-Id`           | Stable `whd_<ULID>` delivery public ID                                            |
| `SettleFlow-Event-Id`             | Stable `evt_<ULID>` event ID, equal to the body `eventId`                         |
| `SettleFlow-Event-Type`           | `payment.created.v1`, equal to the body `eventType`                               |
| `SettleFlow-Event-Schema-Version` | Decimal `1`                                                                       |
| `SettleFlow-Timestamp`            | Canonical decimal Unix epoch seconds for this attempt                             |
| `SettleFlow-Signature`            | Current `v1` signature followed by the optional unexpired previous `v1` signature |

The sender also sets an exact byte `Content-Length` through the HTTP transport. It sends no API key, authorization value, idempotency key, endpoint secret, encryption metadata, internal database ID, or payment response snapshot.

### Signature input and encoding

For each signing secret, the HMAC input is the byte concatenation:

```text
ASCII(timestamp) + "." + ASCII(deliveryId) + "." + rawBodyBytes
```

- Compute HMAC-SHA-256 using the plaintext endpoint signing secret.
- Encode the 32-byte result as unpadded base64url.
- Encode one signature entry as `v1,<base64url-signature>`.
- Encode the complete header as `v1,<current-signature>` when only the current secret is eligible.
- During overlap, encode the complete header as `v1,<current-signature>;v1,<previous-signature>`, with no whitespace. Current is always first; previous is always second.
- Reject any internal condition in which no current secret is available. Never send a request signed only by the previous secret.

The sender selects signing material at attempt start. It includes the previous signature only when that secret is in `previous` lifecycle and its `overlap_expires_at` is strictly later than the attempt timestamp. At the exact expiry instant it is omitted. Selection and delivery must not extend the 24-hour overlap. A concurrent rotation may complete after an attempt has durably started; the point-in-time material selected for that in-flight attempt remains its signing set.

Each automatic attempt generates a new timestamp and signatures. The signature bytes themselves are not persisted or logged. Durable attempt evidence may retain bounded signature algorithm/version and secret-version numbers, but never plaintext, HMAC output, ciphertext, nonce, authentication tag, or encryption-key ID.

### Receiver verification and replay protection

The documented sample verifier must:

1. preserve the raw HTTP body bytes;
2. validate the delivery ID, event ID, event type, schema version, and canonical timestamp syntax;
3. require header/body event identity to match;
4. apply the specification's default five-minute timestamp recency window using an explicitly supplied clock;
5. reproduce the exact signing input;
6. decode and compare each supported `v1` signature in constant time, accepting the request when an authorized current or overlap secret matches; and
7. deduplicate business processing by `SettleFlow-Webhook-Id`, with `SettleFlow-Event-Id` available as stable logical-event evidence.

Timestamp validation is replay protection, not a substitute for durable delivery-ID deduplication. Automatic retries may arrive more than once with the same delivery ID. A future authorized manual replay must use a new delivery ID for the same event, but replay APIs and verifier storage policy remain outside this ADR's implementation scope.

Project-owner approval on 2026-08-02 accepts the exact body, header names and values, signing input, signature encoding/order, previous-secret overlap representation, and replay-verification baseline above.

## Consequences

### Positive

- The persisted projection bytes, transmitted bytes, and signed bytes are identical.
- Merchants receive stable versioned verification and deduplication inputs.
- Rotation overlap works without exposing secret material or relying on intermediary behavior for repeated headers.
- Automatic retries remain verifiable and consumer-idempotent.
- No synchronous dependency on Payments, Eventing, or RabbitMQ is added to HTTP delivery.

### Negative

- The exact header syntax and byte representation become a public compatibility surface.
- Receivers must retain raw bytes and implement timestamp plus delivery-ID replay controls correctly.
- During overlap the sender performs two HMAC operations and receivers may need to test two signatures.
- A future incompatible webhook contract requires a new version and coordinated rollout.

### Risks and mitigations

- **Payload/signature drift:** Send and sign the retained byte array directly; use known vectors containing whitespace, Unicode, and property-order changes.
- **Ambiguous signature parsing:** Use one header, a semicolon entry delimiter, a comma version/value delimiter, no whitespace, and exact parser tests.
- **Overlap accidentally extended:** Select by authoritative time and use a strict `overlap_expires_at > attempt_time` rule with boundary tests.
- **Timing attack:** Require constant-time comparison in the sample verifier and known-vector security tests.
- **Replay accepted as new work:** Require the five-minute recency check and durable delivery-ID deduplication; do not claim exactly once.
- **Secret or payload leakage:** Never persist/log signature bytes or plaintext secrets and keep full payloads out of routine telemetry.

## Implementation notes

- Use Node.js cryptographic primitives behind the existing Webhooks secret/keyring boundary; no new signing dependency is authorized by this ADR.
- Decrypt signing material outside a database transaction and keep plaintext lifetime bounded.
- Build request headers from validated stored identifiers, not merchant-controlled arbitrary header values.
- Reject line breaks, noncanonical timestamps, unsupported signature versions, malformed signature entries, or identifier mismatches in the sample verifier.
- This ADR creates no sender, endpoint API, schema, migration, test, dependency, Compose change, or manual replay behavior.

## Affected requirements and invariants

- **Requirements:** FR-09 secret lifecycle; FR-10 signed delivery, exact-byte verification, attempt evidence, and replay controls; FR-13 correlation and safe telemetry.
- **Invariants:** INV-10 and asynchronous integrity are protected through stable event/delivery identities and receiver deduplication. No financial state or money representation changes.
- **Acceptance:** Known-vector, exact-byte, current/previous overlap, stale timestamp, identifier mismatch, duplicate delivery, redaction, and compatibility tests are release-blocking when implemented.

## Impact assessment

- **Affected modules and dependency direction:** Webhooks owns the external delivery contract and signing policy. The worker composes the Webhooks sender; it does not reconstruct payment state.
- **Financial invariants and money representation:** The existing event carries JSON-safe integer minor units and supported currency unchanged; no financial mutation occurs.
- **Database schema, migration, locking, and transaction boundaries:** Delivery attempts may retain safe signing metadata, but exact schema belongs to ADR-0019 and the implementation plan. No network call belongs inside a database transaction.
- **Idempotency, outbox/inbox, retries, and partial failure:** Stable event/delivery IDs support at-least-once retries. Receiver deduplication is required; timestamp alone is insufficient.
- **API, event, webhook, or CSV compatibility:** Establishes the public HTTP webhook body/header/signature v1 contract. The RabbitMQ/event body does not change.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Defines HMAC, current/previous selection, constant-time verification, recency, secret redaction, and raw-body handling. ADR-0014 still governs outbound addressing.
- **Observability, alerting, and runbooks:** Signals may contain stable IDs, signature contract version, and attempt result, but not body, signature, secret, destination, or encryption material.
- **Production dependencies and supply-chain impact:** None. A production KMS adapter remains separately required before production readiness.

## Verification

- Add known HMAC-SHA-256 vectors for current-only and current-plus-previous headers.
- Prove one-byte, whitespace, field-order, timestamp, delivery-ID, and body changes invalidate the signature.
- Test immediately before and at overlap expiry with an injected clock.
- Test malformed, duplicated, unsupported-version, noncanonical, and oversized header inputs in the sample verifier.
- Test five-minute recency boundaries, constant-time comparison use, and delivery-ID duplicate handling.
- Capture a real local HTTP request and prove transmitted bytes, content length, headers, and signatures match the retained projection exactly.
- Scan persistence, logs, errors, traces, fixtures, and documentation for plaintext secrets, HMAC outputs, full payloads, and encryption material.

## Rollout and recovery

Publish contract documentation and verifier vectors before enabling the sender. Deploy schema and sender support only after ADR-0019's lifecycle migration. A faulty sender is stopped and forward-fixed while pending deliveries and projection bytes remain intact; do not rewrite event bytes, delivery IDs, or secrets to repair a signature. A future contract version uses additive documentation and a coordinated sender/receiver compatibility plan rather than silently changing `v1`.

## Documentation and traceability

The [ADR index](README.md) records acceptance. The Signed HTTP Webhook Delivery implementation plan, event/webhook contract guide, sample verifier, security documentation, README, tests, and delivery runbook must cite this ADR. [ADR-0019](0019-webhook-delivery-reliability-and-lifecycle.md) defines claim, attempt, retry, and terminal-state behavior.
