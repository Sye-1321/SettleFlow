# Architecture Decision Records

ADRs record material SettleFlow design decisions and their consequences. Use [0000-adr-template.md](0000-adr-template.md) and name new records `NNNN-short-title.md` with a monotonically increasing four-digit number.

## Decision index

| ADR                                                                      | Status   | Decision                                                                                                             | Specification baseline                                       |
| ------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [ADR-0001](0001-nestjs-modular-monolith-and-two-deployables.md)          | Accepted | NestJS and TypeScript modular monolith with separate API and worker deployables                                      | Records specification ADR-001                                |
| [ADR-0002](0002-node-typescript-package-manager-and-version-policy.md)   | Accepted | Current verified Node.js LTS policy, TypeScript, pnpm workspaces, and exact-version pinning during scaffolding       | Refines the technology/dependency baseline                   |
| [ADR-0003](0003-postgresql-prisma-and-financial-data-access.md)          | Accepted | PostgreSQL authority, Prisma default access, and narrow reviewed parameterized raw-SQL exceptions                    | Records PostgreSQL portion of ADR-002 and ADR-005            |
| [ADR-0004](0004-rabbitmq-outbox-inbox-and-message-delivery.md)           | Accepted | RabbitMQ at-least-once delivery with outbox, inbox, confirms, manual acknowledgements, and dead-letter recovery      | Records RabbitMQ portion of ADR-002 and ADR-003              |
| [ADR-0005](0005-local-development-and-test-environment.md)               | Accepted | Docker Compose supporting services, Testcontainers integration tests, deterministic mock provider, and bounded scope | Refines technology, test, and delivery baselines             |
| [ADR-0006](0006-payment-and-settlement-lifecycle-state-ownership.md)     | Accepted | Separate Payment/Settlement lifecycle ownership and physical state boundaries                                        | Records the repository decision for specification ADR-004    |
| [ADR-0007](0007-idempotency-key-concurrency-and-response-snapshots.md)   | Accepted | Merchant-scoped idempotency uniqueness, single-winner leases, atomic completion, replay, and retention               | Refines FR-05, INV-10, and the idempotency concurrency model |
| [ADR-0008](0008-api-version-path-and-compatibility.md)                   | Accepted | Canonical `/v1` API path with a pre-release correction of the `/api/v1` scaffold route                               | Aligns with Tables 24 and 25                                 |
| [ADR-0009](0009-public-payment-identifiers.md)                           | Accepted | Internal UUID plus immutable public `pi_`-prefixed ULID for Payment Intents                                          | Refines the Appendix B identifier example                    |
| [ADR-0010](0010-payment-currencies-and-amount-range.md)                  | Accepted | ETB/USD v1 allow-list and positive JSON-safe integer minor-unit range                                                | Resolves OQ-01 to its fallback and applies money rules       |
| [ADR-0011](0011-payment-intent-external-reference-and-capture-method.md) | Accepted | Exact merchant-scoped external references and required manual capture method                                         | Refines FR-02 and the create sample                          |
| [ADR-0012](0012-payment-created-outbox-timing.md)                        | Accepted | Persist `payment.created.v1` with creation; defer RabbitMQ publication to Eventing                                   | Applies FR-07 and ADR-0004                                   |
| [ADR-0013](0013-problem-details-audit-and-retention-boundaries.md)       | Accepted | RFC 9457 problem contract, privileged-only audit, and conservative evidence retention                                | Refines FR-13, FR-14, and Tables 23/24                       |
| [ADR-0014](0014-webhook-endpoint-url-and-ssrf-policy.md)                 | Accepted | Canonical webhook URL policy with production SSRF controls and delivery-time re-resolution                           | Records specification ADR-007 and refines FR-09              |
| [ADR-0015](0015-webhook-signing-secret-encryption-and-rotation.md)       | Accepted | AES-256-GCM secret storage, keyring/KMS boundary, and a 24-hour current/previous rotation overlap                    | Refines FR-09 and webhook secret lifecycle                   |
| [ADR-0016](0016-webhook-endpoint-api-ownership-and-subscriptions.md)     | Accepted | Merchant-owned webhook API, ETag concurrency, immutable URLs, and normalized subscriptions                           | Refines FR-09 endpoint management                            |
| [ADR-0017](0017-webhook-endpoint-lifecycle-audit.md)                     | Accepted | Operations-owned audit committed atomically with endpoint lifecycle mutations                                        | Applies FR-14 to webhook endpoint lifecycle                  |
| [ADR-0018](0018-signed-webhook-delivery-contract.md)                     | Accepted | Exact-byte signed HTTP webhook contract with ordered current/previous HMAC-SHA-256 signatures                        | Refines FR-10 and webhook signature compatibility            |
| [ADR-0019](0019-webhook-delivery-reliability-and-lifecycle.md)           | Accepted | Leased four-state delivery lifecycle, immutable attempts, bounded retry, SSRF-safe HTTP, and crash recovery          | Refines FR-10 delivery and recovery behavior                 |
| [ADR-0020](0020-immutable-double-entry-ledger-foundation.md)             | Accepted | PostgreSQL-enforced posted-only double-entry Ledger, closed initial chart, immutable evidence, and exact reversals   | Refines FR-06 and INV-01 through INV-06                      |
| [ADR-0021](0021-settlement-ledger-accounts-and-guarded-posting.md)       | Accepted | Merchant-scoped fee/settlement-clearing accounts, Settlement business type, and guarded balanced posting             | Refines FR-06, FR-11, and INV-01 through INV-10              |

