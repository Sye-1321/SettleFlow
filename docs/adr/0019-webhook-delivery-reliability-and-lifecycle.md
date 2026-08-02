# ADR-0019: Webhook delivery reliability and lifecycle

- **Status:** Accepted
- **Date:** 2026-08-02
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through Signed HTTP Webhook Delivery approval
- **Supersedes:** None
- **Superseded by:** None

## Context

The `payment.created.v1` projection consumer durably creates one Webhooks-owned delivery per eligible endpoint/event with status `pending`, attempt count zero, and an immediately due time. It does not send HTTP. The current database deliberately permits no delivery update and has no claim lease, retrying/terminal states, or attempt table.

FR-10 requires signed webhook delivery with attempt history, retry backoff, a terminal dead-letter state, and controlled future replay. The specification treats delivery as at least once, defines HTTP result classes, provides a seven-attempt reference schedule, requires SSRF re-resolution and no redirects, and names due-delivery indexing and operational signals. A safe sender must also avoid holding PostgreSQL locks during DNS or HTTP and must recover both abandoned claims and requests with unknown remote outcomes.

Without an accepted lifecycle, two workers could send the same due row concurrently, a crash could lose or exceed attempt evidence, an unconfirmed remote outcome could be marked successful, or a retry policy could be selected implicitly in code.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): FR-10, webhook delivery policy, reference retry schedule, core entities/indexes, threat model, reliability/failure handling, observability, and verification gates.
- [Module boundaries](../architecture/module-boundaries.md)
- [Financial invariants](../architecture/financial-invariants.md)
- [ADR-0003](0003-postgresql-prisma-and-financial-data-access.md)
- [ADR-0004](0004-rabbitmq-outbox-inbox-and-message-delivery.md)
- [ADR-0013](0013-problem-details-audit-and-retention-boundaries.md)
- [ADR-0014](0014-webhook-endpoint-url-and-ssrf-policy.md)
- [ADR-0015](0015-webhook-signing-secret-encryption-and-rotation.md)
- [ADR-0016](0016-webhook-endpoint-api-ownership-and-subscriptions.md)
- [ADR-0018](0018-signed-webhook-delivery-contract.md)
- [`payment.created.v1` projection-consumer plan](../plans/2026-08-02-payment-created-webhook-projection-consumer.md)

This ADR refines the specification's delivery lifecycle and operating bounds without changing its at-least-once or terminal-state baseline. It does not require a specification version change.

## Decision drivers

- One active claim per delivery without database locks during DNS, cryptography, or HTTP.
- Durable, immutable evidence for every started attempt, including unknown outcomes after a crash.
- At-least-once recovery without false delivery success or silent discard.
- Bounded concurrency, leases, network resources, response handling, retries, and shutdown.
- Delivery-time SSRF enforcement and endpoint disablement as an outbound-data safety control.
- PostgreSQL authority, Webhooks ownership, least-privilege runtime access, and real concurrency proof.
- Operationally visible terminal failure with no ad hoc row or queue manipulation.

## Considered options

### Option A: PostgreSQL leases, four durable states, immutable attempts, and bounded automatic retry

Claim due rows with short `FOR UPDATE SKIP LOCKED` transactions, perform external work after commit, and condition finalization on a unique lease. Persist every started attempt, recover unknown attempts after lease expiry, and terminate after the approved budget or a non-retryable result.

### Option B: Hold delivery row locks during HTTP

This makes ownership simple but holds database connections and locks across untrusted DNS and network waits, impairs concurrency, and complicates shutdown. It is rejected.

### Option C: Select due rows without a durable lease

Multiple worker instances could send the same delivery concurrently during normal operation, not only accepted crash recovery. It is rejected.

### Option D: Move HTTP retries to RabbitMQ queues

The delivery projection and attempt history are authoritative in PostgreSQL. Adding delay/retry queues would create new topology, split lifecycle authority, and couple delivery timing to broker behavior without specification need. It is rejected.

### Option E: Retry indefinitely or follow `Retry-After`

