# Implementation Plan: Webhook Endpoint Foundation

- **Status:** Approved
- **Owner:** SettleFlow Project
- **Created:** 2026-08-01
- **Last updated:** 2026-08-01
- **Related issue/PR:** None
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md), [ADR-0008](../adr/0008-api-version-path-and-compatibility.md), [ADR-0013](../adr/0013-problem-details-audit-and-retention-boundaries.md), [ADR-0014](../adr/0014-webhook-endpoint-url-and-ssrf-policy.md), [ADR-0015](../adr/0015-webhook-signing-secret-encryption-and-rotation.md), [ADR-0016](../adr/0016-webhook-endpoint-api-ownership-and-subscriptions.md), [ADR-0017](../adr/0017-webhook-endpoint-lifecycle-audit.md)

## Goal

Implement the specification-authorized, merchant-scoped Webhook Endpoint Foundation. A merchant can create, list, inspect, deactivate/reactivate, change subscriptions on, and rotate the signing secret for a webhook endpoint through the accepted `/v1` API. Endpoint ownership, URL safety, encrypted secret storage, optimistic concurrency, and append-only lifecycle audit must be enforced durably.

The measurable outcome is that all five endpoint-management routes work against PostgreSQL with tenant-safe predicates, safe one-time secret responses, deterministic URL policy, atomic audit evidence, and the approved runtime-role boundary, while all existing API, worker, Payment Intent, and outbox-relay behavior remains compatible.

This plan records the project owner's 2026-08-01 approval of the implementation selections that complete ADR-0014 through ADR-0017:

- API and worker use the separate non-owner PostgreSQL login role `settleflow_app`; migrations and role provisioning use an owner credential. The runtime role cannot update, delete, or truncate lifecycle audit.
- Strong ETags use the exact representation `"<publicId>.v<version>"`.
- List pagination is descending by public ID, with a default limit of 20 and maximum of 100.
- A semantic no-op PATCH returns `200` without incrementing the version or appending audit. A PATCH changing status and subscriptions appends two correlated audit events.
- Secret rotation is permitted while an endpoint is inactive.
- The URL policy uses Node.js facilities and a checked-in IANA-derived address registry, a two-second DNS deadline, at most 16 distinct answers, and an explicit development-origin allowlist.
- The first keyring is local-only, uses the environment contract defined below, retains a KMS abstraction, and fails startup if selected in production.

### Non-goals

- No external HTTP webhook delivery, signing-header contract, redirect handling implementation, delivery retry state machine, delivery attempt, or manual replay.
- No RabbitMQ consumer, inbox/deduplication record, webhook-delivery projection, new exchange/queue, or change to the accepted outbox relay.
- No historical fanout. Endpoint eligibility is evaluated by the future projection consumer only when an event is durably processed.
- No Payment Intent, capture, authorization, refund, ledger, balance, settlement, reconciliation, provider, or other financial behavior change.
- No endpoint deletion, URL mutation, secret redisplay, secret recovery API, or plaintext secret persistence.
- No production KMS adapter, production outbound egress configuration, or claim of production readiness for the local keyring.
- No audit retention deletion, secret-ciphertext cleanup, or destructive retention job.
- No user/JWT/session authentication, operator API, or merchant self-service onboarding.

## Specification traceability

- **Sections:** FR-09 webhook endpoint registration and management; FR-10 future webhook delivery constraints; FR-13 safe API errors and correlation; FR-14 auditability; webhook security; core data model; threat model; specification ADR-007.
- **Requirement IDs:** FR-09, FR-13, and FR-14 are implemented by this foundation. FR-10 is traceability for future compatibility only; delivery is explicitly deferred.
- **Invariant IDs:** No financial state is changed. INV-09 and INV-10 remain relevant as cross-cutting audit/asynchronous integrity constraints: this milestone neither publishes nor consumes an event, and it preserves the future inbox-protected, at-least-once boundary.
- **Acceptance/release gates:** Merchant isolation, least-privilege database permissions, endpoint and secret constraints, URL/SSRF corpus, encryption/tamper behavior, ETag races, atomic audit commit/rollback, one-time disclosure, RFC 9457/OpenAPI contract, migration upgrade paths, and existing regression suites are release-blocking.

The authoritative product source remains the [v1.0 specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx). The design follows the [architecture overview](../architecture/README.md), [module boundaries](../architecture/module-boundaries.md), [financial invariants](../architecture/financial-invariants.md), and [security policy](../../SECURITY.md). It does not extend the authorized domain beyond those sources and the accepted ADRs.

## Existing behavior

The following evidence was inspected before this plan was written:

- [Repository governance](../../AGENTS.md), [planning policy](../../PLANS.md), and [contribution gates](../../CONTRIBUTING.md).
- The accepted ADR index and ADR-0014 through ADR-0017, which authorize URL policy, encrypted signing secrets and rotation, merchant-owned endpoint APIs/subscriptions, and Operations-owned atomic lifecycle audit.
- The current [Prisma schema](../../prisma/schema.prisma) and migrations. They contain Merchant Access, Payment Intent, idempotency, and outbox persistence, but no webhook endpoint, subscription, secret, delivery, inbox, or audit tables.
- `packages/modules/merchant-access`, which already recognizes `webhooks:read` and `webhooks:manage`, authenticates bearer API keys, and exposes merchant ID, internal API-key ID, scopes, and request identity to API handlers.
- `packages/infrastructure`, which supplies the shared Prisma lifecycle, transaction-client type, database error classification, and exact `ulid@3.0.2` process-scoped monotonic generator used for prefixed public IDs.
- `apps/api`, which already has global Merchant API-key authentication, scope decorators, request IDs, RFC 9457 problem responses, OpenAPI generation, `/v1/payment-intents`, and graceful database shutdown.
- `apps/worker` and `packages/modules/eventing`, which use the same database credential and operate the committed transactional-outbox relay. Their access must continue under the new runtime role.
- [The transactional-outbox relay plan](2026-08-01-transactional-outbox-relay.md), which reserves the future `payment.created.v1` projection queue but does not authorize consuming it here.
- Root scripts, Testcontainers configuration, PostgreSQL 18 Compose service, environment examples, and existing migration/OpenAPI/static verification commands.

The current API and worker `DATABASE_URL` values use the database owner. Prisma CLI also reads `DATABASE_URL`. There is no runtime-role provisioning command or owner/runtime credential split. Readiness currently checks PostgreSQL and RabbitMQ and must retain that behavior.

## Proposed design

### Ownership and dependency direction

- Create a `@settleflow/webhooks` bounded package. It owns endpoint, subscription, and encrypted-secret domain/application code and is the only module permitted to mutate those tables.
- Create a minimal `@settleflow/operations` bounded package. It owns `audit_events`, the append-only repository, its safe record vocabulary, and the transaction-aware audit append port.
- Webhooks depends only on the Operations application port for audit and passes the same Prisma transaction context. It must not import or write the Operations repository or table directly.
- The API transport authenticates with existing Merchant Access, enforces the route scope, constructs an allowlisted actor context, and calls Webhooks. Merchant Access does not depend on Webhooks.
- Infrastructure owns Prisma lifecycle, cryptographic/keyring and DNS adapter mechanics, and prefixed ULID generation adapters; domain policy contracts remain owned by Webhooks.
- Eventing, Payments, and the worker do not import or query Webhooks for this milestone. The future projection consumer will call a Webhooks eligibility port inside an inbox-protected transaction.

