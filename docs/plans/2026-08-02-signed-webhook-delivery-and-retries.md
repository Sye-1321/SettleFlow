# Implementation Plan: Signed HTTP Webhook Delivery and Retry Processing

- **Status:** Completed
- **Owner:** SettleFlow Project
- **Created:** 2026-08-02
- **Last updated:** 2026-08-02
- **Related issue/PR:** To be decided
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md), [ADR-0013](../adr/0013-problem-details-audit-and-retention-boundaries.md), [ADR-0014](../adr/0014-webhook-endpoint-url-and-ssrf-policy.md), [ADR-0015](../adr/0015-webhook-signing-secret-encryption-and-rotation.md), [ADR-0016](../adr/0016-webhook-endpoint-api-ownership-and-subscriptions.md), [ADR-0018](../adr/0018-signed-webhook-delivery-contract.md), and [ADR-0019](../adr/0019-webhook-delivery-reliability-and-lifecycle.md)

## Goal

Deliver each due `payment.created.v1` Webhook projection to its already selected merchant endpoint as one bounded, signed HTTP `POST`. The worker must claim work without duplicate concurrent ownership, use the exact retained event bytes and approved HMAC contract, preserve immutable evidence for every durably started attempt, retry only approved transient failures, and reach `delivered` or `dead_lettered` within the seven-attempt budget.

The measurable outcome is that real PostgreSQL integration tests and controlled HTTP targets prove safe claiming, exact signature vectors, delivery-time SSRF enforcement, success/failure classification, full-jitter scheduling, lease-expiry recovery, readiness, and shutdown without changing the Payment Intent API, endpoint-management API, projection consumer, or RabbitMQ topology.

### Non-goals

- No new Webhook Endpoint API or change to create, list, get, patch, rotation, ETag, pagination, authentication, scope, response, or OpenAPI behavior.
- No manual replay API, CLI, queue, operator row edit, or automatic reopening of terminal deliveries.
- No re-evaluation of endpoint subscription at send time and no historical fanout. Projection-time subscription eligibility remains authoritative.
- No new Payment Intent behavior or endpoint; no capture, authorization, refund, provider, ledger, balance, settlement, reconciliation, or movement of funds.
- No new RabbitMQ exchange, queue, retry queue, message consumer, inbox effect, or change to the outbox relay/projection-consumer contract.
- No webhook event reserialization, wrapper envelope, alternate body, new event type, or schema-version change.
- No response-body persistence, request/response header persistence, destination evidence, signature persistence, plaintext-secret persistence, or expansion of routine logging.
- No delivery-retention deletion, attempt deletion, controlled replay, Prometheus backend, dashboard, production alert routing, or production KMS implementation.
- No `Retry-After` support, redirect following, multiple-address fallback within an attempt, or more than seven automatic attempts.
- No third-party HTTP or signing dependency. The pinned Node.js `node:http`, `node:https`, and `node:crypto` primitives are the approved baseline.

## Specification traceability

- **Sections:** FR-09 endpoint ownership/subscriptions; FR-10 signed Webhook delivery; initial `payment.created.v1` catalog; Webhook envelope and signature; secret lifecycle; core data model/indexes; reference retry schedule; reliability and failure handling; Webhook security/threat model; observability; verification strategy.
- **Requirement IDs:** FR-10 is implemented directly. FR-09 supplies endpoint ownership, disablement, URL policy, and the already committed projection-time subscription decision. FR-13 supplies readiness, correlation, and operator-signal requirements.
- **Invariant IDs:** INV-10 and asynchronous integrity are protected by stable delivery identity, owner-conditioned leases, immutable attempt sequence, and recovery of unknown outcomes. INV-01 through INV-09 remain unchanged because this slice neither reads nor mutates payment, ledger, balance, or settlement state.
- **Acceptance/release gates:** Exact-byte/signature contract vectors, two-worker claim exclusion, every state transition/classification, seven-attempt scheduling, expired-lease recovery, endpoint-disable behavior, DNS rebinding and address-policy tests, no redirects, timeout/response bounds, runtime-role permissions, readiness, shutdown, empty/upgrade migration, and regression tests are mandatory.

[ADR-0018](../adr/0018-signed-webhook-delivery-contract.md) is authoritative for the HTTP body, headers, signing input, overlap representation, and receiver-verification guidance. [ADR-0019](../adr/0019-webhook-delivery-reliability-and-lifecycle.md) is authoritative for persistence ownership, claim/start/finalize boundaries, state transitions, attempts, recovery, retry classification, resource limits, worker lifecycle, and rollout. This plan makes no new architecture decision.

## Existing behavior

Evidence inspected at commit `980d053`:

- `WebhookEventProjection.payloadBytes` retains the exact validated `payment.created.v1` UTF-8 body and `payloadSha256`; the committed consumer body limit is 16 KiB.
- `WebhookDelivery` is a Webhooks-owned projection with stable `whd_<ULID>`, merchant/endpoint/event ownership, status `pending`, `attempt_count = 0`, and `next_attempt_at = projected_at`.
- `WebhookDeliveryStatus` currently permits only `pending`. The projection migration deliberately prevents delivery updates and grants the runtime role only the projection operations needed by that milestone.
- `WebhookEndpoint` stores the immutable canonical URL and active/inactive state. `WebhookEndpointSecret` stores encrypted, versioned current/previous/retired signing material and `overlap_expires_at` under the AES-256-GCM keyring abstraction.
- The existing URL policy normalizes and validates registration-time destinations using production HTTPS/443 or an explicit injected development-origin allowlist, a two-second DNS timeout, a 16-answer cap, and special-address rejection. It needs a delivery-time resolve-and-pin operation, not a second policy implementation.
- The projection consumer already chooses active, subscribed endpoints inside its serializable transaction. The sender must not repeat the subscription query; it must only enforce the endpoint's current active status as a send-time safety stop.
- The worker currently owns outbox relay polling and the RabbitMQ projection consumer lifecycle. Its combined readiness reports PostgreSQL, publisher/topology, and active consumer registration; shutdown drains those paths for ten seconds before Prisma closes.
- The worker does not currently load the Webhook keyring/URL delivery policy, claim delivery rows, open outbound HTTP sockets, expose a dispatcher readiness component, or persist attempt evidence.
- `settleflow_app` is the non-owner API/worker PostgreSQL role. Migrations run as the owner and independently enforce immutable evidence/least privilege.
- Existing documentation explicitly says that pending delivery records do not send HTTP and that no attempt table or HTTP-delivery state exists. Those statements must be updated only when implementation is complete.