## When an ADR is required

Create an ADR for a material change to architecture, bounded-module ownership or dependencies, transaction/consistency strategy, data access policy, PostgreSQL/RabbitMQ roles, public contracts, security boundaries, deployment topology, or production dependencies. Also use an ADR when choosing among alternatives has meaningful financial, security, reliability, compatibility, or operational consequences.

Small implementation details that follow an accepted design belong in an implementation plan or code review, not a new ADR.

## Authority and status

Allowed statuses are `Proposed`, `Accepted`, `Rejected`, `Deprecated`, and `Superseded`.

- The specification is authoritative. An ADR must cite the relevant requirement IDs and specification sections.
- An ADR may refine unspecified detail. It cannot silently contradict or supersede the specification.
- A decision that changes a material specification baseline requires the specification's change control and version update as well as an accepted ADR.
- Superseding records link both directions and preserve the earlier record.
- Accepted ADRs are immutable except for status/link/typographical corrections; change the decision with a new ADR.

## Workflow

1. Copy the template and complete context, decision drivers, options, consequences, and verification.
2. Mark unresolved facts **To be decided**. Do not bias review by presenting an unexamined choice as settled.
3. Obtain financial, security, database, or architecture review appropriate to the decision.
4. Set `Accepted` only after approval and any required specification change.
5. Update architecture, plans, contracts, tests, and runbooks in the implementation pull request.

## Specification baseline coverage

The first five indexed ADRs record the decisions required before safe project scaffolding. Their numbering is the repository sequence and does not renumber or supersede the specification's initial ADR register.

The specification's remaining accepted baselines still apply directly:

- ADR-006: do not introduce Redis in v1.0 without a measured use case;
- ADR-007: treat registered webhook URLs as an SSRF boundary.

Accepted ADR-0006 records the separate payment/settlement lifecycle baseline and physical ownership refinement. ADRs 0006 through 0013 provide the accepted Payment Intent decisions; implementation-specific contract artifacts and the settlement read-composition design remain required at their recorded gates. ADR-0014 records and refines specification ADR-007 for the Webhook Endpoint milestone, while ADRs 0015 through 0017 define its secret, API/ownership, subscription, and audit boundaries. ADR-0018 defines the exact signed HTTP contract, and ADR-0019 defines the leased delivery, retry, terminal-state, and recovery behavior. They authorize only a later approved Signed HTTP Webhook Delivery implementation plan; manual replay, destructive retention, production KMS, new payment behavior, and weakened SSRF controls remain unauthorized. Accepted ADR-0020 records the immutable double-entry Ledger Foundation architecture. Accepted ADR-0021 extends its closed chart and business types for guarded Settlement posting; acceptance records the architecture but does not itself implement schema or application behavior. A standalone repository ADR for specification ADR-006 remains **To be created** if an affected implementation milestone requires it. The indexed ADRs do not authorize Redis, combined lifecycles, historical fanout, an exactly-once webhook claim, or any Proposed ADR behavior before acceptance.
