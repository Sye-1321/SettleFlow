# SettleFlow Architecture

This directory summarizes the architecture defined by `../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx`. The specification remains authoritative if a summary here is incomplete.

## Baseline

SettleFlow is a NestJS modular monolith with two independently deployable processes:

- the **API process** authenticates and validates requests, orchestrates idempotency, and runs synchronous command/query handlers;
- the **worker process** relays outbox events, consumes RabbitMQ messages, delivers webhooks, and runs settlement and reconciliation jobs.

Both processes share bounded domain packages and use PostgreSQL as the authoritative transactional and financial source of truth. RabbitMQ provides durable at-least-once asynchronous delivery. Telemetry records operational evidence but is not authoritative financial state.

The implemented baseline pins Node.js 24.18.0, NestJS 11.1.28, PostgreSQL 18.4, Prisma 7.9.1 plus reviewed parameterized raw SQL for critical locking/claim paths, RabbitMQ 4.3.4, TypeScript 6.0.3, Testcontainers 12.0.4, OpenTelemetry-compatible tracing, Prometheus-compatible metrics, Docker Compose, and multi-stage assembled distroless `base-nossl` runtime images. Package versions, workflow actions, scanner images, and external container images are exact in repository policy, lockfiles, full action SHAs, or image digests as appropriate. Reference k6 performance work remains a release gate rather than an implemented claim.

## Core rules

- Keep money-changing invariants within one PostgreSQL transaction.
- Commit payment state, balanced ledger entries, and the related outbox event atomically.
- Keep payment status separate from settlement status.
- Treat posted ledger records and audit records as append-only; corrections use reversals or controlled forward fixes.
- Assume asynchronous duplicates. Outbox publication, RabbitMQ consumption, and webhook delivery are at-least-once and require stable IDs and deduplication.
- A module owns its tables. Other modules use services, ports, or stable read models rather than direct writes.
- Keep network calls out of financial transactions and outbox claim transactions.
- Treat merchant webhook endpoints and reconciliation files as untrusted external boundaries.

Detailed rules:

- [Module boundaries](module-boundaries.md)
- [Financial invariants](financial-invariants.md)
- [Immutable Ledger Foundation](ledger-foundation.md)
- [System and reliability flows](system-flows.md)
- [Data model and schema inventory](data-model.md)
- [ADR process](../adr/README.md)
- [Implementation planning](../../PLANS.md)
- [Security policy](../../SECURITY.md)
- [Threat model](../security/threat-model.md)

## Bounded modules

The modular monolith contains Merchant Access, Payments, Ledger, Idempotency, Eventing, Webhooks, Settlements, Reconciliation, and Operations. Ownership and allowed dependencies are documented in [module-boundaries.md](module-boundaries.md).

## Deployment and consistency posture

PostgreSQL failure makes API readiness fail and financial commands reject safely. RabbitMQ failure does not invalidate a committed payment: the financial transaction may commit with its outbox row, while the worker becomes unready and retries after broker recovery. A crash after publish but before marking an outbox row may republish the event; consumer inbox uniqueness prevents a second state-changing effect.

Exactly-once delivery is not claimed. The system provides atomic local transactions, at-least-once messaging, idempotent consumers, bounded recovery, and auditable terminal states.

## Accepted decisions and remaining release boundaries

The [ADR register](../adr/README.md) records the accepted modular-monolith and two-deployable model, PostgreSQL/RabbitMQ boundaries, outbox/inbox lease behavior, separate Payment/Settlement lifecycles, Prisma/raw-SQL policy, API and identifier contracts, webhook endpoint/delivery security, immutable Ledger, and guarded Settlement posting.

The implemented baseline resolves the specification's milestone questions:

- demo currencies are exactly ETB and USD, with no conversion;
- immutable `settlement_fee_v1` uses currency-specific flat fees plus 200 basis points, floor-rounded and snapshotted per batch item;
- settlement cutoff timezone is `Africa/Addis_Ababa`, with timestamps stored in UTC; and
- synchronous settlement finalization means simulated clearing, not bank payout or export success;
- Apache-2.0 is the approved public license;
- P1 authorize-then-capture is deferred and direct full capture remains the baseline; and
- the optional telemetry profile uses Prometheus plus an OpenTelemetry Collector without a dashboard or trace-storage backend.

The remaining work is explicitly release-scoped, not an unresolved implementation choice:

- a sustained 15-minute backup cadence and measured PostgreSQL RPO evidence (isolated restore tooling and a passing 78-second reference RTO exercise are implemented);
- final-candidate execution and published environment/results for the five source-controlled reference performance scenarios;
- clean-room release review, final waiver/evidence matrices, immutable tags, and approved artifact publication;
- owner-controlled GitHub security/reporting and branch/release settings; and
- deferred or waived APIs and production integrations listed in the [operational-readiness plan](../plans/2026-08-03-operational-readiness-and-v1-release.md).

Operator authentication, controlled Webhook replay, real payout/provider behavior, production KMS, dashboards, partial capture, and public Ledger reads are not silently invented by the current codebase. Adding one requires the applicable specification/ADR/change-control decision.