Inspection sources include `prisma/schema.prisma`, the committed migrations, `packages/modules/webhooks`, `apps/worker/src`, the worker/API environment schemas, root scripts, README/security/package ownership documents, runbooks, the projection-consumer plan, and ADR-0014 through ADR-0019.

## Proposed design

### Ownership and dependency direction

- Webhooks owns delivery lifecycle, claim/start/finalization persistence, attempt evidence, signature construction, secret selection/decryption, delivery-time URL policy, the bounded HTTP adapter, result classification, and retry scheduling.
- The worker owns dispatcher scheduling, available-concurrency calculation, lifecycle composition, configuration, readiness aggregation, structured runtime signals, and shutdown ordering.
- Infrastructure continues to own the Prisma client lifecycle only. Reviewed parameterized raw SQL stays inside the Webhooks persistence adapter under ADR-0003.
- Eventing and Payments are not queried or mutated. RabbitMQ is not involved after the projection transaction has created a delivery.
- Operations audit is not used for routine automated attempts. Immutable `webhook_delivery_attempts` are delivery evidence; a future manual replay remains separately authenticated, reasoned, and audited.

### Approved constants

| Setting                           |                         Exact value |
| --------------------------------- | ----------------------------------: |
| Dispatcher concurrency            |                                   4 |
| Claim batch                       | 4, capped by free concurrency slots |
| Idle poll interval                |                    500 milliseconds |
| Claim lease                       |                          30 seconds |
| Total attempt timeout             |                           8 seconds |
| Response bytes consumed           |                65,536 bytes maximum |
| Automatic attempt budget          |                                   7 |
| Shutdown drain                    |                          10 seconds |
| Registration/delivery DNS timeout |                           2 seconds |
| DNS answer cap                    |                                  16 |

Configuration validation must pin these accepted values rather than allow silent environment drift. Test seams may inject clocks, jitter, DNS, HTTP, and timers; production configuration may not enlarge the bounds without a reviewed plan/decision update.

### Exact HTTP request contract

The body is the exact `webhook_event_projections.payload_bytes` byte sequence. The sender must not parse/re-serialize it, rebuild it from Payments/Eventing, add an envelope, or modify whitespace, Unicode, property order, or numeric representation. Every automatic attempt for one delivery reuses the same `whd_<ULID>` and exact body.

The request is a single `POST` with redirects disabled and these exact application headers:

| Header                            | Exact value                                                            |
| --------------------------------- | ---------------------------------------------------------------------- |
| `Content-Type`                    | `application/json`                                                     |
| `User-Agent`                      | `SettleFlow-Webhooks/1.0`                                              |
| `SettleFlow-Webhook-Id`           | Delivery `whd_<ULID>`                                                  |
| `SettleFlow-Event-Id`             | Event `evt_<ULID>`, matching body `eventId`                            |
| `SettleFlow-Event-Type`           | `payment.created.v1`, matching body `eventType`                        |
| `SettleFlow-Event-Schema-Version` | `1`                                                                    |
| `SettleFlow-Timestamp`            | Canonical decimal Unix epoch seconds selected for this attempt         |
| `SettleFlow-Signature`            | Current `v1` signature, then optional eligible previous `v1` signature |

The Node transport must set the exact byte `Content-Length`. It must send no authorization/API key, idempotency key, internal database ID, endpoint secret, encryption metadata, payment response snapshot, or arbitrary merchant-controlled header.

For each selected plaintext secret, compute:

```text
HMAC-SHA-256(secret, ASCII(timestamp) + "." + ASCII(deliveryId) + "." + rawBodyBytes)
```

Encode the 32-byte HMAC as unpadded base64url and an entry as `v1,<signature>`. The header is either `v1,<current>` or, during overlap, `v1,<current>;v1,<previous>` with current first and no whitespace.

The sender selects material at attempt start using the same authoritative instant as the signature timestamp. Current secret is mandatory. Previous is included only when its lifecycle is `previous` and `overlap_expires_at` is strictly later than that instant; at exact expiry it is omitted. A rotation committed after the attempt starts does not change that in-flight attempt's selected material. Plaintext lifetime is bounded to signing/request construction and is never persisted or logged.

### Delivery-time SSRF and HTTP adapter

Extend the single Webhooks-owned URL-policy port with a delivery operation that:

1. reparses the persisted canonical URL and applies the approved production/development policy again;
2. resolves the hostname immediately before every attempt with the two-second deadline and 16-answer limit;
3. rejects the entire result if any answer is non-global, reserved, malformed, or otherwise prohibited;
4. selects exactly one approved address for that attempt;
5. returns connection metadata that pins that address while preserving the canonical hostname for `Host`, TLS SNI, and certificate/hostname verification.

The Node HTTP adapter must use an injected lookup/pinned connection, make one request, and never transparently try a second address. It follows no redirect. The eight-second deadline covers connection, TLS, request, and response consumption and destroys the socket at expiry.

Consume at most 65,536 response bytes and never persist the response body or headers. Persist a SHA-256 only if the complete response is within the limit; otherwise set the truncation indicator and omit the hash. A `2xx` remains successful even if its diagnostic body exceeds the limit. Ignore `Retry-After` and all response-body content for scheduling.

Production retains HTTPS/443-only behavior. Development HTTP remains possible solely for exact origins in the injected allowlist. A production worker using the local keyring provider must fail startup; the production KMS adapter remains a deployment blocker outside this implementation slice, not a reason to weaken the policy.

### Claim, preflight, attempt start, network, and finalization flow

One dispatcher cycle performs these phases:

1. Recover a bounded set of expired leases using PostgreSQL time.
2. Compute free slots as `4 - activeOperations`; if zero, claim nothing.
3. In one short transaction, select up to `min(4, freeSlots)` due `pending`/`retrying` rows ordered by `(next_attempt_at, id)` with parameterized `FOR UPDATE SKIP LOCKED`.
4. Set a process identifier, unique per-row claim token, `locked_at = transaction_timestamp()`, and `lease_expires_at = locked_at + 30 seconds`; return only the claimed Webhooks data needed for preflight. Commit before any keyring, DNS, HMAC, or network operation.
5. Read the endpoint and eligible current/previous secret records through tenant-consistent relations. Recheck active status and prepare/decrypt signing material outside the claim transaction. Re-resolve and validate the canonical URL immediately before contact.
6. In a short owner-conditioned transaction, increment `attempt_count`, set the active attempt number/start/signature and safe secret-version metadata, and persist the injected full-jitter `next_attempt_at` that would apply to a retry. All conditions include delivery ID, claim token, unexpired ownership, nonterminal state, and expected prior count.
7. Perform one HTTP request outside PostgreSQL.
8. In one short owner-conditioned finalization transaction, insert exactly one immutable attempt row, set `delivered`, `retrying`, or `dead_lettered`, set the matching terminal timestamp when applicable, null terminal `next_attempt_at`, and clear claim/active-attempt fields.
9. Treat a zero-row start or finalization as ownership loss: emit a safe signal and never overwrite a newer owner, attempt, or terminal state.