Unbounded endpoint retries prevent a terminal state, while accepting remote retry instructions would make the initial policy nondeterministic and could extend it beyond approved limits. This option is rejected for the first implementation.

## Decision

The decision is **Option A**.

### Delivery state machine

The only delivery states are:

- `pending`: initial projection, no completed/unknown attempt yet;
- `retrying`: at least one attempt exists and another automatic attempt is scheduled;
- `delivered`: terminal success after a `2xx` response; and
- `dead_lettered`: terminal automated failure requiring review and a future controlled replay path.

Permitted transitions are:

```text
pending  -> delivered | retrying | dead_lettered
retrying -> delivered | retrying | dead_lettered
```

Terminal states are not automatically reopened. A future manual replay creates a new delivery ID for the same event under a separately approved authenticated and audited design. This ADR creates no replay API or command.

`dead_lettered` is authoritative PostgreSQL delivery state. It is distinct from the RabbitMQ projection DLQ and does not publish, reject, or move a RabbitMQ message.

### Approved operating bounds

| Setting                        |                                    Approved value |
| ------------------------------ | ------------------------------------------------: |
| Dispatcher concurrency         |                                                 4 |
| Claim batch                    | 4, further bounded by available concurrency slots |
| Idle poll interval             |                                  500 milliseconds |
| Claim lease                    |                                        30 seconds |
| Total attempt timeout          |                                         8 seconds |
| Maximum response body consumed |                             64 KiB / 65,536 bytes |
| Automatic attempt budget       |                                                 7 |
| Shutdown drain                 |                                        10 seconds |

ADR-0014's two-second DNS deadline and 16-answer limit remain unchanged. A later change to these constants requires measured evidence and a reviewed plan; it must not be introduced through silent default drift.

### Claim, attempt start, and finalization

1. The Webhooks repository recovers expired claims, then claims at most the available concurrency slots from deliveries that are `pending` or `retrying`, due by PostgreSQL time, and not actively leased.
2. Claim in a short transaction using reviewed parameterized `FOR UPDATE SKIP LOCKED`, deterministic due ordering, a process identifier, a unique per-claim token, database `locked_at`, and a 30-second expiry.
3. Commit the claim before endpoint state checks, secret decryption, DNS, signing, or HTTP.
4. An abandoned claim that never durably started an attempt is cleared after expiry without consuming an attempt.
5. Before external contact, recheck the approved send-time endpoint status and ADR-0014 delivery URL policy. Select/decrypt the ADR-0018 signing material outside the claim transaction.
6. In another short owner-conditional transaction, durably start the attempt: increment the count, record active-attempt/signing metadata, and precompute the possible next retry time using PostgreSQL time plus the approved injected-jitter result.
7. Perform one pinned HTTP request outside PostgreSQL.
8. Finalize in one short transaction conditioned on delivery ID, claim token, and active attempt number. Insert immutable attempt evidence; set `delivered`, `retrying`, or `dead_lettered`; and clear claim/active-attempt fields.
9. A zero-row finalization is ownership loss. Record a safe signal and never overwrite a new owner or terminal state.

No row lock or database transaction spans DNS, keyring work, HMAC, socket establishment, request transmission, or response handling. Prisma remains the routine client; claim/recovery/owner-conditional SQL is a justified ADR-0003 raw-SQL exception confined to the Webhooks persistence adapter.

### Attempt evidence and unknown recovery

- `attempt_count` counts durably started attempts and is constrained from zero through seven.
- Each started attempt has at most one immutable evidence record under delivery ID plus attempt number.
- Evidence contains bounded start/completion/duration, result class, optional HTTP status, stable redacted error code, response-body hash only when the complete bounded response was read, truncation indicator, signature contract/timestamp, and safe current/previous secret-version numbers.
- Evidence never contains request/response bodies, response headers, destination URL/host/path/query, resolved address, signature bytes, plaintext secret, ciphertext, nonce, authentication tag, encryption-key ID, or arbitrary exception text.
- The runtime role may insert/read attempts but cannot update, delete, or truncate them; database triggers independently enforce immutability.

