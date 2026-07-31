# ADR-0001: NestJS modular monolith and two deployables

- **Status:** Accepted
- **Date:** 2026-07-31
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through the architecture-decision milestone
- **Supersedes:** None
- **Superseded by:** None

## Context

SettleFlow must keep payment, ledger, idempotency, settlement, and event-publication invariants inside explicit PostgreSQL transaction boundaries while remaining reviewable and feasible for a solo or small team. The specification selects a modular monolith rather than microservices and identifies two runtime responsibilities: synchronous HTTP handling and asynchronous work.

One codebase must preserve strong bounded-module ownership without forcing asynchronous operational work into the API process. Separate runtime entrypoints are needed so the API and worker can have different dependency readiness, scaling, health behavior, and failure isolation without duplicating domain logic.

This ADR records specification baseline ADR-001 and does not require a specification change.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): Executive Summary; Baseline decisions; Bounded modules; Architecture and Technical Design; Delivery and Repository Plan; Recorded baseline decisions.
- [Architecture overview](../architecture/README.md)
- [Module boundaries](../architecture/module-boundaries.md)
- [Financial invariants](../architecture/financial-invariants.md)

## Decision drivers

- Keep financial invariants within one database transaction boundary.
- Preserve explicit module ownership and acyclic dependencies.
- Isolate synchronous API availability from asynchronous backlog processing.
- Avoid duplicated domain logic and distributed-transaction failure modes.
- Keep v1.0 deliverable and reviewable by a small team.
- Support independent API and worker deployment, health checks, and scaling.

## Considered options

### Option A: NestJS and TypeScript modular monolith with API and worker deployables

Use one repository and one bounded application architecture. Compose shared domain/application packages into two entrypoints: an HTTP API and an asynchronous worker. Both connect to the same authoritative PostgreSQL database through module-owned adapters.

This option keeps financial transactions local while separating operational workloads.

### Option B: One process for HTTP and all background work

This reduces initial runtime configuration but couples API health and scaling to outbox relay, queue consumers, webhook delivery, settlement, and reconciliation. A poisoned or overloaded worker path could degrade synchronous commands unnecessarily.

Rejected because it weakens failure isolation and does not match the specification's deployable boundary.

### Option C: Microservices per bounded module

This would isolate deployment further but would split financial workflows across network boundaries, introduce distributed consistency and operational overhead, and exceed v1.0 delivery constraints.

Rejected for the baseline. A future extraction requires measured evidence, a superseding ADR, and proof that financial invariants remain safe.

### Option D: Event-sourced services

Event sourcing would change the authoritative model, persistence semantics, replay model, and operational burden. It is not required to meet the specification and would distract from PostgreSQL-enforced ledger correctness.

Rejected for v1.0.

## Decision

SettleFlow will use **NestJS with TypeScript as a modular monolith in one codebase**.

The codebase will expose two independently deployable runtime entrypoints:

- **API:** authentication, authorization, validation, idempotency orchestration, synchronous commands and queries, OpenAPI, and API-specific health behavior.
- **Worker:** outbox relay, RabbitMQ consumers, webhook scheduling/delivery, settlement jobs, reconciliation jobs, and worker-specific health behavior.

The entrypoints share module application/domain code but have separate dependency graphs, bootstrap/configuration, commands, health/readiness checks, and deployment units. Runtime entrypoints must call module services; they must not contain duplicated financial rules or mutate module-owned tables ad hoc.

The modular monolith retains Merchant Access, Payments, Ledger, Idempotency, Eventing, Webhooks, Settlements, Reconciliation, and Operations as bounded modules. Payments may call Ledger and Eventing application ports inside one explicit transaction. Ledger never depends on Payments. Settlements and Webhooks act after commit or through stable read ports.

PostgreSQL remains shared physically but module-owned logically. This ADR does not authorize microservices, distributed financial transactions, Kafka, event sourcing, or a large customer-facing frontend.

## Consequences

### Positive

- Financial state, ledger postings, and outbox records can commit atomically in PostgreSQL.
- API and worker workloads can scale, restart, and report readiness independently.
- Bounded modules and shared domain code remain easy to inspect in one repository.
- The deployment model demonstrates operational separation without premature distribution.

### Negative

- The API and worker must tolerate compatible versions of a shared schema during rolling replacement.
- Package boundaries require CI enforcement because a single repository makes improper imports technically possible.
- A shared database can encourage cross-module persistence access unless ownership rules are actively reviewed.
- Both deployables must coordinate versioning and migrations.

### Risks and mitigations

- **Boundary erosion:** Enforce package dependency rules and prohibit direct cross-module writes.
- **Duplicated orchestration:** Keep use cases in module application services and entrypoints thin.
- **Worker failure affecting API:** Use separate processes and dependency-specific readiness; RabbitMQ degradation must not invalidate a committed financial transaction.
- **Premature service extraction:** Require measured need and a superseding ADR.

## Implementation notes

- Scaffolding should create `apps/api` and `apps/worker` entrypoints plus shared domain, module, and infrastructure package areas consistent with the specification's recommended structure.
- Each entrypoint must have an explicit bootstrap, command, configuration validation, shutdown path, liveness, and readiness policy.
- The API must not wait for webhook delivery or publish directly to RabbitMQ inside a money transaction.
- The worker must use application services and module-owned adapters, not unrestricted database access.
- Import-boundary checks must be added to CI when packages exist.
- No directories or executable artifacts are created by this ADR milestone.

## Affected requirements and invariants

- **Requirements:** FR-01 through FR-14 depend on the module/deployable layout; FR-03 through FR-08 and FR-11 are most sensitive to transaction and worker boundaries; FR-13 requires process-specific health/readiness.
- **Invariants:** INV-01 through INV-10 remain unchanged. The modular monolith is selected to keep their enforcement local and testable.
- **Acceptance:** API/worker boundaries, module rules, outbox/inbox, and separate lifecycles must match code and documentation.

## Impact assessment

- **Affected modules and dependency direction:** All bounded modules; dependency rules remain those in `module-boundaries.md`.
- **Financial invariants and money representation:** No semantic change; integer minor units and INV-01 through INV-10 remain mandatory.
- **Database schema, migration, locking, and transaction boundaries:** One authoritative PostgreSQL boundary; exact schema is deferred.
- **Idempotency, outbox/inbox, retries, and partial failure:** Application services own these behaviors; asynchronous completion remains post-commit and repeatable.
- **API, event, webhook, or CSV compatibility:** No contract is created or changed here.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** No change; module ownership and separate operator/merchant boundaries remain mandatory.
- **Observability, alerting, and runbooks:** API and worker need distinct service labels, health checks, and operational evidence in later milestones.
- **Production dependencies and supply-chain impact:** NestJS and TypeScript are approved; exact supported versions are governed by ADR-0002.

## Verification

- Add package-boundary tests after scaffolding.
- Verify API and worker can bootstrap and report dependency-specific readiness independently.
- Verify broker unavailability does not make committed financial state invalid.
- Prove capture/refund transactions remain within module services and PostgreSQL.
- Review both entrypoints for duplicated business logic and direct cross-module persistence.

## Rollout and recovery

This ADR precedes scaffolding and creates no runtime rollout. Future schema changes must support API/worker compatibility and controlled migration sequencing. Reversing this decision after implementation requires a superseding ADR and a migration plan; it must not split or weaken financial invariants.

## Documentation and traceability

Index this ADR in [the ADR register](README.md). Future scaffolding and feature plans must cite it. Update architecture diagrams, repository structure, health documentation, and module-boundary tests when implementation begins.