No database transaction or row lock spans keyring access, decryption, DNS, HMAC, socket creation, write, or response consumption.

An inactive endpoint is an approved special path. It makes no DNS or HTTP contact. Under the current claim, persist one bounded non-HTTP `non_retryable_failure` attempt with stable code `endpoint_inactive`, consume the next attempt number, transition directly to `dead_lettered`, and clear the claim atomically. Reactivation does not revive that delivery.

A keyring/configuration failure found before durable attempt start makes the dispatcher unavailable, sends nothing, and consumes no attempt. Release the unstarted claim owner-conditionally when safe; otherwise lease expiry clears it. Destination validation/DNS results are delivery-specific outcomes and are classified under the approved security/transient policy rather than making the whole worker unavailable.

### Result classification and state transitions

The only states and transitions are:

```text
pending  -> delivered | retrying | dead_lettered
retrying -> delivered | retrying | dead_lettered
```

| Result                                                                  | Evidence/result code                           | State after finalization                    |
| ----------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| Any `2xx`                                                               | `delivered`                                    | `delivered`                                 |
| `408`, `429`, or `5xx`, attempts 1-6                                    | `retryable_failure`                            | `retrying`                                  |
| Connection timeout/reset/refusal or transient DNS failure, attempts 1-6 | `retryable_failure`                            | `retrying`                                  |
| Any retryable result on attempt 7                                       | `retryable_failure`                            | `dead_lettered`                             |
| Any `3xx`                                                               | `non_retryable_failure` / stable redirect code | `dead_lettered`                             |
| Other `4xx`                                                             | `non_retryable_failure` / stable HTTP class    | `dead_lettered`                             |
| Prohibited destination or TLS certificate/hostname failure              | `non_retryable_failure` / stable security code | `dead_lettered`                             |
| Endpoint inactive before contact                                        | `non_retryable_failure` / `endpoint_inactive`  | `dead_lettered`                             |
| Expired lease after durable attempt start                               | `unknown` / `lease_expired_unknown`            | `retrying`, or `dead_lettered` on attempt 7 |

Only a received `2xx` finalized by the current owner becomes `delivered`. Terminal rows are never automatically reopened. Database `dead_lettered` is not the RabbitMQ projection DLQ and causes no broker action.

### Seven-attempt full-jitter schedule

At the start of attempt `n`, preselect the possible delay for attempt `n + 1` using an injected cryptographically suitable or unbiased random source and `uniform(0, ceiling)`. Persist the resulting PostgreSQL-time `next_attempt_at` before HTTP so lease recovery uses the same schedule.

| Next attempt | Full-jitter ceiling |
| ------------ | ------------------: |
| 2            |            1 minute |
| 3            |           5 minutes |
| 4            |          15 minutes |
| 5            |              1 hour |
| 6            |             6 hours |
| 7            |            24 hours |

There is no schedule after attempt 7. Polling and an active lease prevent a zero-jitter sample from creating overlapping work. `Retry-After` is ignored in this milestone.

### Crash and lease recovery

- Expired claim with no `active_attempt_number`: clear claim fields without changing `attempt_count`, state, or the previously due time. No attempt started.
- Expired claim with an active attempt: lock the delivery, insert one immutable `unknown` evidence row for that active attempt, transition to `retrying` at the already persisted retry time or `dead_lettered` when the active attempt is 7, and clear claim/active fields atomically.
- The unique `(delivery_id, attempt_number)` key and owner/state predicates make recovery idempotent when multiple workers inspect the same expiry.
- A crash after the remote accepted the request but before finalization intentionally yields `unknown`; a later retry uses the same delivery ID/body so merchant deduplication can suppress a duplicate business effect.
- Recovery never marks an unknown request `delivered`, decrements attempt count, invents a new retry time, edits attempt evidence, or extends the seven-attempt budget.

### Rejected alternatives

- PostgreSQL locks spanning HTTP are rejected because network latency would hold transactions/locks and make crash handling unsafe.
- RabbitMQ delay/retry queues are rejected because PostgreSQL is the authoritative delivery lifecycle and existing topology must not change.
- Delivery without a lease, a global singleton dispatcher, or best-effort in-memory ownership is rejected because it cannot prevent concurrent sends or recover crashes safely.
- Reserializing the event or signing a wrapper is rejected because it violates the committed exact-byte contract.
- Following redirects, using ordinary resolver behavior after validation, or trying multiple resolved addresses is rejected because it reopens SSRF/double-effect paths.
- Storing response bodies, URLs, IPs, headers, signatures, secrets, ciphertext metadata, or arbitrary exception text is rejected as unnecessary sensitive evidence.
- Unlimited retries, `Retry-After`, reopening terminal rows, and manual row/queue replay are rejected or deferred by ADR-0019.
- A third-party HTTP/signing library is not justified; Node primitives can express pinned lookup, SNI/certificate validation, deadlines, body bounds, and HMAC.

## Affected modules and files

