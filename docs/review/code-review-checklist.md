# SettleFlow Code Review Checklist

Use the applicable items below. Mark non-applicable items with a brief reason; do not silently omit them. The [specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx), [module boundaries](../architecture/module-boundaries.md), and [financial invariants](../architecture/financial-invariants.md) are authoritative review inputs.

## Scope and specification

- [ ] The change cites the affected specification requirement and invariant IDs.
- [ ] Behavior, acceptance criteria, and P0/P1/P2 scope match the specification; any waiver or deferral is explicit.
- [ ] The implementation plan is approved and current where [PLANS.md](../../PLANS.md) requires one.
- [ ] Material architecture/dependency decisions have an accepted ADR and any required specification version change.
- [ ] The diff contains no unrelated refactoring, formatting churn, dependency upgrade, or generated artifact.

## Module boundaries and architecture

- [ ] Each changed table and persistence adapter has one owning module.
- [ ] Cross-module work uses application services, domain ports, or stable read models; there are no direct writes or ORM/raw-SQL imports into another module's tables.
- [ ] Dependency direction remains acyclic; Ledger does not depend on Payments.
- [ ] Payments calls Ledger/Eventing through explicit ports; Webhooks and Settlements remain outside capture/refund transactions.
- [ ] PostgreSQL remains authoritative; RabbitMQ and telemetry are not used as financial state stores.
- [ ] API and worker entrypoints contain composition/orchestration, not duplicated domain logic or ad hoc persistence.

## Financial invariants and money

- [ ] Money uses integer minor units and explicit uppercase three-letter currency; no binary floating point or implicit cross-currency aggregation exists.
- [ ] Overflow, amount sign/range, supported currency, and currency mismatch are validated.
- [ ] Payment and settlement lifecycles remain separate, including post-settlement refunds/adjustments.
- [ ] INV-01 through INV-10 affected by the change remain enforced in PostgreSQL and proven by positive/negative tests.
- [ ] Posted ledger records are immutable; correction uses a unique linked reversal.
- [ ] Payment projections, ledger postings, settlement totals/items, fees, and reconciliation totals remain arithmetically consistent.

## Transactions, idempotency, and concurrency

- [ ] Every financial state change has an explicit PostgreSQL transaction boundary.
- [ ] Domain state, balanced ledger entries, and the outbox event commit or roll back together.
- [ ] Network calls, broker confirms, and webhook delivery occur outside financial/claim transactions.
- [ ] Row locks, unique constraints, isolation level, timeouts, and whole-transaction retry behavior are justified and tested.
- [ ] Money-mutating POSTs require merchant-scoped idempotency with canonical fingerprint and response replay.
- [ ] Same-key replay, changed-payload conflict, in-progress recovery, retry storms, and distinct-key races create no duplicate effect.
- [ ] Concurrent refunds cannot over-refund; concurrent settlement workers cannot duplicate batch membership.

## Outbox, inbox, and delivery

- [ ] Outbox rows are inserted with the producing transaction; no unsafe database/broker dual write exists.
- [ ] The relay claims with a short lease transaction, publishes outside it with confirms, and safely reclaims expired leases.
- [ ] State-changing consumers reserve inbox uniqueness, commit the effect and inbox state atomically, and acknowledge only after commit.
- [ ] Duplicate publication, redelivery, crash-after-publish, and crash-before-ack are tested.
- [ ] Retry budgets, backoff/jitter, dead-letter terminal states, and authorized audited replay are bounded and observable.

## Authentication, authorization, and input

- [ ] Unknown/disabled/revoked keys fail closed; scopes are enforced; raw keys/secrets are shown only when permitted.
- [ ] Every merchant-owned database query/mutation includes the authenticated merchant ID in its predicate.
- [ ] Operator actions use separate authentication, explicit authorization, actor/reason capture, and append-only audit.
- [ ] Inputs validate type, size, encoding, format, state, ownership, amount, currency, and resource limits before expensive work.
- [ ] Raw SQL is parameterized, ownership-scoped, isolated to the owning adapter, and reviewed for lock/query behavior.
- [ ] CSV imports enforce size/row/schema/checksum/streaming limits, deterministic duplicate classification, and formula-safe exports.

## Webhook and SSRF security

- [ ] Signatures cover exact UTF-8 bytes with HMAC-SHA-256 and include timestamp/delivery context; verification uses constant-time comparison.
- [ ] Timestamp recency, stable event ID, unique delivery ID, and consumer deduplication provide replay protection.
- [ ] URL normalization/validation and delivery-time DNS resolution block loopback, private, link-local, metadata, reserved, and rebinding targets for IPv4 and IPv6.
- [ ] HTTPS/port/egress policy is enforced where required, redirects are not followed, and timeout/response sizes are bounded.
- [ ] Secret rotation overlap, delivery replay, and attempt history preserve ownership and audit evidence.

## Secrets, logs, errors, and observability

- [ ] No real credentials, production/personal data, regulated payment data, or secret-bearing environment values are present.
- [ ] Authorization values, idempotency keys, secrets, raw financial bodies, CSV rows, full webhook payloads/responses, and internal details are absent from logs/traces/errors.
- [ ] Public errors use stable problem codes and request IDs without stack traces or sensitive/internal detail.
- [ ] Metrics, traces, logs, health, backlog, and audit signals cover success, failure, retry, dedupe, and recovery without becoming a hard financial dependency.
- [ ] New alerts and runbook steps are actionable and prohibit direct financial-row repair.

## Migrations and data integrity

- [ ] Schema changes are committed migrations with constraints/triggers/indexes and restricted-role behavior included.
- [ ] Full migration history applies to an empty database and upgrades the maintained prior-version fixture.
- [ ] Destructive changes use expand-migrate-contract sequencing and maintain API/worker compatibility.
- [ ] Lock duration, backfill/resource impact, index query plans, retention, rollback, and forward-fix behavior are documented.
- [ ] No constraint, trigger, permission, or test was weakened merely to make implementation pass.

## Tests, documentation, and completion

- [ ] Applicable unit, database, integration, contract, concurrency, failure-injection, security, and performance tests pass with real dependencies where PostgreSQL/RabbitMQ semantics matter.
- [ ] Mandatory financial/security tests are not skipped and repeated race tests are stable.
- [ ] OpenAPI, event/webhook/CSV schemas and examples are versioned and compatible or have an approved breaking-change policy.
- [ ] Architecture, invariant, ADR, plan, runbook, security, contribution, and release documentation matches behavior; relative links resolve.
- [ ] Verification commands/results, skipped gates, assumptions, risks, changed files, and recovery steps are reported.
- [ ] `git diff --check`, secret review, `git status`, and complete diff review are clean for the intended scope.