### Endpoint aggregate and public contract

- Public IDs are exactly `whe_` plus a 26-character uppercase Crockford ULID. Reuse the existing exact `ulid@3.0.2` monotonic adapter as one process-scoped provider. Retry only a named `webhook_endpoints_public_id_key` collision, with at most three total ID attempts.
- An endpoint starts at status `active` and version `0`. Public status values are `active` and `inactive`.
- The URL is immutable. The one persisted URL is the canonical value produced by the URL policy. It is unique per merchant across active and inactive endpoints.
- Subscriptions are a nonempty relational set. The only value accepted in this milestone is `payment.created.v1`; duplicate, empty, and unsupported values are rejected.
- An endpoint is eligible for a future event only when it is active and subscribed at the instant the future inbox-protected consumer processes that event. There is no historical fanout.
- Plaintext signing secrets are emitted only by the successful create or rotation response after commit. Every other response uses allowlisted safe endpoint fields.

The common endpoint representation is:

```json
{
  "id": "whe_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "url": "https://merchant.example/webhooks/settleflow",
  "status": "active",
  "subscriptions": ["payment.created.v1"],
  "version": 0,
  "createdAt": "2026-08-01T00:00:00.000Z",
  "updatedAt": "2026-08-01T00:00:00.000Z"
}
```

Dates are UTC RFC 3339 strings. Subscriptions are sorted lexically before persistence comparisons and in every response, so response and no-op behavior is deterministic.

### API routes