| Module/file area                                                                  | Ownership or change                                                                              | Boundary impact                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `docs/plans/2026-08-02-signed-webhook-delivery-and-retries.md`                    | Approved execution plan and later verification record                                            | Only file created in this planning milestone.                       |
| `prisma/schema.prisma`                                                            | Extend delivery states/lease fields and add immutable attempt model/enums                        | Webhooks-owned, non-financial schema only.                          |
| `prisma/migrations/<timestamp>_signed_webhook_delivery_and_retries/migration.sql` | Add states, columns, attempt table, constraints, indexes, trigger, and grants                    | Owner-applied additive migration; runtime remains non-owner.        |
| `packages/modules/webhooks/src/webhook-delivery.types.ts`                         | Internal claim, attempt, result, signature, and HTTP port types                                  | Public Webhooks boundary; no Eventing/Payments dependency.          |
| `packages/modules/webhooks/src/webhook-delivery-retry.ts` and unit test           | Exact seven-attempt classification and injected full jitter                                      | Pure deterministic policy.                                          |
| `packages/modules/webhooks/src/webhook-delivery-signature.ts` and unit test       | Exact ADR-0018 headers, HMAC input, encoding, and overlap selection                              | Uses Node crypto and existing secret port only.                     |
| `packages/modules/webhooks/src/node-webhook-http-client.ts` and unit test         | Pinned Node HTTP/HTTPS request, total deadline, response bound, no redirects                     | Outbound adapter owned by Webhooks.                                 |
| `packages/modules/webhooks/src/node-webhook-url-policy.ts` and tests              | Add delivery-time re-resolve/validate/pin result to the existing policy                          | One SSRF policy; endpoint registration behavior must not drift.     |
| `packages/modules/webhooks/src/webhook-secret-crypto.ts` and tests                | Bounded worker-side current/previous decrypt/select support if the existing port is insufficient | No secret format or endpoint API change.                            |
| `packages/modules/webhooks/src/prisma-webhook-delivery.repository.ts` and tests   | Reviewed claim/recovery/start/finalize SQL and attempt persistence                               | Raw SQL exception is confined to Webhooks.                          |
| `packages/modules/webhooks/src/webhook-delivery.service.ts` and tests             | Orchestrate preflight, signing, request, classification, and finalization                        | No broker acknowledgement or financial access.                      |
| `packages/modules/webhooks/src/index.ts`                                          | Export the worker composition surface only                                                       | Preserves package boundary.                                         |
| `apps/worker/src/config/environment.ts`, `.env.example`, and tests                | Validate keyring/URL policy and fixed dispatcher bounds                                          | Safe placeholders only; production local-provider failure retained. |
| `apps/worker/src/worker.module.ts`                                                | Compose repository, keyring, URL policy, signer, HTTP adapter, and dispatcher                    | Worker is lifecycle owner, not domain owner.                        |
| `apps/worker/src/runtime/worker-runtime.service.ts` and tests                     | Poll, cap concurrency, coordinate readiness/drain/socket cancellation                            | Existing relay/consumer continue independently.                     |
| New `apps/worker/src/runtime/webhook-delivery-signal.service.ts` and tests        | Bounded/redacted dispatcher signals                                                              | No payload/destination/secret telemetry.                            |
| `apps/worker/src/health/worker-health.service.ts` and tests                       | Add independently diagnosable dispatcher readiness                                               | Overall readiness still requires existing components.               |
| `packages/modules/webhooks/package.json` and root lockfile                        | No third-party addition expected; update only if workspace metadata changes                      | External dependency set must remain unchanged.                      |
| `test/integration/webhook-delivery.int-spec.ts`                                   | Real PostgreSQL plus controlled HTTP/DNS/TLS delivery evidence                                   | RabbitMQ is not required by the dispatcher path itself.             |
| Existing Prisma, endpoint, projection, worker, and integration tests              | Update schema/grant/readiness inventories and regression assertions                              | No API/event/topology behavior change.                              |
| `README.md`, `packages/README.md`, `SECURITY.md`                                  | Describe implemented sender, ownership, configuration, signing/redaction                         | Remove projection-only statements after implementation.             |
| New `docs/runbooks/webhook-delivery.md` and `docs/runbooks/README.md`             | Safe backlog/retry/dead-letter/lease diagnosis and recovery                                      | Explicitly prohibits manual replay/evidence edits.                  |
| `docs/events/README.md`                                                           | Document merchant verifier, exact headers/signature/replay guidance                              | Public Webhook contract addition, event body unchanged.             |
| Root `package.json` formatting globs/scripts if necessary                         | Include the new plan/runbook in normal checks                                                    | No feature dependency or new command surface required.              |

No implementation change is expected in API controllers, `docs/api/openapi.json`, endpoint API documentation, Merchant Access, Payments, Idempotency, Eventing topology/consumer/relay, Operations audit, Compose, or payment migrations.

## API and integration impact

- **REST/OpenAPI:** None. No endpoint is added or changed; `pnpm openapi:check` must remain byte-stable.
- **Payment Intent:** None. Existing create/read, merchant scoping, idempotency, response, and outbox behavior are regression gates only.
- **RabbitMQ/event contract:** No topology, publisher, queue, AMQP metadata, consumer, body, or acknowledgement change. The sender reads the committed Webhooks projection after broker processing is complete.
- **Outbound Webhook:** The exact body/header/signature contract in ADR-0018 becomes implemented behavior. Receivers must use raw bytes, enforce the five-minute default timestamp recency window, compare HMACs in constant time, and durably deduplicate by `SettleFlow-Webhook-Id`.
- **Compatibility:** Automatic retries keep one delivery ID and body but use a new timestamp/signature. Current-only and current-plus-previous headers are the only supported forms. An incompatible future contract requires a versioned ADR and coordinated rollout.
- **Audit:** Routine automatic attempt evidence goes to the immutable attempt table, not `audit_events`. There is no operator action or reason code in this slice.

## Database and migration impact

### Delivery status and lifecycle columns

Extend `webhook_delivery_status` with `retrying`, `delivered`, and `dead_lettered`. Keep existing `pending` values intact.

Change `webhook_deliveries.next_attempt_at` to nullable for terminal rows and add:

| Column                           | Type/limit                | Purpose                                                 |
| -------------------------------- | ------------------------- | ------------------------------------------------------- |
| `locked_by`                      | nullable `varchar(128)`   | Bounded worker/process claimant identity.               |
| `claim_token`                    | nullable UUID             | Unique owner-condition token for one claim.             |
| `locked_at`                      | nullable `timestamptz(6)` | Database claim instant.                                 |
| `lease_expires_at`               | nullable `timestamptz(6)` | Database-time 30-second expiry.                         |
| `active_attempt_number`          | nullable integer          | Durably started attempt awaiting finalization/recovery. |
| `active_attempt_started_at`      | nullable `timestamptz(6)` | Authoritative attempt start.                            |
| `active_signature_timestamp`     | nullable bigint           | Canonical epoch seconds used for signing.               |
| `active_current_secret_version`  | nullable integer          | Safe current secret version selected at start.          |
| `active_previous_secret_version` | nullable integer          | Safe optional previous version selected at start.       |
| `delivered_at`                   | nullable `timestamptz(6)` | Terminal success time.                                  |
| `dead_lettered_at`               | nullable `timestamptz(6)` | Terminal failure time.                                  |

Replace the projection-only `attempt_count = 0` and immediate-due checks with named lifecycle constraints that prove:

