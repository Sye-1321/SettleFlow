# ADR-0003: PostgreSQL, Prisma, and financial data access

- **Status:** Accepted
- **Date:** 2026-07-31
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through the architecture-decision milestone
- **Supersedes:** None
- **Superseded by:** None

## Context

SettleFlow's core claims depend on transactions, row locks, unique/check/foreign-key constraints, deferred constraint triggers, restricted roles, indexes, and transparent SQL behavior. Payment projections, ledger postings, idempotency records, outbox/inbox state, settlement claims, and audit evidence require one authoritative transactional store.

The specification selects PostgreSQL as that store and Prisma for routine access, with reviewed parameterized raw SQL where lock, claim, or advanced constraint behavior must be explicit. A policy is needed before scaffolding so convenience APIs cannot silently replace PostgreSQL guarantees or broaden raw SQL into an unrestricted alternate data layer.

This ADR records the PostgreSQL part of specification baseline ADR-002 and specification baseline ADR-005. It does not change the specification.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): Baseline decisions; Financial Semantics; Architecture and Technical Design; Data Architecture and Integrity Controls; Recorded baseline decisions.
- [Module boundaries](../architecture/module-boundaries.md)
- [Financial invariants](../architecture/financial-invariants.md)
- [Security policy](../../SECURITY.md)

## Decision drivers

- Atomic financial state, ledger, and outbox changes.
- Database-enforced INV-01 through INV-10.
- Explicit row locking, isolation, lease claims, and single-winner behavior.
- Tenant-scoped access and module-owned persistence.
- Productive routine data access without hiding critical SQL semantics.
- Reviewable migrations, constraints, query plans, and restricted roles.

## Considered options

### Option A: PostgreSQL with Prisma by default and narrow raw-SQL exceptions

Use PostgreSQL as authoritative state. Use Prisma for routine type-safe access and migration workflow. Use reviewed parameterized raw SQL only when Prisma cannot safely or clearly express an approved PostgreSQL-specific requirement.

Selected because it balances routine productivity with exact control over financial/concurrency paths.

### Option B: Prisma-only data access

This maximizes consistency in the application data layer but may obscure or fail to express `FOR UPDATE`, `SKIP LOCKED`, deferrable constraint triggers, partial/covering indexes, role permissions, and proven single-winner acquisition patterns.

Rejected because ORM convenience cannot override correctness requirements.

### Option C: SQL-first access for every query

This makes all behavior explicit but increases routine mapping, typing, migration, and maintenance work. It would broaden the review surface without improving every path.

Rejected as the default. Raw SQL remains available only where justified.

### Option D: Multiple databases or an in-memory financial store

Splitting bounded modules into different databases would split transactions and complicate financial invariants. An in-memory or embedded store would not reproduce required PostgreSQL isolation, locking, trigger, and permission behavior.

Rejected for v1.0 and for integration proof.

## Decision

- **PostgreSQL is the sole authoritative transactional and financial store.** RabbitMQ, caches, telemetry, projections, and application memory are not authoritative financial state.
- All financial state changes use explicit PostgreSQL transactions. Payment/refund state, balanced ledger entries, and the corresponding outbox event commit or roll back together.
- **Prisma is the default data-access client and migration workflow** for routine, module-owned persistence.
- Reviewed parameterized raw SQL is permitted only when Prisma cannot safely or clearly express a specification requirement involving PostgreSQL-specific locking, claiming, isolation, constraints, triggers, indexes, or permissions.
- Each raw-SQL use must document the Prisma limitation and required database semantics, live in the owning infrastructure adapter/migration, use parameter binding rather than string interpolation, include the authenticated merchant predicate where applicable, and have real PostgreSQL integration tests.
- Raw SQL is expected for approved cases such as payment row locks, outbox/settlement `FOR UPDATE SKIP LOCKED` claims, proven idempotency acquisition, deferred ledger constraint triggers, immutable-record triggers/roles, partial or covering indexes, and explain-plan evidence.
- Cross-module access through Prisma or raw SQL is prohibited. A module may write only its owned tables through its adapter. Cross-module behavior uses application ports or stable read models.
- Database constraints and tests are not weakened to fit Prisma-generated behavior. If Prisma cannot preserve the requirement, use reviewed SQL or stop and revise the design.

The exact PostgreSQL major, Prisma version, driver/pool settings, transaction timeouts, and migration commands are **To be decided and pinned during scaffolding after compatibility verification**.

## Consequences