| Method  | Path                                          | Required scope    | Success behavior                                                                                                                                                                               |
| ------- | --------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`  | `/v1/webhook-endpoints`                       | `webhooks:manage` | `201`; create an active endpoint, return the common representation plus `secret`, `ETag`, and `Cache-Control: no-store`.                                                                       |
| `GET`   | `/v1/webhook-endpoints`                       | `webhooks:read`   | `200`; return `{ "data": [...], "nextCursor": string                                                                                                                                           | null }` with no secret material. |
| `GET`   | `/v1/webhook-endpoints/{id}`                  | `webhooks:read`   | `200`; return the common representation and `ETag`.                                                                                                                                            |
| `PATCH` | `/v1/webhook-endpoints/{id}`                  | `webhooks:manage` | `200`; replace status and/or the complete subscription set under `If-Match`, then return the common representation and `ETag`.                                                                 |
| `POST`  | `/v1/webhook-endpoints/{id}/secret-rotations` | `webhooks:manage` | `200`; rotate under `If-Match`, including while inactive, and return `id`, one-time `secret`, `previousSecretExpiresAt`, `version`, and `updatedAt` with `ETag` and `Cache-Control: no-store`. |

Create accepts exactly:

```json
{
  "url": "https://merchant.example/webhooks/settleflow",
  "subscriptions": ["payment.created.v1"]
}
```

PATCH accepts at least one of `status` or `subscriptions`. Each supplied field represents its complete desired value. `url`, unknown fields, an empty object, duplicate subscriptions, or an empty subscription set are invalid. The rotation request has no body.

Every repository read and write predicate includes the authenticated merchant UUID. A missing endpoint and an endpoint owned by another merchant both return the same `404 webhook_endpoint_not_found` response. No route accepts a merchant ID, API-key ID, version, secret version, encryption key ID, or internal UUID from the request body.

### ETag and optimistic concurrency

- A version `n` for public ID `whe_...` is represented exactly as the strong ETag `"whe_....v<n>"`, including the quotes. Version syntax is canonical nonnegative decimal with no sign or leading zero except `0`.
- Create, GET by ID, successful PATCH, and successful rotation return `ETag`. List does not assign an aggregate ETag.
- PATCH and rotation require exactly one strong `If-Match`. Missing returns `428 precondition_required`. Duplicate, comma-list, weak, wildcard, malformed, or wrong-public-ID values return `400 invalid_request`. A well-formed ETag that is not current returns `412 precondition_failed`.
- The transport parser inspects raw request headers so duplicate `If-Match` fields cannot be silently combined by Node.js.
- The version is checked after taking the tenant-scoped row lock. A successful state mutation or rotation increments it exactly once.
- A PATCH whose normalized desired status and subscription set equal the locked current values returns `200` with the unchanged representation/ETag. It does not update timestamps, increment the version, or append an audit row. The precondition must still be current.
- A PATCH changing both status and subscriptions increments once and appends two audit rows with the same request ID, occurrence time, endpoint ID, merchant/actor identity, and new aggregate version.

### Keyset pagination

- `limit` defaults to 20 and accepts canonical base-10 integers from 1 through 100. Invalid, repeated, fractional, signed, or out-of-range values return `400 invalid_request`.
- Order is `public_id DESC`, scoped by merchant. The migration adds `(merchant_id, public_id DESC)`.
- The opaque cursor is unpadded base64url of canonical UTF-8 JSON with exact shape `{"v":1,"id":"<last-public-id>"}`. Unknown/missing fields, noncanonical encoding, an unsupported version, or an invalid endpoint ID returns `400 invalid_request`.
- A subsequent page uses `merchant_id = ? AND public_id < ?`, orders descending, and fetches `limit + 1` to compute `nextCursor`. The response always contains `data` and `nextCursor`, using `null` when no page remains.
- Public IDs never change, so concurrent new inserts do not duplicate existing rows across pages. This is keyset traversal, not a historical snapshot guarantee.

### URL normalization and SSRF policy

The Webhooks-owned URL-policy port has production and explicit development adapters built with Node.js APIs; no new third-party URL, DNS, or IP package is planned.

1. Reject non-string, malformed, ambiguous, credential-bearing, fragment-bearing, and unsupported-scheme input. Reject ASCII control characters. Both submitted and canonical UTF-8 forms must be 1 through 2,048 bytes.
2. Use the WHATWG `URL` implementation to lowercase scheme and IDNA/ASCII hostname, remove one terminal DNS dot, remove an explicit default port, normalize an empty path to `/`, and serialize parser-canonical path/percent-encoding. Preserve path/query semantics, order, and case otherwise.
3. Production permits only `https` with effective port 443. Literal IPs are subject to the same address rules as DNS answers.
4. Use a dedicated `node:dns/promises` `Resolver` per validation. Resolve `A` and `AAAA`, enforce one two-second deadline, cancel the resolver at the deadline, deduplicate answers, and accept no more than 16 combined distinct addresses.
5. A no-data result for one address family is acceptable if the other succeeds. NXDOMAIN or no usable address returns `422 webhook_endpoint_url_unresolvable`. Timeout, SERVFAIL, resolver unavailability, or another transient family failure fails closed with `503 service_unavailable`; it does not persist or audit an endpoint.
6. Normalize each literal/final answer, including IPv4-mapped IPv6, through `node:net` parsing and compare it with a checked-in, source/date-annotated IANA-derived special-purpose range registry using `SocketAddress`/`BlockList`. Reject the entire hostname if any answer is loopback, private, link-local, unspecified, multicast, carrier-grade NAT, documentation, benchmarking, reserved/future-use, cloud metadata, non-global, malformed, or if the answer limit is exceeded. Return redacted `422 webhook_endpoint_url_prohibited`.
7. DNS resolution occurs before the database transaction. Registration makes no HTTP request. No DNS result, address, hostname, or URL path/query enters audit, problem detail, logs, or traces.

Development uses this exact configuration surface:

```dotenv
WEBHOOK_URL_POLICY_MODE=development
WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS=["http://127.0.0.1:8080"]
```

The allowlist is a JSON array of exact canonical origins. Development mode retains the production checks for ordinary URLs and grants a local HTTP/address exception only when the canonical origin exactly matches an injected entry. There is no `allowPrivate`, wildcard, suffix, or validation-disable switch. Production startup rejects development mode and any configured development origins.

Future delivery must reuse this policy, re-resolve immediately before every connection, pin the connection to one approved answer, preserve the original hostname for TLS SNI/certificate verification, disable redirects, and reapply port/egress controls. Those transport actions are requirements for the later delivery plan, not this implementation.

### Signing-secret encryption and local keyring

- Generate `whsec_` plus the unpadded base64url representation of 32 bytes from `node:crypto.randomBytes`; the result is exactly 49 ASCII bytes.
- Encrypt with AES-256-GCM, one random 12-byte nonce per encryption, and a 16-byte authentication tag. Persist ciphertext, nonce, tag, algorithm, key ID, secret version, lifecycle, and timestamps only.
- The exact UTF-8 authenticated additional data is NUL-delimited:

  ```text
  settleflow.webhook-secret.v1\0<merchant UUID>\0<endpoint UUID>\0<secret version>\0aes-256-gcm\0<key ID>
  ```

- AAD field values are canonical and length-bounded. Any tag, ciphertext, context, algorithm, or key-ID mismatch fails closed without logging secret material.
- Cryptographic generation/encryption occurs before the write transaction. Plaintext has the narrowest practical lifetime and is returned only after a successful commit.
- The keyring port exposes the active key ID for encryption and key-by-ID decryption. Domain/API code never receives the raw keyring map. New writes use one active key while bounded old key IDs remain available for future decryption/re-encryption.
- No decryption is needed by endpoint management in this milestone. The adapter and tests still prove authenticated round trips so the stored envelope is usable by the future signing boundary.

The local adapter uses exactly:

```dotenv
WEBHOOK_KEYRING_PROVIDER=local
WEBHOOK_LOCAL_ACTIVE_KEY_ID=local-v1
WEBHOOK_LOCAL_KEYS_JSON={"local-v1":"<32-byte-base64url-key>"}
```

The JSON object maps bounded safe key IDs to unpadded base64url-encoded 32-byte keys. Checked-in examples contain only an invalid placeholder and a command for generating an ignored local value. Missing, duplicate-equivalent, malformed, non-32-byte, unknown-active-key, or excess key entries fail startup with a redacted error. `NODE_ENV=production` plus `WEBHOOK_KEYRING_PROVIDER=local` always fails startup. A future production KMS/envelope adapter will implement the same port and is required before production readiness.

### Rotation lifecycle

- An endpoint has exactly one `current` secret, at most one `previous` secret, and any number of retained `retired` encrypted records.
- Rotation is allowed for active or inactive endpoints and always requires the current ETag.
- A preliminary tenant-scoped read obtains the internal endpoint ID and next secret version. The service generates/encrypts the candidate outside a transaction, then locks the owned endpoint and rechecks the ETag inside the transaction.
- At one authoritative rotation instant, retire any prior `previous`, promote the current secret to `previous` with `overlap_expires_at = rotation instant + 24 hours`, insert the candidate as `current`, increment the endpoint version once, and append `webhook_endpoint.secret_rotated` audit evidence.
- If the ETag became stale or any database/audit operation fails, the transaction rolls back and the candidate plaintext/envelope is discarded. Two rotations using the same ETag have one winner; the loser receives `412`.
- The successful response displays only the new plaintext and `previousSecretExpiresAt`. A lost response cannot be recovered or replayed. The merchant lists/finds the endpoint and performs another preconditioned rotation.
- Future signing may use the current secret and the previous secret only until `overlap_expires_at`. Time, not cleanup, determines eligibility. Retired/expired ciphertext cleanup is not authorized here.

### RFC 9457 errors

All failures use `application/problem+json`, the existing stable `type`, `title`, `status`, `code`, safe `detail`, canonical `requestId`, and allowlisted field violations from ADR-0013.

| Status | Stable code                         | Use                                                                                                                        |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `invalid_request`                   | Invalid JSON/body/field/public ID/limit/cursor/ETag syntax, duplicate `If-Match`, immutable URL attempt, or unknown field. |
| `401`  | `unauthorized`                      | Missing or invalid merchant API key.                                                                                       |
| `403`  | `insufficient_scope`                | Missing `webhooks:read` or `webhooks:manage`.                                                                              |
| `404`  | `webhook_endpoint_not_found`        | Missing or foreign-merchant endpoint.                                                                                      |
| `409`  | `webhook_endpoint_url_conflict`     | Canonical URL already exists for the merchant.                                                                             |
| `412`  | `precondition_failed`               | Well-formed ETag is stale/noncurrent.                                                                                      |
| `422`  | `unsupported_webhook_event`         | Unsupported subscription value.                                                                                            |
| `422`  | `webhook_endpoint_url_prohibited`   | Scheme/port/address/answer-count violates the endpoint policy.                                                             |
| `422`  | `webhook_endpoint_url_unresolvable` | Stable NXDOMAIN or no usable address.                                                                                      |
| `428`  | `precondition_required`             | PATCH/rotation lacks `If-Match`.                                                                                           |
| `503`  | `service_unavailable`               | Database, transient DNS, or selected keyring dependency is unavailable.                                                    |
| `500`  | `internal_error`                    | Unexpected failure without internal detail.                                                                                |

Unique and check errors are mapped only by reviewed named constraint. Unknown database errors remain safe `500`/`503` classifications. No response reveals existence across merchants, SQL/constraint text, encryption fields, raw request content, resolved addresses, or sensitive URL components.

### Alternatives considered and rejected

- Database-owner credentials in API/worker were rejected because a defect could bypass table-level ownership and audit immutability controls.
- Mutable URLs or status-coupled uniqueness were rejected because endpoint identity/audit would become ambiguous and inactive duplicates would create unsafe reactivation races.
- Offset pagination was rejected because concurrent inserts make page traversal unstable and unbounded offsets degrade.
- Last-write-wins updates or a body version were rejected in favor of standard strong HTTP preconditions.
- Treating a no-op as a mutation was rejected because it creates misleading version and audit history.
- JSON/array subscriptions were rejected because normalized rows provide uniqueness, constraints, and future eligibility queries.
- Hash-only or plaintext signing secrets were rejected because future delivery must recover signing material without exposing it at rest.
- Asynchronous/best-effort audit was rejected because it permits successful lifecycle changes without durable evidence.
- A shared `allowPrivate` development switch or registration-only SSRF validation was rejected because either can become a production bypass.
- A third-party URL/IP library is unnecessary for this slice; Node.js parsing/resolution plus a reviewed checked-in IANA registry keeps the supply-chain delta at zero. The registry's maintenance cost is accepted and tested.
- Requiring a production KMS for local development was rejected, while using the local provider in production is explicitly prohibited.

## Affected modules and files

These are the expected implementation changes. Naming may be adjusted mechanically during coding, but an ownership, transaction, contract, or scope change requires this plan to be updated before proceeding.

| Module/file area                                                                                      | Ownership or change                                                                                                                                                     | Boundary impact                                                           |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `docs/plans/2026-08-01-webhook-endpoint-foundation.md`                                                | Living approved plan and verification record.                                                                                                                           | No runtime impact.                                                        |
| `prisma/schema.prisma`                                                                                | Add Webhooks endpoint/subscription/secret models and Operations audit model/relations/enums.                                                                            | Each model retains one owning module.                                     |
| `prisma/migrations/<timestamp>_webhook_endpoint_foundation/migration.sql`                             | Add tables, named constraints/indexes, deferred aggregate triggers, append-only audit triggers, and least-privilege grants.                                             | Owner-applied additive migration; no financial table behavior changes.    |
| `tools/database/provision-runtime-role.mjs` and `tools/database/provision-runtime-role.sql`           | Idempotently create/alter the local/CI `settleflow_app` role and schema/database access before migration.                                                               | Cluster-level role provisioning stays outside Prisma domain migrations.   |
| `prisma.config.mts`                                                                                   | Make Prisma CLI consume `MIGRATION_DATABASE_URL`; runtime continues to consume `DATABASE_URL`.                                                                          | Separates owner and runtime authority.                                    |
| `compose.yaml`, `.env.example`, `apps/api/.env.example`, `apps/worker/.env.example`                   | Supply safe local role inputs/runtime URLs and URL/keyring settings; never real production secrets.                                                                     | API and worker use the same non-owner runtime role.                       |
| `packages/modules/operations/package.json`, `tsconfig.build.json`, `src/*`                            | New Operations audit types, append port/service, safe validation, and Prisma append-only repository.                                                                    | Webhooks can append only through the Operations port.                     |
| `packages/modules/webhooks/package.json`, `tsconfig.build.json`, `src/*`                              | New endpoint aggregate, commands/queries, repository, URL policy, keyring/encryption ports/adapters, validation, errors, ETag-independent version semantics, and tests. | Webhooks owns its tables; no Eventing/Payments dependency.                |
| `packages/infrastructure/src/index.ts` and generated Prisma client                                    | Export only generic adapters/types genuinely shared; reuse process-scoped ULID and Prisma lifecycle.                                                                    | No domain ownership moves into Infrastructure.                            |
| `apps/api/src/webhook-endpoints/*`                                                                    | Controller, exact DTO/body/header/query parsing, ETag/cursor transport helpers, and OpenAPI decorators/tests.                                                           | API translates authenticated Merchant Access context into Webhooks calls. |
| `apps/api/src/app.module.ts`, `config/environment.ts`, `http/problem-details.filter.ts`, `openapi.ts` | Wire services/adapters/config, add safe problems and route schemas.                                                                                                     | Existing global auth/readiness/lifecycle remains intact.                  |
| `package.json`, `jest.config.cjs`, TypeScript/package exports, `pnpm-lock.yaml`                       | Add workspace build/test mappings and scripts. No new third-party dependency is expected.                                                                               | New packages join existing static/build gates.                            |
| `test/integration/webhook-endpoints.int-spec.ts`                                                      | Real PostgreSQL/API behavior, races, constraints, role grants, and rollback tests.                                                                                      | Uses both owner/migration and runtime credentials explicitly.             |
| Existing integration fixtures and `test/integration/prisma-data-foundation.int-spec.ts`               | Provision runtime role before migrations and verify upgrade/permission behavior.                                                                                        | Existing Payment Intent and relay regressions run as `settleflow_app`.    |
| `docs/api/webhook-endpoints.md`, `docs/api/openapi.json`, `README.md`, `packages/README.md`           | Document API, local key generation, owner/runtime setup, commands, and module ownership.                                                                                | Public contract becomes reviewable and reproducible.                      |
| `docs/runbooks/webhook-endpoint-foundation.md`, `docs/runbooks/README.md`, `SECURITY.md`              | Add DNS/keyring/audit/role diagnosis and redaction/security guidance.                                                                                                   | No delivery operations are introduced.                                    |

No direct cross-module table write is permitted. If implementation requires Webhooks to import Eventing/Payments internals, Operations to mutate endpoint rows, or a network call inside a transaction, stop and update the design.

## API and integration impact

- Adds only the five `/v1/webhook-endpoints` management routes above. The accepted `/v1` path remains canonical; no `/api/v1` alias is added.
- Uses existing bearer API-key authentication and the already recognized `webhooks:read`/`webhooks:manage` scopes. No new scope vocabulary or key issuance endpoint is needed.
- Adds strong ETag/If-Match behavior and one descending keyset list contract. These must be represented exactly in generated OpenAPI, including headers, bounds, examples, and every RFC 9457 response.
- Secret-bearing create/rotation responses set `Cache-Control: no-store`; schemas clearly mark `secret` write-only/one-time by description and exclude encryption internals.
- Does not publish an outbox event, consume RabbitMQ, or change `payment.created.v1`, AMQP metadata, topology, API readiness, or current Payment Intent responses.
- Establishes relational subscriptions needed by the future projection consumer. It does not create delivery rows or define an external webhook body/signature.
- No CSV or frontend contract changes.

## Database and migration impact

### Webhooks-owned tables

#### `webhook_endpoints`

| Column                     | Type/rule                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `id`                       | UUID primary key; generated before encryption so it can be included in AAD.          |
| `public_id`                | `varchar(30)`; globally unique; exact `^whe_[0-9A-HJKMNP-TV-Z]{26}$`.                |
| `merchant_id`              | UUID; restrictive named FK to `merchants(id)`.                                       |
| `normalized_url`           | `text`; canonical source of truth, 1..2,048 UTF-8 bytes, no control characters.      |
| `status`                   | PostgreSQL enum `webhook_endpoint_status`: `active` or `inactive`; default `active`. |
| `version`                  | integer, default `0`, check `>= 0`.                                                  |
| `created_at`, `updated_at` | `timestamptz(6)`; authoritative UTC. A no-op does not change `updated_at`.           |

Named database objects include `webhook_endpoints_pkey`, `webhook_endpoints_public_id_key`, `webhook_endpoints_public_id_check`, `webhook_endpoints_merchant_id_normalized_url_key`, `webhook_endpoints_normalized_url_length_check`, `webhook_endpoints_normalized_url_control_character_check`, `webhook_endpoints_version_check`, `webhook_endpoints_merchant_id_fkey`, and `webhook_endpoints_merchant_id_public_id_idx` on `(merchant_id, public_id DESC)`.

#### `webhook_endpoint_subscriptions`

| Column        | Type/rule                                                               |
| ------------- | ----------------------------------------------------------------------- |
| `endpoint_id` | UUID; restrictive named FK to `webhook_endpoints(id)`.                  |
| `event_type`  | `varchar(128)`; exact initial allowlist check for `payment.created.v1`. |
| `created_at`  | `timestamptz(6)`.                                                       |

The primary key is `(endpoint_id, event_type)`. A deferred constraint-trigger pair covers endpoint insertion and subscription insert/update/delete so every endpoint has at least one subscription at transaction commit. This closes the gap that a subscription-table-only trigger would leave for an endpoint inserted with no rows. The function checks each affected old/new endpoint ID and reports a stable named constraint failure.

#### `webhook_endpoint_secrets`

| Column               | Type/rule                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `id`                 | UUID primary key.                                                                          |
| `endpoint_id`        | UUID; restrictive named FK to `webhook_endpoints(id)`.                                     |
| `secret_version`     | integer, check `>= 1`; unique per endpoint.                                                |
| `lifecycle`          | PostgreSQL enum `webhook_secret_lifecycle`: `current`, `previous`, `retired`.              |
| `algorithm`          | `varchar(32)`; check exact `aes-256-gcm`.                                                  |
| `encryption_key_id`  | `varchar(64)`; bounded safe key identifier.                                                |
| `nonce`              | `bytea`; check exactly 12 bytes.                                                           |
| `ciphertext`         | `bytea`; check exactly 49 bytes for the accepted plaintext format.                         |
| `authentication_tag` | `bytea`; check exactly 16 bytes.                                                           |
| `overlap_expires_at` | nullable `timestamptz(6)`; required only for `previous`; may remain on `retired` evidence. |
| `retired_at`         | nullable `timestamptz(6)`; required only for `retired`.                                    |
| `created_at`         | `timestamptz(6)`.                                                                          |

Named lifecycle checks enforce: current has neither expiry nor retired time; previous has an expiry and no retired time; retired has a retired time. Partial unique indexes permit at most one current and at most one previous row per endpoint. Deferred constraint triggers on endpoint and secret changes require exactly one current row at commit. These constraints allow create/rotation to make intermediate changes only inside one transaction and prevent direct invalid states.

### Operations-owned `audit_events`

| Column                      | Type/rule                                                                      |
| --------------------------- | ------------------------------------------------------------------------------ |
| `id`                        | UUID primary key.                                                              |
| `merchant_id`               | UUID; restrictive named FK to `merchants(id)`.                                 |
| `actor_type`                | `varchar(32)`; exact `merchant_api_key`.                                       |
| `actor_api_key_id`          | UUID; restrictive named FK to `api_keys(id)`.                                  |
| `action`                    | `varchar(128)`; one of the four codes below.                                   |
| `target_type`               | `varchar(64)`; exact `webhook_endpoint`.                                       |
| `target_id`                 | `varchar(30)`; exact `whe_<ULID>` public ID; intentionally no cross-module FK. |
| `reason`                    | `varchar(64)`; exact `merchant_api_request`.                                   |
| `request_id`                | `varchar(128)`; canonical request/correlation ID.                              |
| `details`                   | `jsonb`; object only and bounded to 4,096 serialized bytes.                    |
| `occurred_at`, `created_at` | `timestamptz(6)`; authoritative UTC.                                           |

The exact action codes are:

- `webhook_endpoint.created`
- `webhook_endpoint.secret_rotated`
- `webhook_endpoint.status_changed`
- `webhook_endpoint.subscriptions_changed`

Safe `details` contains only the committed aggregate version, changed field names, and non-sensitive status/event-type before/after values needed for review. It never contains a URL/host/IP, secret or envelope field, key ID, API-key material, request body, ETag, exception, or SQL text.

Indexes cover `(merchant_id, occurred_at DESC, id DESC)` and `(target_type, target_id, occurred_at DESC, id DESC)`. A row-level `BEFORE UPDATE OR DELETE` trigger and a statement-level `BEFORE TRUNCATE` trigger reject mutation even under an accidentally overprivileged application path. `settleflow_app` receives `SELECT, INSERT` only for this table and explicit denial/no grant for `UPDATE, DELETE, TRUNCATE`. No cleanup migration/job is added.

### Runtime-role provisioning and grants

Cluster-level role creation is not hidden inside the Prisma migration. The implementation adds an idempotent owner-run provisioning command that:

- creates or updates login `settleflow_app` from local/CI environment inputs;
- enforces `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS` and no object ownership;
- grants only database connect and public-schema usage before migrations;
- never prints the supplied password or complete connection strings; and
- works against both fresh and existing Compose volumes and ephemeral Testcontainers databases.

The owner applies Prisma migrations with `MIGRATION_DATABASE_URL`. Each reviewed migration grants the runtime role only the table/sequence operations required by API and worker. The foundation migration also applies explicit grants to all pre-existing application tables so Payment Intent creation/readiness and outbox relay continue after API/worker `DATABASE_URL` moves to `settleflow_app`. Future migrations must grant new objects deliberately; broad ownership, schema create, database create, role create, bypass-RLS, and default `DELETE`/`TRUNCATE` are not granted.

Local examples use synthetic development-only `POSTGRES_APP_USER`/`POSTGRES_APP_PASSWORD`. Prisma CLI commands fail clearly when the owner URL is absent. API and worker environment validation continues to require only the non-owner runtime `DATABASE_URL`; neither process loads `MIGRATION_DATABASE_URL`.

### Migration ordering and compatibility

1. Add role configuration/provisioning tooling while API/worker still use owner URLs.
2. Start PostgreSQL and provision `settleflow_app` idempotently.
3. Apply the additive Webhooks/Operations migration as owner. It creates all models, constraints/triggers/indexes, and grants existing/new objects.
4. Generate Prisma and build modules/API/worker.
5. Switch local/API/worker runtime URLs to `settleflow_app` and run existing plus new regressions.
6. Expose management routes only after schema, grants, keyring, URL policy, and audit tests pass.

Test both an empty database and upgrade from the current `20260801095331_payment_intent_m1_database_foundation` history. Apply deploy/status twice to prove repeat safety. Migrations are forward-only after shared deployment; no table or audit row is dropped during rollback.

No financial table, column, constraint, or value changes. No backfill is required because all new tables start empty.

## Transaction boundaries and concurrency

PostgreSQL remains the only authoritative store. Use existing Prisma transaction lifecycle and reviewed, parameterized raw SQL only for tenant-scoped `SELECT ... FOR UPDATE`, exact conditional version behavior, or deferred-constraint behavior Prisma cannot safely express. Start with five-second lock timeout and ten-second statement timeout configuration for Webhook endpoint commands; map timeout/deadlock/transient connection failures safely and retry only a complete eligible transaction, at most the existing bounded repository policy. Network and cryptographic work never occurs while locks are held.

### Create

1. Authenticate/scope and strictly validate the body.
2. Normalize/resolve/apply URL policy outside a transaction.
3. Generate internal endpoint UUID, candidate `whe_<ULID>`, version-1 signing secret, nonce, and encrypted envelope outside a transaction.
4. In one short transaction insert endpoint, normalized subscriptions, current secret, and one Operations `webhook_endpoint.created` audit row.
5. Commit before rendering the response. Then return the plaintext once.

A named canonical URL conflict returns `409` with complete rollback. Retry only a named public-ID uniqueness collision, at most three total ID attempts. Audit or constraint failure rolls back endpoint/subscription/secret state together.

### PATCH

1. Parse/normalize desired fields before the transaction; there is no DNS or crypto work.
2. In one transaction select the endpoint by `(merchant_id, public_id) FOR UPDATE` and compare the strong ETag version.
3. Load/compare normalized subscriptions. If no semantic change, return the locked current representation without a write/audit/version increment.
4. Otherwise update supplied changed dimensions and subscriptions, increment endpoint version once, and set `updated_at` once.
5. Append one status audit row and/or one subscription audit row through the Operations port. A combined change writes two rows correlated by request ID, occurrence time, target, and new version.
6. Commit all state/audit or roll back all of it.

### Secret rotation

1. Tenant-read endpoint/internal ID and next secret version; generate/encrypt outside the transaction.
2. In one transaction lock by `(merchant_id, public_id)`, recheck ETag, and read the current/previous secret rows.
3. Retire the old previous if present, promote current to previous with the exact 24-hour expiry, insert new current, increment endpoint version once, and append one rotation audit row.
4. Commit, then return plaintext once. Inactive status does not block the command.

The locked version is the single-winner boundary. PATCH/PATCH, PATCH/rotation, and rotation/rotation using one ETag permit exactly one version-changing commit; every loser receives `412` and leaves no audit or secret lifecycle residue. Read Committed plus explicit row locks is sufficient; uniqueness/deferred constraints remain defense in depth.

Endpoint management does not use Payment idempotency keys or response snapshots. Retrying after an unknown create/rotation response can intentionally create/rotate again; documentation explains list/get plus preconditioned rotation recovery without ever redisplaying a committed secret.

## Security and privacy

- Existing merchant API-key authentication is mandatory. Route scopes and repository merchant predicates are independent controls.
- Runtime processes do not own database objects and cannot create/alter/drop schema objects. Audit insert/read is separated from forbidden mutation/destruction by grants and triggers.
- URL input is an SSRF boundary. Parsing, canonicalization, DNS deadlines/limits, every-answer global-address checks, explicit local-development policy, and redaction are required before persistence.
- Future delivery must re-resolve; registration-time success is never treated as permanent network authorization.
- Secret plaintext exists only in bounded process memory during create/rotation and the one successful response. It never enters Prisma JSON, audit, logs, traces, snapshots, exceptions, fixtures, or committed examples.
- AES-GCM nonces use cryptographic randomness and are never reused intentionally. AAD prevents cross-merchant, cross-endpoint, version, algorithm, or key-ID ciphertext substitution.
- Local key material exists only in ignored environment state. Safe examples contain invalid placeholders. Production explicitly rejects the local provider; a reviewed KMS adapter remains a production gate.
- Responses are allowlisted DTOs. GET/list/PATCH omit plaintext and encryption metadata. Problems and telemetry omit full/canonical URL, hostname, DNS answers, secret values, headers, and raw body.
- Mutation audit attributes merchant, internal API-key actor, request ID, stable public target, action, occurrence time, and safe deltas. Rejected requests and reads do not create durable audit rows.
- No HTTP probe, webhook send, RabbitMQ operation, or new outbound destination contact occurs in this milestone beyond bounded DNS resolution during create.
- Run dependency audit even though no new external dependency is expected; use built-in Node crypto/DNS/net and the already pinned ULID package.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario                    | Expected safe state                                                                                           | Retry/recovery                                                             | Evidence                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| Missing/invalid key or scope                     | No DNS, database mutation, secret generation, or audit.                                                       | Correct credential/scope.                                                  | API unit/integration tests.           |
| Malformed/prohibited URL or stable NXDOMAIN      | No row or audit; redacted `422`.                                                                              | Merchant submits a permitted resolvable URL.                               | URL corpus and HTTP tests.            |
| DNS timeout/SERVFAIL                             | No row or audit; safe `503`.                                                                                  | Client may retry; no durable command exists.                               | Injected resolver failure tests.      |
| Mixed allowed/prohibited or more than 16 answers | Entire URL rejected; no partial acceptance.                                                                   | Fix destination DNS.                                                       | Deterministic resolver tests.         |
| Canonical URL race                               | Unique constraint permits one endpoint; loser gets `409`.                                                     | List existing endpoint; no automatic retry.                                | PostgreSQL concurrency test.          |
| `whe_` collision                                 | Failed transaction leaves no rows/audit.                                                                      | Generate and retry only this constraint, up to three attempts; then `503`. | Injected generator/integration tests. |
| Keyring/config/crypto failure                    | Startup fails or command returns safe service failure before transaction.                                     | Correct ignored configuration; never log keys.                             | Environment/adapter tests.            |
| Audit append failure                             | Endpoint, subscription, secret, and version all roll back.                                                    | Retry full request after dependency recovery.                              | Forced database failure test.         |
| Missing `If-Match`                               | No lock/mutation/audit; `428`.                                                                                | GET current ETag and retry.                                                | Contract tests.                       |
| Stale concurrent mutation                        | One commit; loser `412`; no loser audit/envelope state.                                                       | GET current state and intentionally retry.                                 | Three race matrices.                  |
| Semantic no-op PATCH                             | `200`; state, timestamp, version, audit count unchanged.                                                      | None.                                                                      | Unit and database tests.              |
| Lost create response                             | Endpoint may be committed but secret is unrecoverable.                                                        | List/get by URL, then rotate under ETag.                                   | Failure guidance/contract test.       |
| Lost rotation response                           | New version is committed but new secret is unrecoverable.                                                     | GET current ETag and rotate again.                                         | Failure guidance/rotation test.       |
| Runtime role absent or under-granted             | Migration preflight/startup/readiness fails; no owner fallback.                                               | Provision/fix grants as owner, then restart.                               | Permission and upgrade tests.         |
| Runtime role attempts audit mutation/truncate    | Database denies; evidence remains unchanged.                                                                  | Investigate defect; use append-only correction/forward fix.                | Negative privilege/trigger tests.     |
| Database outage mid-transaction                  | Transaction rolls back; no partial endpoint/audit state.                                                      | Restore DB and retry whole command.                                        | Connection termination tests.         |
| RabbitMQ outage                                  | Existing API readiness remains non-ready, but endpoint commands have no broker dependency and do not publish. | Restore broker for readiness; endpoint state remains authoritative.        | Integration outage regression.        |
| Old local encryption key removed                 | Stored envelopes using it cannot be decrypted later.                                                          | Restore retained key; plan KMS re-encryption before removal.               | Unknown-key tests/runbook.            |
| URL later resolves privately                     | No delivery exists here; future sender must fail closed on re-resolution.                                     | Future delivery policy handles safe retry/terminal state.                  | Deferred delivery acceptance gate.    |

There is no dead-letter or duplicate-message behavior in this slice because no message is consumed or published. The future projection consumer must add inbox uniqueness and acknowledge only after its Webhooks effect commits.

## Observability and operations

- Add bounded structured events for endpoint command success/failure class, URL-policy outcome class, optimistic conflict, audit append failure, and keyring startup state. Safe fields are event name, request ID, merchant ID, internal API-key ID, endpoint public ID when known, action, status code, version, duration, and stable reason code.
- Never emit URL/host/path/query, DNS answers, plaintext/ciphertext/nonce/tag/key ID/key map, Authorization/If-Match headers, raw bodies, SQL, or stack details to client-facing telemetry.
- Existing liveness/readiness remains process/dependency based: PostgreSQL and RabbitMQ requirements do not change. DNS is request-time and is not a readiness dependency. Keyring configuration is validated at startup; an invalid/local-in-production provider prevents startup rather than reporting false readiness.
- Add an operator runbook for role provisioning/grant diagnosis, DNS error classes and IANA-registry provenance, keyring startup/decryption failures, audit-write failures, URL-conflict recovery, lost one-time response recovery, and safe endpoint disablement.
- Document bounded audit growth queries using the owner/read-only operator path. Audit retention remains indefinite and there is no cleanup command.
- Prometheus-specific metrics and alerts may be added in a later observability milestone; structured signals and audit evidence are required now and do not become authoritative state.

## Test strategy

- **Unit — URL/SSRF:** WHATWG canonical-equivalence corpus; submitted/canonical byte limits; IDNA/trailing dot/default port/empty path; query/path preservation; malformed/userinfo/fragment/control/scheme/port rejection; IPv4, IPv6, mapped, integer/octal-like, encoded-host, metadata, every IANA non-global category; mixed answers; duplicate answers; 16/17-answer boundary; one-family no-data; NXDOMAIN; timeout/cancel; transient family failure; explicit development origins; production rejection and redaction.
- **Unit — crypto/keyring:** secret prefix/decoded entropy/length; nonce/tag/ciphertext lengths; injected known vector; tamper every component; AAD merchant/endpoint/version/algorithm/key-ID swaps; active/old key selection; malformed/unknown key; local production failure; no secret in errors/log records; deterministic random-source failure.
- **Unit — domain/application:** request allowlists, status/subscription normalization, unsupported/duplicate/empty sets, `whe_` generation/collision attempts, ETag generation/parsing/raw duplicate detection, cursor canonical encoding/bounds, no-op PATCH, audit action/details construction, rotation while inactive, 24-hour boundary, and repository error mapping.
- **Unit — API:** scope decorators, merchant context propagation, request/response DTO allowlists, headers/cache controls, every problem code, missing/foreign indistinguishability, and OpenAPI decorator shapes.
- **Database constraints/migrations:** empty deployment, prior-version upgrade, repeat status/deploy, exact models/columns/named constraints/indexes/FKs/checks; endpoint format/version/URL rules; subscription nonempty deferred trigger including endpoint-only insert; secret exact-current/at-most-previous/lifecycle/length rules; audit JSON/action/target rules; append-only row/truncate triggers; no schema/financial drift.
- **Runtime permissions:** provision twice; prove API/worker connection is `settleflow_app` and non-owner/non-superuser; prove existing Payment Intent and outbox relay operations still work; prove schema DDL and audit update/delete/truncate fail; prove Operations can insert/read audit; prove owner migration remains separate.
- **Integration with real dependencies:** Testcontainers PostgreSQL for all endpoint HTTP operations/atomicity/permissions. Use deterministic injected DNS rather than public DNS. Start RabbitMQ only for existing readiness/relay regression and prove endpoint commands do not call it.
- **Tenant/scope/security:** two merchants with read/manage/no-scope keys; all foreign/missing operations; canonical URL same/different merchant; inactive uniqueness; secret one-time fields; database/log/audit fixture scans for URL and secret material; malformed header/query/body fuzz corpus.
- **Concurrency/race:** simultaneous canonical-URL creates; PATCH/PATCH, PATCH/rotation, and rotation/rotation with the same ETag; combined PATCH audit correlation; audit failure rollback; repeated rotations and previous retirement; public-ID collision exhaustion.
- **Failure injection/recovery:** resolver timeout/temporary error, random/keyring failure, database disconnect before/during commit, lock timeout, named/unknown constraint errors, response-loss guidance, runtime-role under-grant, and RabbitMQ outage without endpoint-command coupling.
- **Contract:** Generate and drift-check OpenAPI for all five routes, headers, page cursor/limit, one-time secrets, enums, RFC 9457 schemas/examples, and absence of internal fields. Preserve current Payment Intent/OpenAPI contract.
- **Performance:** Query plans use merchant/public-ID and merchant/URL indexes. Bound body, URL, subscription count, DNS time/answers, cursor size, page size, JSON audit size, keyring entry count, and database transaction duration. No unbounded list or network wait is accepted.
- **Documentation/link checks:** README/API/runbook commands, local links, Prettier, generated OpenAPI drift, `git diff --check`, complete diff inspection, and final status.

Expected implementation verification commands are:

```powershell
git status --short --branch
corepack pnpm install --frozen-lockfile
pnpm infra:up
pnpm infra:ps
pnpm db:provision-runtime-role
pnpm prisma:validate
pnpm prisma:generate
pnpm db:migrate:apply
pnpm db:migrate:status
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:webhooks
pnpm test:operations
pnpm test:integration
pnpm openapi:check
pnpm build
pnpm audit --audit-level high
git diff --check
git status --short --branch
```

`test:webhooks`, `test:operations`, and `db:provision-runtime-role` are **To be defined during implementation**; they are not claimed as current passing commands. Runtime verification also exercises all five routes with scoped keys, ETag races, Compose health, existing Payment Intent routes, worker relay startup/shutdown, PostgreSQL/RabbitMQ outage/recovery, and graceful API/worker shutdown.

## Documentation impact

- Add a Webhook Endpoint API guide with exact request/response/header/error examples and explicit one-time-secret/lost-response behavior.
- Regenerate and check `docs/api/openapi.json` from source; never hand-edit behavior independently.
- Update root setup for role provisioning, owner migration URL, runtime URLs, local key generation, endpoint commands, testing, inspection, and recovery.
- Update package ownership documentation for Webhooks and Operations and the typed audit port.
- Update security guidance for SSRF, IANA registry maintenance, local keyring prohibition in production, redaction, least privilege, and audit immutability.
- Add/index the endpoint-foundation runbook. Do not add delivery/replay instructions before those features exist.
- Keep this plan's checklist, verification record, deviations, and final migration filename current as implementation proceeds.
- No ADR change is expected. A change to URL semantics, secret algorithm/overlap, route ownership, audit atomicity/retention, or approved role boundary requires a new/superseding ADR before code.

## Rollback or forward-recovery strategy

- Before routes are exposed, new code can be disabled while leaving additive empty tables/grants in place. After shared migration, prefer a forward fix; do not drop endpoint, secret, or audit evidence as an application rollback.
- Provision the runtime role and grants before switching runtime URLs. If a grant is missing, keep processes unavailable and add a reviewed owner-applied grant migration; never fall back silently to owner credentials.
- If URL or crypto policy is defective, disable endpoint writes and forward-fix. Do not add a bypass, mutate canonical URLs, or decrypt/export stored secrets.
- A failed create/rotation transaction leaves no endpoint lifecycle or audit evidence. A committed one remains authoritative even if the response is lost; recover through list/get and another rotation, not database edits.
- Preserve every key ID needed to decrypt retained ciphertext. Key removal requires a future approved re-encryption/KMS migration; restoring the old key is the immediate recovery.
- Audit corrections append new authorized evidence. Neither runtime nor routine owner operations update/delete/truncate prior audit rows.
- A future canonicalization or IANA-policy change requires compatibility analysis and, if stored identities change, a versioned forward migration plan before deployment.
- Existing financial, idempotency, outbox, and relay rows are untouched. Their regressions must pass under the new role before rollout.

## Risks and assumptions

| Risk or assumption                                              | Impact                                                                   | Mitigation/validation                                                                                                            | Owner/deadline                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Existing Compose volumes do not run init scripts again.         | Runtime role/grants could be missing after upgrade.                      | Explicit idempotent post-start provisioning command; test fresh and reused clusters.                                             | SettleFlow Project / implementation milestone       |
| Prisma migration runs before cluster role provisioning.         | `GRANT` fails and migration cannot deploy.                               | Document/enforce provision-before-migrate preflight with clear owner-only command.                                               | SettleFlow Project / before migration apply         |
| Shared API/worker runtime role needs current table permissions. | Existing Payment Intent or relay could regress.                          | Enumerate explicit existing grants and run full API/worker integration suites as that role.                                      | SettleFlow Project / before route exposure          |
| IANA special-purpose registry changes.                          | Checked-in SSRF classification can become stale.                         | Record source/date, test all ranges, review/update through security change control; retain egress defense in depth.              | SettleFlow Project / each security release          |
| DNS is available but slow/inconsistent.                         | Valid create may fail closed or different answers may appear.            | Two-second deadline, 16-answer cap, deterministic errors, injected tests, future delivery re-resolution.                         | SettleFlow Project / implementation milestone       |
| WHATWG or IP normalization edge cases bypass checks.            | Internal network access could become possible in future delivery.        | Fixed adversarial corpus, mapped-address normalization, every-answer checks, no delivery until re-resolution/pinning tests pass. | SettleFlow Project / security gate                  |
| AES-GCM nonce reuse or AAD drift.                               | Confidentiality/integrity can fail or old data can become undecryptable. | Cryptographic RNG, exact versioned AAD codec, known-vector/tamper tests, no implicit format changes.                             | SettleFlow Project / security gate                  |
| Local key leaks or is removed.                                  | Secret compromise or inability to sign future deliveries.                | Ignored config, redaction scans, bounded keyring, production failure, documented retention/recovery.                             | SettleFlow Project / before local use               |
| Production has no KMS adapter.                                  | Foundation is not production-ready.                                      | Explicit startup failure for local provider; KMS selection/operations are a later approved milestone.                            | Project owner / before production deployment        |
| Concurrent mutations create misleading audit/version state.     | Lost updates or incomplete evidence.                                     | Tenant row lock, strong If-Match, one increment, same-transaction one/two audit rows, race tests.                                | SettleFlow Project / implementation milestone       |
| Audit table grows indefinitely.                                 | Storage/maintenance pressure.                                            | Bounded records, growth queries/runbook, future approved retention decision; no unapproved deletion.                             | Project owner / before production capacity planning |
| One-time response is lost.                                      | Merchant lacks current plaintext secret.                                 | Clear list/get then rotation recovery; never persist/replay plaintext.                                                           | SettleFlow Project / API documentation gate         |
| Future projection eligibility races endpoint changes.           | Wrong fanout set if queried outside its transaction.                     | Schema supports normalized query; future consumer must evaluate active+subscribed in its inbox-protected transaction.            | Project owner / projection milestone                |

There are no unresolved decisions blocking this foundation. The production KMS/provider, external signature header/body, delivery retries, projection inbox, delivery persistence, metrics backend, and destructive retention policy remain explicitly deferred and require their own approval before implementation.

## Implementation order

1. Reconfirm clean baseline, accepted ADRs, module dependency direction, and this approved plan.
2. Add the owner/runtime environment split and idempotent local/CI `settleflow_app` provisioning path without switching running processes yet.
3. Add Prisma models and one reviewed additive migration with exact constraints, deferred triggers, append-only controls, indexes, and explicit existing/new-object grants; validate empty and upgrade paths.
4. Generate Prisma and implement the minimal Operations audit package/transaction-aware append port first.
5. Implement Webhooks domain types, validation, errors, repository contracts, aggregate commands/queries, and process-scoped `whe_` identifier generation.
6. Implement and exhaustively unit-test the production/development URL policy, DNS resolver deadline/answer cap, IANA address registry, and redaction.
7. Implement and test secret generation, AES-256-GCM AAD codec, local keyring adapter/configuration, and production startup rejection.
8. Implement Prisma repositories and create/PATCH/rotation transaction flows, including locks, no-op behavior, two-event combined audit, collision bounds, and failure mapping.
9. Wire API configuration/modules/controllers, exact ETag/cursor parsers, RFC 9457 mappings, response cache controls, and graceful lifecycle under the runtime role.
10. Add OpenAPI source/contract documentation and focused unit/PostgreSQL/API concurrency/security tests.
11. Switch API/worker local runtime URLs to `settleflow_app`; run all existing Payment Intent, readiness, and relay regressions plus permission/outage/shutdown checks.
12. Finish README/security/runbook/package documentation, run the complete verification matrix, inspect the full diff, and record results/deviations in this plan before handoff.

## Execution checklist

- [x] Design and boundaries reviewed.
- [x] Required ADR/specification decisions approved by the project owner on 2026-08-01.
- [x] Runtime-role, ETag, pagination, no-op/combined-audit, inactive rotation, SSRF, and local-keyring selections recorded.
- [ ] Runtime role provisioning and owner/runtime credential split completed.
- [ ] Prisma schema, migration, constraints, triggers, indexes, and grants completed.
- [ ] Operations audit and Webhooks endpoint modules completed.
- [ ] Five API routes and OpenAPI contract completed.
- [ ] Unit, PostgreSQL integration, concurrency, permission, and failure scenarios pass.
- [ ] Security, secret/redaction, SSRF, audit, and sensitive-data review pass.
- [ ] Existing API/worker/Payment Intent/outbox behavior passes under `settleflow_app`.
- [ ] Documentation and runbooks updated.
- [ ] Commands/results and deviations recorded below.

## Verification record

| Command or review                                          | Result  | Date/evidence                                                                                                                           |
| ---------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline `git status --short --branch`                     | Pass    | 2026-08-01: `## main...origin/main`; clean before this plan was created.                                                                |
| Accepted ADR/design and existing implementation inspection | Pass    | 2026-08-01: governance, ADR-0014 through ADR-0017, schema, modules, scripts, environment, Compose, and existing plan evidence reviewed. |
| Plan-specific Prettier check                               | Pass    | 2026-08-01: direct Prettier check passed.                                                                                               |
| Local Markdown-link validation                             | Pass    | 2026-08-01: all 19 local links in this plan resolve.                                                                                    |
| `git diff --check` and untracked-file whitespace check     | Pass    | 2026-08-01: no whitespace errors; the untracked plan was also checked as a no-index diff from an empty file.                            |
| Final `git status --short --branch`                        | Pass    | 2026-08-01: `## main...origin/main` with only `?? docs/plans/2026-08-01-webhook-endpoint-foundation.md`; no commit or push.             |
| Implementation/migration/runtime verification              | Not run | Deliberately deferred; this milestone creates documentation only.                                                                       |

## Definition of done

This plan's implementation is complete only when:

- all five authorized merchant-scoped routes and exact scope, ETag, pagination, validation, error, and one-time-secret contracts are implemented and OpenAPI-drift checked;
- Webhooks exclusively owns endpoint/subscription/secret state and Operations exclusively owns append-only audit, connected only through the transaction-aware application port;
- PostgreSQL constraints make invalid endpoint, subscription, secret lifecycle, and audit states uncommittable, and every required successful mutation/audit commits or rolls back together;
- API and worker run as non-owner `settleflow_app`, owner credentials are migration/provisioning-only, audit mutation/destruction is denied, and all existing behaviors pass under the runtime role;
- URL canonicalization, DNS limits, global-address enforcement, development allowlist, encryption/AAD/keyring, production failure, redaction, tenant, scope, collision, and race tests pass;
- no HTTP webhook delivery, RabbitMQ consumer/inbox, delivery projection, financial behavior, or destructive retention code enters the diff;
- migration, static, unit, integration, contract, permission, outage, build, security-audit, documentation/link, whitespace, and complete-status gates pass;
- documentation and runbooks contain exact safe setup/recovery commands, this plan records final evidence/deviations, and no commit or push occurs unless separately authorized.

The current plan-only milestone is complete when this file is the sole worktree change, its local links and Markdown format pass, `git diff --check` passes, and final status is recorded without any implementation change, commit, or push.