- `attempt_count` is between 0 and 7;
- claim fields are all null or all present, and `lease_expires_at > locked_at`;
- active fields are absent without a claim and, when present, `active_attempt_number = attempt_count` between 1 and 7;
- signature timestamp/current secret version are both present for a contact-capable started attempt; previous version is optional and positive;
- `pending` has count 0 unless a first attempt is active, while `retrying` has count 1 through 7 and a retry time when not terminal;
- `delivered` has `delivered_at`, no `dead_lettered_at`, no next attempt, and no claim/active fields;
- `dead_lettered` has `dead_lettered_at`, no `delivered_at`, no next attempt, and no claim/active fields;
- nonterminal unclaimed rows have a non-null `next_attempt_at`.

Exact inactive/no-contact evidence must fit the same constraint model without inventing signature metadata. If one constraint cannot distinguish contact-capable from non-contact starts safely, add a bounded active-attempt kind rather than weakening nullability globally.

Replace the existing due index with a partial index on `(next_attempt_at, id)` for `pending`/`retrying` unleased work. Add a partial recovery index on `(lease_expires_at, id)` for active claims. Inspect both with representative pending/terminal distributions.

### Immutable delivery attempts

Add enum `webhook_delivery_attempt_outcome` with `delivered`, `retryable_failure`, `non_retryable_failure`, and `unknown`, plus Webhooks-owned table `webhook_delivery_attempts`:

| Column                    | Type/limit             | Rule                                                         |
| ------------------------- | ---------------------- | ------------------------------------------------------------ |
| `id`                      | UUID primary key       | Internal only.                                               |
| `delivery_id`             | UUID foreign key       | `webhook_deliveries(id)` with `ON DELETE RESTRICT`.          |
| `attempt_number`          | integer                | 1 through 7; unique with delivery.                           |
| `outcome`                 | enum                   | One approved bounded result class.                           |
| `started_at`              | `timestamptz(6)`       | Durable active-attempt start.                                |
| `completed_at`            | `timestamptz(6)`       | Finalization or lease-recovery instant, not before start.    |
| `duration_ms`             | integer                | Nonnegative bounded duration derived from approved instants. |
| `http_status`             | nullable small integer | Valid HTTP status only; null for no/unknown response.        |
| `error_code`              | nullable `varchar(64)` | Stable allowlisted redacted code, never raw exception text.  |
| `response_body_sha256`    | nullable `bytea`       | Exactly 32 bytes only when complete bounded body was read.   |
| `response_body_truncated` | boolean                | True when diagnostic response exceeded 65,536 bytes.         |
| `signature_version`       | nullable `varchar(8)`  | `v1` for signed attempts; null for pre-contact evidence.     |
| `signature_timestamp`     | nullable bigint        | Canonical epoch seconds, not the signature bytes.            |
| `current_secret_version`  | nullable integer       | Safe positive version only.                                  |
| `previous_secret_version` | nullable integer       | Safe optional positive version only.                         |
| `created_at`              | `timestamptz(6)`       | Database insertion evidence.                                 |

Named checks must tie HTTP status/hash/truncation/signature fields to valid outcome shapes and reject prohibited/oversized data. Add unique `(delivery_id, attempt_number)` and an operator index such as `(outcome, completed_at, id)` only after query-plan justification.

An owner-created trigger must reject `UPDATE`, `DELETE`, and `TRUNCATE` on attempt rows. Grant `settleflow_app` only `SELECT`/`INSERT` on attempts and required `SELECT`/`UPDATE` on mutable deliveries/endpoints/secrets/projections; explicitly revoke destructive privileges. Integration tests must prove denial independent of application code.

### Migration order and compatibility

1. Apply the additive migration as owner before deploying a sender-capable worker.
2. Preserve all existing pending rows, their IDs, due times, tenant relations, and projection bodies.
3. Old workers may continue to create pending projection rows and ignore new states/columns; no destructive backfill is required.
4. Provision/verify `settleflow_app` grants after migration.
5. Validate the full migration history on empty PostgreSQL 18 and upgrade from the committed prior schema with existing rows.
6. Start one sender-capable worker, verify grants/claims/attempts/readiness, then scale within concurrency four per process only after observed database/endpoint behavior is safe.

The migration must use named constraints/indexes/triggers, reviewed parameterized raw SQL, bounded lock/statement timeouts, and no financial-table changes.

## Transaction boundaries and concurrency

- Claim/recovery/start/finalize transactions use PostgreSQL time. JavaScript time is never authoritative for due/lease/state decisions.
- Claim uses `FOR UPDATE SKIP LOCKED` and deterministic `(next_attempt_at, id)` order. The batch is capped by actual free dispatcher slots.
- Each claimed row receives a unique token. Every start, release, and finalization predicate includes the token and expected state/attempt so stale owners cannot write.
- Start increments exactly once and commits active-attempt plus retry metadata before external contact.
- HTTP is outside every transaction. No application lock substitutes for database ownership.
- Finalization inserts evidence and changes lifecycle atomically. A unique conflict or zero-row ownership condition cannot be retried by overwriting another owner.
- Recovery locks expired rows and inserts unknown evidence/state change in one transaction. Unique delivery/attempt evidence makes competing recovery idempotent.
- Routine Prisma queries may load endpoint/projection/secret data, but claim/recovery/owner-conditioned operations are reviewed raw SQL because Prisma cannot safely express `SKIP LOCKED` and conditional multi-step recovery.
- Serialization/deadlock/lock-timeout retry, if needed, retries the complete short transaction a maximum of three times with injected bounded backoff. Network work is never replayed as part of a SQL transaction retry.
- Two processes may each run concurrency four, but no delivery has two valid leases. A live request that outlasts its lease can be duplicated after recovery; the 8-second request bound versus 30-second lease minimizes this accepted at-least-once window.

## Security and privacy