If a lease expires after attempt start but before finalization, recovery inserts one `unknown` attempt outcome atomically before clearing the active claim. Unknown means the endpoint may have received the request. It consumes that attempt number and follows the approved retry schedule. An unknown seventh attempt becomes `dead_lettered`. A later retry keeps the same stable delivery ID and exact body, so merchant deduplication handles a duplicate remote effect.

A keyring/configuration failure detected before durable attempt start sends no request and consumes no attempt. It makes the sender unavailable until safe recovery. A process crash after claim but before start similarly consumes no attempt.

### Endpoint status and subscription semantics

- Endpoint subscription eligibility remains the projection-time decision accepted by ADR-0016. The sender does not re-evaluate or reverse the stored subscription projection.
- Endpoint active status is a separate send-time safety gate.
- If the endpoint is inactive immediately before attempt start, make no DNS connection or HTTP request. Persist bounded non-HTTP attempt evidence and transition the delivery directly to `dead_lettered` with stable code `endpoint_inactive`.
- Later endpoint reactivation does not automatically revive or recreate that delivery.

This makes endpoint disablement an effective outbound-data stop while preserving the retained no-historical-fanout marker and the original projection decision.

### HTTP result and retry policy

| Result                                                             | Delivery action                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Any `2xx`                                                          | Mark `delivered`; no automatic retry                                                        |
| `408`, `429`, or `5xx`                                             | Retry when budget remains                                                                   |
| Connection timeout/reset/refusal or transient DNS/resolver failure | Retry when budget remains                                                                   |
| `3xx`                                                              | Never follow; terminal `dead_lettered` configuration failure                                |
| Other `4xx`                                                        | Terminal `dead_lettered` after that bounded attempt                                         |
| Prohibited destination or TLS certificate/hostname failure         | No unsafe contact/further redirect; terminal `dead_lettered` security/configuration failure |
| Retryable result on attempt 7                                      | Terminal `dead_lettered`                                                                    |

The first implementation ignores `Retry-After`. Response bodies and headers never drive scheduling.

Full-jitter delays are selected through an injected random source as `uniform(0, ceiling)` using the reference schedule:

| Next attempt | Jitter ceiling |
| ------------ | -------------: |
| 2            |       1 minute |
| 3            |      5 minutes |
| 4            |     15 minutes |
| 5            |         1 hour |
| 6            |        6 hours |
| 7            |       24 hours |

The selected next time is persisted when the attempt starts so crash recovery does not invent a different schedule. Polling and database time provide the effective lower execution bound; a zero jitter sample does not permit overlapping execution while a valid lease exists.

### Delivery-time SSRF and HTTP resource policy

- Reuse the single Webhooks-owned ADR-0014 URL-policy port. Re-parse the persisted canonical URL, re-resolve immediately before each attempt, validate every answer, and fail closed if any answer is prohibited.
- Connect to only one address selected from the approved result for one attempt. Pin that address while preserving the original hostname for `Host`, TLS SNI, and certificate verification.
- Do not transparently try another IP within the same attempt because it could create a second remote effect.
- Do not follow redirects.
- Enforce the eight-second total deadline across request establishment and response handling. Destroy the socket at the deadline.
- Consume at most 65,536 response bytes. Persist no response body. Store a SHA-256 only when the complete bounded response was read; otherwise mark it truncated.
- A `2xx` remains delivered even when its diagnostic response body exceeds the limit; body size does not undo the endpoint's successful status.
- The production HTTPS/443 rule and explicit development-origin adapter remain unchanged.

The implementation should use the pinned Node.js runtime's `node:http`/`node:https` facilities with an injected pinned lookup unless review proves they cannot express the required SNI, certificate, timeout, and redirect behavior. No new HTTP dependency is approved by this ADR.

### Worker readiness and graceful shutdown

