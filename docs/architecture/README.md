# SettleFlow Architecture

This directory summarizes the architecture defined by `../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx`. The specification remains authoritative if a summary here is incomplete.

## Baseline

SettleFlow is a NestJS modular monolith with two independently deployable processes:

- the **API process** authenticates and validates requests, orchestrates idempotency, and runs synchronous command/query handlers;
- the **worker process** relays outbox events, consumes RabbitMQ messages, delivers webhooks, and runs settlement and reconciliation jobs.

Both processes share bounded domain packages and use PostgreSQL as the authoritative transactional and financial source of truth. RabbitMQ provides durable at-least-once asynchronous delivery. Telemetry records operational evidence but is not authoritative financial state.

The baseline technology choices are supported Node.js LTS and NestJS, PostgreSQL, Prisma plus reviewed parameterized raw SQL for critical locking/claim paths, RabbitMQ, versioned REST/OpenAPI, OpenTelemetry-compatible tracing, Prometheus-compatible metrics, Jest, Supertest, Testcontainers, k6, Docker Compose, and multi-stage images. Exact versions are intentionally **To be decided** during implementation and must be supported, pinned in lockfiles or digests, and reviewed.

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
- [ADR process](../adr/README.md)
- [Implementation planning](../../PLANS.md)
- [Security policy](../../SECURITY.md)

## Bounded modules

The modular monolith contains Merchant Access, Payments, Ledger, Idempotency, Eventing, Webhooks, Settlements, Reconciliation, and Operations. Ownership and allowed dependencies are documented in [module-boundaries.md](module-boundaries.md).

## Deployment and consistency posture

PostgreSQL failure makes API readiness fail and financial commands reject safely. RabbitMQ failure does not invalidate a committed payment: the financial transaction may commit with its outbox row, while the worker becomes unready and retries after broker recovery. A crash after publish but before marking an outbox row may republish the event; consumer inbox uniqueness prevents a second state-changing effect.

Exactly-once delivery is not claimed. The system provides atomic local transactions, at-least-once messaging, idempotent consumers, bounded recovery, and auditable terminal states.

## Baseline decisions and open matters

The specification records accepted baselines for the modular monolith, API/worker deployables, PostgreSQL plus RabbitMQ, outbox/inbox with lease claims, separate payment/settlement lifecycles, Prisma plus reviewed raw SQL, no Redis without a measured need, and webhook URLs as an SSRF boundary. These decisions should be captured as repository ADRs during the relevant implementation milestone; this foundation does not fabricate those records.

Specification open questions remain **To be decided** by their milestone deadlines:

- demo currencies (default: ETB and USD, no conversion);
- demonstrated fee model (default: flat plus basis points, snapshotted per batch item);
- settlement cutoff timezone (default: `Africa/Addis_Ababa`, with timestamps stored in UTC);
- open-source license (no public release until selected);
- whether P1 authorization ships in v1.0 (default: defer and retain direct capture);
- Compose telemetry backend (default: Prometheus and Grafana, optional trace collector).

The specification also leaves these implementation details **To be decided** before the affected work:

- exact Node.js, PostgreSQL, framework, package-manager, dependency, image, and workflow versions/digests;
- the operator authentication mechanism and role model beyond the requirement that it be separate from merchant API-key authentication;
- the precise transaction/recovery sequence for finalizing an idempotency response snapshot after the financial transaction commits;
- the exact settlement finalization/export policy, including when `BATCHED` becomes `SETTLED` and the operational contract for exports;
- endpoint-specific HTTP status codes and complete schemas beyond the examples and conventions in the specification;
- environment-specific alert thresholds, retention overrides, recovery commands, and security-reporting contacts.

No direct contradiction was identified in the baseline decisions. The items above must not be resolved implicitly inside implementation code; the relevant implementation plan and, when material, ADR must record the choice.