- No public authentication/authorization path changes. Merchant ownership remains enforced by stored composite endpoint/event relations and repository predicates.
- Recheck endpoint active status immediately before attempt start. Inactive means no outbound contact and terminal evidence.
- Use the existing AES-256-GCM keyring abstraction. Current secret is mandatory; previous secret is decrypted only during strict overlap. Never fall back to previous-only signing.
- Local keyring values remain safe placeholders in committed examples. Production rejects the local provider; production delivery waits for a separately approved KMS adapter.
- Re-resolve every attempt and reject all answers if any address is prohibited. Pin one safe address while preserving TLS SNI/hostname verification and `Host`.
- No redirects, proxy-from-environment behavior, alternate IP retry, unbounded socket pool, or response decompression expansion. Bound connection reuse/agents explicitly or disable reuse until proven safe across pinned destinations.
- Validate stored identifiers/event metadata before building headers. No newline/header injection or arbitrary merchant header is possible.
- Keep plaintext secrets in the smallest scope; never put them, HMACs, ciphertext fields, key IDs, endpoint URLs/parts, resolved IPs, request/response bodies or headers, connection strings, or raw exceptions in evidence/telemetry.
- Attempt evidence contains stable identifiers, bounded status/result/error/timing, hashes, and safe version numbers only.
- Receiver documentation must require raw-body verification, canonical timestamp parsing, a five-minute default recency window, constant-time signature comparison, and durable delivery-ID deduplication.
- Security review must specifically cover SSRF/DNS rebinding, TLS hostname behavior, secret overlap boundary, timing-safe verification vectors, resource exhaustion, tenant isolation, and log/evidence redaction.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario                  | Expected safe state                          | Retry/recovery                                                                                         | Evidence                                            |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Two workers claim the same due row             | One claim owner only                         | Loser skips/gets zero rows                                                                             | Claim-token/state assertions and race test          |
| Crash after claim, before start                | Due state/count unchanged                    | Expiry clears claim; no attempt consumed                                                               | No attempt row; lease-recovery signal               |
| Keyring/config unavailable before start        | No request; no attempt                       | Dispatcher not ready; release/expiry then operator repair                                              | Stable dependency signal, no secret detail          |
| Endpoint inactive at send time                 | No DNS/HTTP; terminal                        | No automatic revival                                                                                   | One non-contact attempt, `endpoint_inactive`        |
| DNS transient failure                          | Attempt started; retry or terminal at 7      | Persist approved jitter time                                                                           | Retryable evidence, no address                      |
| Prohibited/mixed DNS answer                    | No unsafe HTTP; terminal                     | Owner corrects future endpoint through separately allowed lifecycle only; this delivery stays terminal | Stable SSRF code, no host/IP                        |
| TLS certificate/hostname failure               | No accepted connection; terminal             | No automatic retry                                                                                     | Stable TLS code                                     |
| Timeout/reset/refusal                          | Remote result may be absent/uncertain; retry | Same delivery/body, next approved time                                                                 | Retryable stable transport code                     |
| `2xx` with oversized body                      | Delivered                                    | Stop at 65,536 bytes/destroy or drain safely                                                           | Delivered, truncated true, no hash/body             |
| `408`/`429`/`5xx`                              | Retry until budget                           | Ignore `Retry-After`                                                                                   | Status plus retryable outcome                       |
| `3xx` or other `4xx`                           | Terminal, redirect never followed            | Future controlled replay only                                                                          | Non-retryable stable class                          |
| Crash after request/start, before finalization | Never falsely delivered                      | Lease recovery inserts one unknown and schedules retry/dead-letters at 7                               | Immutable unknown attempt                           |
| Stale owner finalizes after recovery           | New state preserved                          | Zero-row finalize; no overwrite                                                                        | Ownership-lost signal                               |
| Duplicate remote receipt                       | Same delivery ID/body                        | Merchant durable dedupe by delivery ID                                                                 | Stable header/evidence                              |
| Shutdown with in-flight requests               | No new claims; bounded drain                 | Complete within 10s or destroy socket; lease recovery handles unknown                                  | Drain result and later unknown evidence             |
| PostgreSQL unavailable                         | No claim/finalization; dispatcher not ready  | Poll stops/backoff; recover after access returns                                                       | Dependency signal; no request without durable start |
| RabbitMQ unavailable                           | Existing worker combined readiness fails     | Existing relay/consumer recovery; delivery DB state unchanged                                          | Existing component signals                          |
| Attempt 7 retryable/unknown                    | Terminal                                     | No automatic retry/reopen                                                                              | Attempt 7 plus `dead_lettered_at`                   |

## Observability and operations

Add bounded structured events or the repository's current signal abstraction for dispatcher starting, ready, unavailable, poll failed, claim batch, attempt started, delivered, retry scheduled, terminal failure, inactive stop, lease recovered, unknown recovered, ownership lost, drain started/completed/timed out, and stopped.

Safe fields are stable merchant/endpoint/event/delivery IDs, attempt number, state, stable result/error code, HTTP status, bounded duration, next retry time, claim/recovery counts, due age, and component readiness. Never emit payloads, destinations, resolved addresses, response content/headers, signatures, secrets/encryption metadata, or raw dependency exceptions.

Worker readiness adds `webhookDelivery` (or an equivalently explicit name):

- ready only when dispatcher configuration/keyring initialization is valid, PostgreSQL schema/grants are compatible, and the polling dispatcher is running;
- unavailable for keyring, schema/grant, database, or dispatcher lifecycle failure;
- unaffected globally by one merchant endpoint's DNS/HTTP failure;
- combined overall readiness still requires PostgreSQL, RabbitMQ publisher/topology, and active projection consumer.

Expose read-only runbook queries for due pending/retrying count/oldest age, active/expired leases, attempts by outcome/status, deliveries by terminal state, retry schedule, unknown recovery count, and dead-letter count/age. Environment-specific dashboards, thresholds, paging routes, and operator identities remain **To be decided** before production operations.

The Webhook delivery runbook must distinguish database dead-lettered deliveries from the RabbitMQ projection DLQ; diagnose dependency/configuration, endpoint, SSRF, timeout, and lease paths; verify catch-up after repair; and prohibit row edits, attempt mutation, terminal reopening, queue purge/movement, ad hoc resend, secret disclosure, and operator-shell HTTP replay.

## Test strategy