- The worker adds a separately diagnosable delivery-dispatcher readiness component.
- Readiness requires valid delivery configuration/keyring, PostgreSQL access through the approved schema/grants, and a running dispatcher. Existing PostgreSQL, RabbitMQ publisher/topology, and active projection-consumer checks remain required for the combined worker.
- A merchant endpoint's DNS or HTTP failure is delivery state, not global worker unreadiness.
- A keyring failure, incompatible schema/grant, or dispatcher lifecycle failure marks the delivery component unavailable.
- Shutdown marks the worker not ready, stops new delivery claims, and drains active delivery work with the relay and projection consumer for at most ten seconds.
- Work that commits during the drain may finalize. Remaining sockets are destroyed and their active claims recover through lease expiry before Prisma closes.
- No poll, timeout, or retry promise may keep the worker alive after shutdown begins.

Project-owner approval on 2026-08-02 accepts the four states, seven-attempt budget, immutable/unknown attempt behavior, full-jitter schedule, endpoint-disable rule, operating constants, response limit, `Retry-After` deferral, readiness, and shutdown behavior above.

## Consequences

### Positive

- Normal multi-worker operation has disjoint active claims while crash outcomes remain safely repeatable.
- No remote network wait holds a PostgreSQL lock or transaction.
- Every started attempt reaches immutable evidence, including lease-recovered unknown outcomes.
- Retry and terminal behavior is deterministic, bounded, observable, and specification-aligned.
- Disabling an endpoint prevents further outbound contact.
- PostgreSQL remains the authoritative delivery/attempt store; RabbitMQ topology is unchanged.

### Negative

- Claim, start, finalization, and recovery require several short database transactions and careful owner predicates.
- Remote acceptance followed by a crash can still cause a duplicate request.
- Seven attempts can span more than a day and need backlog/dead-letter monitoring.
- Terminal inactive/configuration failures require a future authorized replay after correction.
- The current shared runtime role cannot enforce module ownership as narrowly as a dedicated Webhooks database role; code boundaries and grants remain important.

### Risks and mitigations

- **Lease expires during live request:** Keep the eight-second attempt well below 30 seconds; owner-condition finalization and tolerate a duplicate after recovery.
- **False success after unknown outcome:** Only a received `2xx` finalized by the lease owner becomes delivered; otherwise recover as unknown/retryable.
- **Attempt lost after crash:** Persist active-attempt metadata before HTTP and synthesize immutable unknown evidence on expiry.
- **Hot or synchronized retries:** Use injected full jitter, the persisted schedule, and the 500-millisecond poll.
- **SSRF/DNS rebinding:** Re-resolve every attempt, reject any prohibited answer, pin one approved address, preserve TLS hostname checks, and disable redirects.
- **Response resource exhaustion:** Eight-second deadline, 64 KiB cap, no body persistence, and socket destruction.
- **Delivery evidence mutation:** Restrictive grants, named constraints, append-only triggers, and permission-negative tests.
- **Shutdown loses ownership evidence:** Stop claims first, drain within the bound, then rely on lease recovery before closing PostgreSQL.

## Implementation notes

- The migration must extend the delivery status enum, replace projection-only checks, add nullable terminal/lease/active-attempt fields, add the immutable attempt table, and grant only required Webhooks operations to `settleflow_app`.
- Use named constraints, deterministic due ordering, database time, and partial due/lease indexes proven against representative pending/terminal ratios.
- Delivery rows are mutable lifecycle projections; attempt rows are immutable evidence.
- Structured signals include stable delivery/event/endpoint/merchant/request IDs, attempt number, safe result/error code, duration, claim count, retry time, lease recovery, ownership loss, due age, and dead-letter count.
- Never log payloads, URL components, resolved addresses, response bodies, headers, signatures, secrets, keyring material, connection strings, or raw dependency exceptions.
- This ADR creates no sender, schema, migration, test, dependency, Compose change, API, manual replay, delivery-retention deletion, or financial behavior.

## Affected requirements and invariants

