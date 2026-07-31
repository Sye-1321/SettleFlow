# ADR-0005: Local development and test environment

- **Status:** Accepted
- **Date:** 2026-07-31
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through the architecture-decision milestone
- **Supersedes:** None
- **Superseded by:** None

## Context

SettleFlow must provide a reproducible local demonstration without external payment accounts and must prove PostgreSQL and RabbitMQ behavior with real dependencies. The specification selects Docker Compose for local/review packaging, Testcontainers for integration tests, and deterministic provider fixtures. It prohibits live funds and regulated payment-authentication data.

Before scaffolding, the project needs a clear boundary between long-lived local supporting services, disposable test dependencies, and the simulated provider. It also needs explicit exclusions to prevent a portfolio case study from expanding into production payment rails or unrelated platform complexity.

This ADR refines the specification's technology, testing, assumptions, and delivery baselines. It does not require a specification change.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): Goals, Scope, and Success Criteria; Assumptions and Constraints; Technology baseline; Verification and Quality Strategy; Delivery and Repository Plan.
- [Architecture overview](../architecture/README.md)
- [Security policy](../../SECURITY.md)
- [Financial invariants](../architecture/financial-invariants.md)

## Decision drivers

- Fresh-clone reproducibility and a reviewable local topology.
- Real PostgreSQL/RabbitMQ semantics in integration, concurrency, and failure tests.
- Disposable, isolated test dependencies with deterministic cleanup.
- No external payment account, provider secret, real fund movement, or regulated data.
- A bounded v1.0 scope that one engineer can finish and maintain.
- Separate local convenience from production authorization or compliance claims.

## Considered options

### Option A: Docker Compose for supporting services and Testcontainers for integration tests

Use Compose for developer/reviewer PostgreSQL and RabbitMQ services. Use Testcontainers to provision isolated real dependencies for automated integration, concurrency, and failure-injection tests. Use a deterministic mock provider adapter and synthetic fixtures.

Selected because it combines local convenience with test isolation and real dependency semantics.

### Option B: Require manually installed PostgreSQL and RabbitMQ

This avoids a container prerequisite but produces environment drift, difficult cleanup, and less reproducible onboarding.

Rejected as the default. Maintainers may debug against manual installations, but they are not the supported verification path.

### Option C: Use one shared Compose environment for all automated tests

This is simple initially but risks cross-test state leakage, port contention, weak isolation, and non-deterministic parallel CI.

Rejected for integration tests. Compose remains for interactive local services; Testcontainers owns disposable automated dependencies.

### Option D: Replace PostgreSQL/RabbitMQ with in-memory fakes

Fakes are useful for pure unit tests but cannot prove locks, isolation, constraints, triggers, confirms, acknowledgements, redelivery, or dead-letter behavior.

Rejected for integration, concurrency, and failure proof.

### Option E: Use a real payment-provider sandbox by default

A provider sandbox introduces network availability, credentials, mutable external behavior, and pressure toward real payment semantics outside the case-study scope.

Rejected. Future optional adapters require separate security, failure, secret, and scope review.

## Decision

- Use **Docker Compose** for local supporting services. The initial supporting-service baseline is PostgreSQL and RabbitMQ.
- API and worker may run from the pinned local Node.js/pnpm toolchain during development. A later demo profile may containerize them as required by the specification, but this ADR does not create that packaging.
- Use **Testcontainers** for automated integration, database, concurrency, message-delivery, and failure-injection tests that depend on PostgreSQL or RabbitMQ semantics.
- Pure unit tests may use in-memory objects for deterministic domain logic, but a fake/embedded database or broker cannot satisfy a PostgreSQL/RabbitMQ integration gate.
- Use a **deterministic mock payment/provider adapter by default**. It consumes synthetic committed fixtures, performs no real payout/card/bank operation, needs no provider credential, and makes success/failure scenarios reproducible.
- Local and test data is synthetic. No production dumps, personal data, PAN, CVV, bank credentials, identity documents, or usable secrets are permitted.
- The baseline explicitly excludes real bank payouts or payment rails, card storage, subscriptions, FX conversion/accounting, tax engine, Kafka, event sourcing, Kubernetes/service mesh/multi-region infrastructure, and a large customer-facing frontend.
- A new external provider, broker, storage engine, or excluded product capability requires a separate approved plan and normally an ADR.