- **Unit — signatures:** Known HMAC vectors over exact bytes including Unicode/whitespace/property order; current-only and ordered overlap headers; exact expiry omission; new timestamp per retry; base64url without padding; missing current failure; no signature persistence/logging.
- **Unit — receiver sample/contract:** Raw-body preservation, header/body identity, canonical timestamp, five-minute recency boundary, supported/malformed signature parsing, constant-time current/previous match, and durable delivery-ID dedupe guidance.
- **Unit — retry/classification:** Every HTTP/transport/TLS/SSRF class, attempts 1-7, terminal budget, exact jitter ceilings and boundary samples, persisted next time, and ignored `Retry-After`.
- **Unit — URL/HTTP adapter:** Re-resolution on every attempt, all-answer validation, mixed safe/prohibited rejection, 16-answer/2-second bounds, one pinned IP, preserved Host/SNI/certificate validation, no alternate IP, no redirect, exact headers/content length/body bytes, 8-second total timeout, 65,536-byte response edge/truncation/hash rules, socket destruction/cancellation.
- **Unit — service:** Active/inactive gate, current/previous selection, claim/start/request/finalize order, no transaction around network, keyring failure before start, ownership loss, and redacted errors/signals.
- **Unit — worker:** Concurrency/batch/free-slot cap, 500 ms idle scheduling without leaked timers, dispatcher readiness aggregation, no endpoint failure global outage, shutdown stop-claim/drain/destroy/Prisma ordering, and existing relay/consumer regression.
- **Database constraints/migrations:** Apply full history to empty PostgreSQL 18 and upgrade the committed prior schema with pending rows. Exercise every enum, attempt-count, lease, active, state, terminal-time, response evidence, signature-version, unique/FK/index, trigger, and privilege constraint.
- **Concurrency/race:** Two claimers, claim versus projection insert, claim versus endpoint disable/rotation, start versus lease recovery, finalization versus recovery, two recoverers, duplicate finalization, and stale-owner write. Assert one immutable evidence row per delivery/attempt.
- **Integration — controlled HTTP:** Use real PostgreSQL and local ephemeral HTTP/HTTPS targets plus injected deterministic DNS/clock/jitter. Prove exact bytes/headers/signatures, current/previous overlap, 2xx, retryable/terminal classes, timeout, truncation, no redirect, inactive no-contact, retries, and terminal attempt 7.
- **Integration — failure injection:** Crash/abort after claim, after start before connect, after remote receipt before finalization, during response, and during shutdown; advance authoritative test time/lease and prove safe unknown recovery and duplicate-ready stable delivery ID.
- **Security:** Cross-merchant relation/predicate checks, SSRF special-address corpus, DNS rebinding/mixed answers, TLS SNI/hostname failure, header injection, secret/ciphertext/signature/URL/IP/body/log redaction, production local-keyring startup rejection, and runtime-role destructive denial.
- **Performance/resource:** Inspect due/recovery query plans with representative pending/terminal ratios; prove four active operations maximum, batch four, bounded sockets/timers/body buffers, and no poll spin under empty backlog.
- **Regression:** Projection consumer remains commit-before-ack and creates unchanged pending rows; outbox relay/topology/event contract, endpoint APIs/audit, Payment Intent, API readiness, migrations, OpenAPI, and production builds stay green.
- **Documentation/link checks:** Prettier/Markdown formatting, local-link resolution, known signature examples, `git diff --check`, and complete status inspection.

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
pnpm test:webhooks
pnpm test:worker
pnpm test:event-contract
pnpm test:integration
pnpm test
pnpm build
pnpm openapi:check
git diff --check
git status --short --branch
```

The real-dependency verification must additionally inspect read-only delivery/attempt counts, due age, leases, terminal states, and runtime grants through success, retry, crash, recovery, inactive, SSRF, and shutdown scenarios. If Docker is unavailable, record the exact blocker; mocks do not replace required PostgreSQL evidence.

## Documentation impact

- Update README setup/runtime sections with safe worker keyring/development-target configuration, dispatcher behavior, readiness, delivery states, retry schedule, and verification commands.
- Update package ownership documentation so Webhooks owns delivery and immutable attempt evidence and the worker composes the dispatcher.
- Update SECURITY with the implemented exact signing, overlap, SSRF re-resolution/pinning, response/resource bounds, receiver replay controls, and redaction rules.
- Add and index `docs/runbooks/webhook-delivery.md` with safe read-only diagnostics and prohibited actions.
- Update `docs/events/README.md` with exact body/headers/signature syntax, a tested receiver verification example, timestamp window, and delivery-ID deduplication guidance.
- Keep endpoint REST documentation and generated OpenAPI unchanged; verify the artifact does not drift.
- Do not document or imply a manual replay path, production local keyring, delivery deletion, new event type, or exactly-once HTTP transport.
- Update this plan's verification record/deviations during implementation and mark it Completed only after all definition-of-done gates pass.

## Rollback or forward-recovery strategy

The migration is applied before sender code and is additive. Before the first outbound request, disable/roll back the sender-capable worker while retaining schema and pending rows. Old projection workers can continue inserting pending deliveries.

After any attempt starts, rollback means stop new claims, drain within ten seconds or let leases expire, retain all delivery/attempt rows, and deploy a forward fix. Do not remove enum values/columns, decrement counts, reopen terminal states, change IDs/body bytes, edit/delete attempts, purge/move RabbitMQ messages, or resend from an operator shell.

An incompatible schema migration must be fixed forward with compatibility for already stored states/evidence. Production enablement remains blocked until a separately approved KMS adapter exists; local/reference verification uses only safe ignored test configuration.

## Risks and assumptions

| Risk or assumption                                         | Impact                                           | Mitigation/validation                                                                                         | Owner/deadline                    |
| ---------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Node pinned lookup/SNI behavior is implemented incorrectly | SSRF bypass or TLS failure                       | Focused adapter review and real TLS/DNS tests before enablement                                               | Engineering/Security before merge |
| Lease expires during a live request                        | Duplicate remote receipt                         | 8-second total bound versus 30-second lease, owner-conditioned finalize, stable delivery ID, unknown recovery | Engineering before merge          |
| Crash after remote acceptance                              | Outcome cannot be known                          | Persist active metadata first, recover one `unknown`, never infer success                                     | Engineering before merge          |
| Secret rotation races with attempt start                   | Wrong/extended overlap                           | Point-in-time selection, strict expiry, persist safe versions, boundary/concurrency tests                     | Security before merge             |
| Response/telemetry leaks merchant data                     | Privacy/secret exposure                          | Hard byte/evidence schemas, allowlisted error codes, redaction tests                                          | Security before merge             |
| Due/recovery indexes degrade with terminal volume          | Backlog/DB pressure                              | Partial indexes plus representative `EXPLAIN` evidence                                                        | Database owner before rollout     |
| Production KMS adapter does not exist                      | Production sender cannot start safely            | Preserve production local-provider failure; separate approved KMS milestone                                   | Project owner before production   |
| Manual replay/retention remains undefined                  | Operators cannot resend/delete terminal evidence | Keep terminal evidence immutable; separate ADR/plan required                                                  | Project owner, deferred           |
| Alert destinations/thresholds are unset                    | Weak production response                         | Mark To be decided in runbook; define before production                                                       | Operations before production      |
| Existing projection may insert while migration deploys     | Compatibility regression                         | Additive nullable columns/defaults and prior-worker upgrade test                                              | Engineering before merge          |

No unresolved design decision blocks implementation of this approved local/reference slice. Production KMS, alert routing, retention, and manual replay are explicit later milestones and must not be improvised here.

## Implementation order

1. Reconfirm clean main, accepted ADRs, schema/grants, exact projection bytes, endpoint secret lifecycle, URL policy, worker lifecycle, and regression commands.
2. Update this plan to `In progress` and record any evidence-driven deviation before code/schema work.
3. Add Prisma enums/fields/attempt model and hand-author the named PostgreSQL migration, immutability trigger, partial indexes, and least-privilege grants.
4. Validate empty-database/prior-schema upgrades, constraints, runtime permissions, and query plans before enabling a dispatcher.
5. Implement pure retry/classification and exact signature/header builders with known vectors.
6. Extend the existing URL policy and build the bounded pinned Node HTTP/HTTPS adapter with security/resource tests.
7. Implement Webhooks claim/recovery/start/finalize persistence and race/failure tests.
8. Implement the Webhooks delivery application service, including inactive/keyring/ownership-loss paths.
9. Add worker configuration, safe examples, composition, scheduling/concurrency, readiness, signals, and graceful shutdown.
10. Add real PostgreSQL and controlled HTTP/DNS/TLS integration tests, including crash/lease recovery and all result classes.
11. Update README, ownership/security/event docs, and the indexed delivery runbook; keep OpenAPI/RabbitMQ contracts unchanged.
12. Run the complete verification matrix, inspect every diff and generated artifact, record results/deviations, and leave changes uncommitted for review.

## Execution checklist

- [x] Design and boundaries reviewed through accepted ADR-0018 and ADR-0019.
- [x] Required architecture decisions approved.
- [x] Plan status changed to `In progress` when implementation begins.
- [x] Schema/migration, grants, and immutability evidence completed.
- [x] Signature, SSRF, HTTP resource, retry, recovery, and concurrency implementation completed.
- [x] Worker lifecycle/readiness and safe configuration completed.
- [x] Unit, real-dependency, failure, security, and regression tests pass.
- [x] Documentation, receiver guidance, and runbook updated.
- [x] Commands/results and deviations recorded below.

## Verification record

| Command or review                                        | Result                                                                                                   | Date/evidence                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Git baseline at `980d053`                                | Clean `main`, synchronized with `origin/main`                                                            | 2026-08-02 planning inspection   |
| ADR-0018/ADR-0019 and current schema/worker inspection   | Complete; plan introduces no conflicting decision                                                        | 2026-08-02 planning inspection   |
| Markdown formatting for this plan                        | Passed targeted Prettier check                                                                           | 2026-08-02 planning verification |
| Local Markdown link resolution                           | Passed; all 11 referenced local targets resolved                                                         | 2026-08-02 planning verification |
| `git diff --check` and planning status                   | Passed; only this plan was untracked                                                                     | 2026-08-02 planning verification |
| Implementation baseline at `9336306`                     | Clean `main`, synchronized with `origin/main`                                                            | 2026-08-02 implementation start  |
| `corepack pnpm@11.18.0 install --frozen-lockfile`        | Passed; all 10 workspace projects already matched the lockfile                                           | 2026-08-02 implementation        |
| Compose/provision/Prisma validation and migration checks | PostgreSQL 18.4 and RabbitMQ 4.3.4 healthy; runtime role provisioned; schema valid; 6 migrations current | 2026-08-02 implementation        |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`       | Passed with zero warnings/errors                                                                         | 2026-08-02 implementation        |
| Focused Webhooks/worker/event-contract unit tests        | Passed: 49 Webhooks, 10 worker, and 15 event-contract tests                                              | 2026-08-02 implementation        |
| Focused real PostgreSQL delivery integration             | Passed: 6 tests covering exact bytes/signatures, overlap, seven attempts, recovery, inactivity, races    | 2026-08-02 implementation        |
| `pnpm test:integration`                                  | Passed on final run: 8 suites, 49 tests; see note below                                                  | 2026-08-02 implementation        |
| `pnpm test`                                              | Passed: 32 suites, 141 tests across all 8 unit projects                                                  | 2026-08-02 implementation        |
| `pnpm build` and `pnpm openapi:check`                    | Passed; API and worker production builds succeeded and OpenAPI remained byte-stable                      | 2026-08-02 implementation        |
| Markdown links, `git diff --check`, and final status     | Passed; implementation changes remain uncommitted                                                        | 2026-08-02 implementation        |