### Positive

- Financial correctness rests on PostgreSQL transactions and executable constraints, not only application conventions.
- Routine access remains productive and type-aware through Prisma.
- Critical concurrency SQL stays explicit, parameterized, reviewable, and testable.
- One database supports atomic cross-module ports without authorizing direct cross-module writes.

### Negative

- Some migrations and data-access paths require hand-reviewed PostgreSQL SQL.
- Engineers must understand both Prisma transaction behavior and PostgreSQL isolation/locking.
- Local and CI integration tests require real PostgreSQL.
- Version upgrades may change generated queries or transaction behavior and require renewed proof.

### Risks and mitigations

- **ORM hides unsafe behavior:** Inspect generated/query behavior and replace with reviewed SQL where semantics are unclear.
- **Raw SQL becomes a bypass:** Enforce the documented exception gate, module ownership, parameterization, and database review.
- **Tenant leakage:** Include authenticated merchant identity in every owned predicate and test negative fixtures.
- **Long locks/network waits:** Bound lock/statement timeouts, retry whole transactions where approved, and keep network I/O outside transactions.
- **Migration weakens invariants:** Apply full migration history and run negative/permission tests against real PostgreSQL.

## Implementation notes

- Use integer `BIGINT` minor units and explicit three-letter currency fields; never map financial values through JavaScript binary floating-point arithmetic.
- Use foreign keys and `RESTRICT` by default for financial relationships, checks for local rules, and deferred constraint triggers for cross-row ledger rules at commit.
- Use a restricted application role and triggers to reject updates/deletes of posted ledger and audit records.
- Review every transaction boundary, isolation choice, lock order, timeout, retryable SQLSTATE, and whole-transaction retry limit.
- Use generated columns only for stable deterministic projections and partial/covering indexes only with measured query-plan evidence.
- Migrations must support an empty database, prior-version upgrade, API/worker compatibility, and rollback or forward-fix notes.
- No schema, Prisma file, migration, SQL file, or database configuration is created by this ADR milestone.

## Affected requirements and invariants

- **Requirements:** FR-01 merchant scoping; FR-02 through FR-06 payments, refunds, idempotency, and ledger; FR-07 and FR-08 outbox/inbox; FR-11 settlements; FR-12 reconciliation; FR-14 append-only audit evidence.
- **Invariants:** INV-01 through INV-10 are directly affected and remain database-enforced as specified.
- **Acceptance:** Correctness, concurrency, security, migration, recovery, and reproducibility gates require real PostgreSQL evidence.

## Impact assessment

- **Affected modules and dependency direction:** All persistence-owning modules; ownership and port rules remain mandatory.
- **Financial invariants and money representation:** PostgreSQL is authoritative; integer minor units, balance, currency, immutability, reversal, refund, settlement, and deduplication rules are unchanged.
- **Database schema, migration, locking, and transaction boundaries:** Establishes policy; exact artifacts are deferred.
- **Idempotency, outbox/inbox, retries, and partial failure:** These records share PostgreSQL transactions with their effects where specified; approved locks/uniqueness provide single-winner behavior.
- **API, event, webhook, or CSV compatibility:** No contract change.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Merchant scoping and least-privilege roles apply to every query; no secrets may enter SQL/logs.
- **Observability, alerting, and runbooks:** Later work must expose lock/retry/invariant/migration failures without logging sensitive data.
- **Production dependencies and supply-chain impact:** Approves PostgreSQL and Prisma; exact supported versions/digests are deferred to scaffolding.

## Verification

- Test every affected constraint and trigger with positive and negative cases.
- Run required capture/refund/idempotency/relay/settlement concurrency scenarios against real PostgreSQL.
- Prove merchant isolation and restricted-role update/delete failures.
- Review every raw-SQL site for documented necessity, parameterization, ownership, lock behavior, and query plan.
- Apply migrations to an empty database and a maintained prior-version fixture once migrations exist.
- Confirm no financial integration test uses an in-memory substitute.

## Rollout and recovery

This ADR creates no database artifact. Future migrations use controlled sequencing and prefer forward fixes when rollback would conflict with written data. Posted ledger/audit records are never repaired by mutation. Changing the authoritative database or access policy requires a superseding ADR and proof that INV-01 through INV-10 remain enforceable.

## Documentation and traceability

Index this ADR in [the ADR register](README.md). Future schema, migration, data-access, and financial feature plans must cite it and [the financial invariants](../architecture/financial-invariants.md).