The exact PostgreSQL/RabbitMQ image versions and digests, Compose ports/volumes/networks, Testcontainers versions, health intervals, fixture format, and optional telemetry profile are **To be decided during scaffolding after verification**. OQ-06 still governs the demonstrated telemetry backend.

## Consequences

### Positive

- Developers and reviewers get a consistent supporting-service topology.
- Automated tests prove real database and broker behavior in isolated containers.
- Deterministic fixtures avoid provider accounts, secrets, network drift, and flaky external state.
- Explicit exclusions protect financial/security quality from scope expansion.

### Negative

- Local development and integration tests require a supported container runtime.
- Testcontainers increases startup time and resource use relative to in-memory fakes.
- Compose and Testcontainers configurations must avoid version/topology drift.
- The mock provider cannot prove readiness for a real regulated integration.

### Risks and mitigations

- **Image drift:** Pin verified versions/digests during scaffolding and update through focused review.
- **State leakage:** Use disposable Testcontainers instances, unique databases/queues, deterministic fixtures, and bounded cleanup.
- **Local secrets committed:** Use ignored environment files and placeholder examples; scan repository changes.
- **Mock mistaken for production readiness:** State limitations prominently and prohibit compliance/production claims.
- **Scope creep:** Treat excluded capabilities and infrastructure as change-controlled future work.

## Implementation notes

- Compose must use health checks, bounded startup, named local-only data locations, and no embedded real credentials.
- PostgreSQL and RabbitMQ test containers must expose readiness before tests proceed and provide diagnostics on failure.
- Integration tests must control time, IDs, fixtures, and external HTTP endpoints where determinism matters.
- Test cleanup must not hide failed-state evidence before diagnostics are captured.
- CI must run the real-dependency suites required by the affected gate; no financial integration test is skipped for release.
- Keep local service data, generated reports, logs, and environment secrets outside version control.
- No Compose file, Dockerfile, Testcontainers code, fixture, seed, service data, or package manifest is created by this ADR milestone.

## Affected requirements and invariants

- **Requirements:** FR-02 through FR-12 require deterministic payment, eventing, webhook, settlement, and reconciliation integration scenarios; FR-13 requires dependency-aware health; all FR-01 through FR-14 benefit from reproducible verification.
- **Invariants:** INV-01 through INV-10 must be proven against real PostgreSQL where database/concurrency semantics matter.
- **Acceptance:** Reproducibility, correctness, concurrency, security, recovery, and performance evidence must identify the exact local/test environment.

## Impact assessment

- **Affected modules and dependency direction:** No module dependency changes; future adapters remain behind module/domain ports.
- **Financial invariants and money representation:** Synthetic data uses the same integer/currency rules; fakes cannot replace invariant tests.
- **Database schema, migration, locking, and transaction boundaries:** Future tests use real PostgreSQL; no schema is defined here.
- **Idempotency, outbox/inbox, retries, and partial failure:** Testcontainers must exercise duplicate, crash, outage, confirm, acknowledgement, lease, and dead-letter behavior.
- **API, event, webhook, or CSV compatibility:** Deterministic fixtures will later validate contracts; none are created here.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Synthetic credentials only; local webhook test targets remain controlled and SSRF tests must include prohibited targets safely.
- **Observability, alerting, and runbooks:** Test failures need container diagnostics; production-like observability choices remain separately governed.
- **Production dependencies and supply-chain impact:** Approves Docker Compose and Testcontainers; exact versions/images are deferred.

## Verification

- Record clean-room local startup time and prerequisites after Compose exists.
- Run migration, API, worker, outbox/inbox, webhook, settlement, and reconciliation integration tests with disposable PostgreSQL/RabbitMQ.
- Run mandatory race and failure-injection scenarios repeatedly.
- Verify a mock-provider run is deterministic and requires no network credential.
- Verify no excluded provider/product/infrastructure capability or real/sensitive data is introduced.
- Publish the exact environment and limitations with performance results.

## Rollout and recovery

This ADR creates no environment artifact. Future Compose/Testcontainers changes must be reversible as configuration changes and must never remove persistent local data without explicit operator action. Test environments are disposable; production recovery claims cannot be inferred from them.

## Documentation and traceability

Index this ADR in [the ADR register](README.md). Future scaffolding, test, demo, CI, performance, and provider-adapter plans must cite it and document exact verified versions and prerequisites.