The first complete integration run exposed a missing synthetic worker-keyring fixture in the existing outbox-relay composition test; the fixture was updated and its nine tests passed. A later complete run had one transient failure in the pre-existing Payment Intent concurrency storm under container load. That suite then passed alone (13 tests), and the complete integration matrix passed on rerun (49 tests). No product behavior or test expectation was weakened.

## Definition of done

- The additive migration safely upgrades existing pending deliveries, enforces four lifecycle states, lease/active/terminal consistency, seven-attempt bounds, immutable evidence, indexes, and least privilege.
- Due delivery claims are deterministic, concurrency-safe, short, owner-conditioned, bounded by four, and recover both pre-start abandonment and post-start unknown outcomes without network work in a transaction.
- Every durably started attempt produces exactly one immutable evidence row and ends in the approved delivered/retrying/dead-lettered state; no terminal row is automatically reopened.
- HTTP requests use exact retained bytes, exact ADR-0018 headers and HMAC input/encoding/order, strict current/previous overlap, and stable delivery/event identity.
- Every attempt re-resolves and validates the canonical destination, pins one approved address with correct Host/SNI/certificate checks, follows no redirect, obeys the 8-second/65,536-byte bounds, and leaks no prohibited evidence.
- All result classes, full-jitter ceilings, attempt budget, inactive stop, crash boundaries, stale-owner behavior, and shutdown recovery are proven in focused and real-dependency tests.
- Worker readiness separately diagnoses the dispatcher while preserving PostgreSQL/RabbitMQ relay/consumer requirements; shutdown stops claims and drains/destroys within ten seconds without leaked timers/sockets.
- Endpoint APIs, Payment Intent behavior, event bytes/AMQP topology, OpenAPI, projection eligibility, audit behavior, and all financial invariants remain unchanged.
- README, ownership/security/event guidance, and an indexed safe operations runbook accurately describe the implemented behavior and prohibited actions.
- Formatting, lint, type-check, Prisma validation/migration status, tests, builds, OpenAPI check, `git diff --check`, and complete Git status pass, with results/deviations recorded and no commit or push performed by the implementation task.