- **Requirements:** FR-10 delivery, attempt, retry, terminal state, and future controlled replay; FR-13 readiness/correlation/operations; FR-09 endpoint disablement and SSRF lifecycle.
- **Invariants:** INV-10 and asynchronous integrity are protected through unique delivery identity, lease ownership, immutable attempt sequence, and at-least-once recovery. INV-01 through INV-09 are unchanged.
- **Acceptance:** State/constraint, two-worker claim, crash-before/after-request, lease expiry, retry classification, dead-letter, endpoint-disable, SSRF, timeout, resource, readiness, shutdown, and performance evidence are required.

## Impact assessment

- **Affected modules and dependency direction:** Webhooks owns delivery/attempt persistence and HTTP policy. The worker invokes its application service and owns scheduling/lifecycle only. Eventing and Payments are not queried or mutated.
- **Financial invariants and money representation:** No financial mutation. Exact event amount/currency bytes remain unchanged.
- **Database schema, migration, locking, and transaction boundaries:** Requires an additive Webhooks migration, reviewed `SKIP LOCKED`/owner SQL, immutable-attempt controls, indexes, and runtime grants. Network work stays outside transactions.
- **Idempotency, outbox/inbox, retries, and partial failure:** Delivery is at least once. Stable delivery IDs and unknown recovery tolerate duplicates; the projection inbox/marker remains unchanged.
- **API, event, webhook, or CSV compatibility:** No API or RabbitMQ contract change. Implements ADR-0018's public webhook request contract.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Enforces inactive stop, current/previous decryption, delivery-time DNS/IP policy, TLS validation, no redirects, response bounds, and redaction.
- **Observability, alerting, and runbooks:** Requires delivery attempt/duration, due/backlog, lease recovery, retry, and dead-letter signals plus a runbook. Environment-specific alert destinations remain deferred.
- **Production dependencies and supply-chain impact:** No new runtime dependency is approved. Production deployment still requires a production KMS adapter and approved outbound egress controls.

## Verification

- Apply the full migration history to an empty PostgreSQL database and upgrade the committed projection-consumer schema.
- Prove all delivery state/lease/attempt constraints and runtime-role privileges, including attempt update/delete/truncate denial.
- Run two dispatchers against one backlog and prove disjoint live claims, due ordering, batch/concurrency bounds, and terminal-row exclusion.
- Inject crashes after claim, after attempt start, after remote acceptance, and before finalization; prove no false delivered state and one unknown record per started attempt.
- Test every HTTP classification, all seven jitter ceilings, `Retry-After` ignore behavior, and terminal attempt budget.
- Test inactive endpoints make no DNS/HTTP contact while subscription changes after projection do not rewrite delivery eligibility.
- With a local HTTP/HTTPS target and injected resolver, prove exact pinned destination, SNI/certificate verification, mixed/prohibited answer refusal, rebinding defense, redirect refusal, timeout, reset, and response limit.
- Prove worker readiness and ten-second shutdown ordering while relay and projection behavior remain unchanged.
- Run the specification's 1,000-delivery/concurrency-four reference scenario and record drain time and database load.
- Run full formatting, lint, type, unit, real PostgreSQL/RabbitMQ/HTTP integration, build, OpenAPI no-drift, documentation-link, whitespace, and status gates.

## Rollout and recovery

Apply the additive delivery migration before deploying the sender-capable worker. Old workers may continue projecting `pending` rows and otherwise ignore the new states. Enable one worker first, verify claims/attempts/readiness, then scale within the approved concurrency model.

Before the first request is sent, the worker change can be disabled while retaining the additive schema. After attempt evidence exists, rollback means stop new claims, drain or let leases expire, retain every delivery/attempt, and deploy a forward fix. Do not remove enum values, reopen terminal rows, decrement attempts, edit evidence, change delivery/event IDs or bodies, purge RabbitMQ queues, or send a request from an operator shell. Manual replay and destructive retention wait for separate approved designs.

## Documentation and traceability

The [ADR index](README.md) records acceptance. The Signed HTTP Webhook Delivery implementation plan, Prisma schema/migration notes, webhook contract, README, package boundaries, security guidance, worker configuration, tests, observability documentation, and delivery runbook must cite this ADR and [ADR-0018](0018-signed-webhook-delivery-contract.md).
