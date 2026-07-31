# Implementation Plan: Architecture decision milestone

- **Status:** Completed
- **Owner:** SettleFlow Project
- **Created:** 2026-07-31
- **Last updated:** 2026-07-31
- **Related issue/PR:** Architecture-decision milestone request
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0002](../adr/0002-node-typescript-package-manager-and-version-policy.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0004](../adr/0004-rabbitmq-outbox-inbox-and-message-delivery.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md)

## Goal

Record the minimum architecture, runtime/tooling, data-access, messaging, and local-test decisions required before SettleFlow can be scaffolded safely and consistently with the specification.

### Non-goals

- Application, package, Docker, database, migration, queue, or CI scaffolding.
- Selection of exact dependency, runtime, service, image, or action versions.
- Resolution of product decisions whose specification deadlines occur after scaffolding.
- Any commit, push, Git configuration change, or dependency installation.

## Specification traceability

- **Sections:** Executive Summary; Purpose and Decision Context; Goals, Scope, and Success Criteria; Domain Model and Financial Semantics; Functional Requirements; Architecture and Technical Design; Data Architecture and Integrity Controls; Reliability and Operational Design; Verification and Quality Strategy; Delivery and Repository Plan; Risks, Decisions, and Open Questions; Acceptance Baseline.
- **Requirement IDs:** FR-01 through FR-14 are enabled by the selected architecture; FR-06 through FR-08 are directly affected by the persistence and messaging decisions.
- **Invariant IDs:** INV-01 through INV-10 remain authoritative and are not redefined by these ADRs.
- **Acceptance/release gates:** Architecture, correctness, concurrency, security, recovery, reproducibility, and documentation gates.

The milestone records the specification's accepted baselines and the project owner's explicit refinements for TypeScript, pnpm, and local/test tooling. No waiver or P1/P2 implementation is introduced.

## Existing behavior

The repository contains only governance, architecture summaries, templates, and the authoritative specification. Git was clean on `main` and synchronized with `origin/main` before editing. There is no application code, package manifest, lockfile, Docker definition, database schema, migration, or dependency directory.

The specification already selects a NestJS modular monolith, API and worker deployables, PostgreSQL, Prisma plus reviewed parameterized raw SQL, RabbitMQ, transactional outbox/inbox, Docker Compose, and Testcontainers. It requires supported Node.js LTS but intentionally leaves exact versions open. The package manager was previously undecided.

## Proposed design

Create five accepted ADRs that establish:

1. NestJS and TypeScript in one modular-monolith codebase with separate API and worker deployables.
2. Current Node.js LTS as the runtime policy, pnpm as the single package manager, and verified exact-version pinning during scaffolding.
3. PostgreSQL as authoritative financial state, Prisma for routine access, and a narrow reviewed parameterized raw-SQL exception for PostgreSQL-specific correctness/concurrency behavior.
4. RabbitMQ at-least-once delivery using transactional outbox, inbox deduplication, publisher confirms, manual acknowledgements, and dead-letter recovery.
5. Docker Compose for local supporting services, Testcontainers for integration tests, a deterministic mock provider, and explicit exclusions that constrain v1.0.

No material design choice remains open for this ADR milestone. Exact versions, service topology details, queue names, retry thresholds, and environment-specific settings remain **To be decided** during approved scaffolding or feature plans.

## Affected modules and files

| Module/file area | Ownership or change | Boundary impact |
| --- | --- | --- |
| `docs/adr/0001-0005` | New architecture records | Documents existing boundaries; creates no runtime dependency. |
| `docs/adr/README.md` | ADR index | Adds traceable status and coverage links. |
| `docs/plans/2026-07-31-architecture-decision-milestone.md` | Execution record | Documents scope and verification only. |

No module implementation or cross-module read/write path is created.

## API and integration impact

No API, event, webhook, CSV, pagination, error, or compatibility contract changes. ADR-0004 constrains the future asynchronous delivery contract but creates no topology or schema.

## Database and migration impact

None in this milestone. ADR-0003 defines future ownership and review policy. No table, constraint, trigger, index, migration, SQL file, role, or connection configuration is created.

## Transaction boundaries and concurrency

No transaction executes in this milestone. The ADRs preserve the required future boundaries: financial domain state, balanced ledger entries, and the outbox event commit atomically; broker I/O occurs after commit; outbox claims use short leases; consumers acknowledge only after inbox-protected effects commit.

## Security and privacy

The milestone introduces no secrets, credentials, network destinations, personal data, or production data. ADRs retain tenant-scoped authorization, least privilege, raw-SQL review, immutable financial records, message deduplication, and synthetic-data-only local/test environments.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario | Expected safe state | Retry/recovery | Evidence |
| --- | --- | --- | --- |
| Documentation edit interrupted | Existing tracked files remain valid | Reapply the bounded Markdown change | Git diff review |
| Conflicting architecture statement | Specification remains authoritative | Stop, correct or reject the ADR before acceptance | Cross-document review |
| Duplicate asynchronous message in future implementation | One committed state-changing effect | Inbox deduplication and post-commit acknowledgement | ADR-0004 plus later integration tests |
| Broker unavailable in future implementation | Financial transaction may commit with pending outbox | Relay retries after recovery | ADR-0004 plus later failure tests |

## Observability and operations

No runtime telemetry or operator behavior is added. Future implementations must retain the specification's health, metrics, correlation, backlog, alerting, and runbook requirements. Exact telemetry backend remains governed by OQ-06 and is not resolved here.

## Test strategy

- **Unit:** Not applicable; no executable code.
- **Database constraints/migrations:** Not applicable; no database artifacts.
- **Integration with real dependencies:** Not applicable; no runtime artifacts.
- **Contract:** Review each ADR against the specification, architecture summaries, and financial invariants.
- **Concurrency/race:** Verify the ADRs preserve required future controls; no executable race test exists yet.
- **Failure injection/recovery:** Verify ADR-0004 describes crash-after-publish and crash-before-ack recovery without exactly-once claims.
- **Security:** Scan changed Markdown for secret-like material and prohibited production scope.
- **Performance:** Not applicable.
- **Documentation/link checks:** Resolve every relative Markdown link, check text hygiene, run `git diff --check`, inspect the complete diff, and run `git status`.

Repository test commands do not exist yet and must not be invented.

## Documentation impact

Five new ADRs, the ADR index, and this implementation-plan record. No OpenAPI, event schema, example, runbook, security, contribution, or release-note change is required because behavior is not implemented.

## Rollback or forward-recovery strategy

Before commit, the documentation-only changes can be removed without data impact. After acceptance, an ADR is immutable except for permitted metadata corrections; a changed decision requires a superseding ADR. No financial or audit record exists or is affected.

## Risks and assumptions

| Risk or assumption | Impact | Mitigation/validation | Owner/deadline |
| --- | --- | --- | --- |
| ADR numbering consolidates several specification baseline records | Readers could assume omitted baselines were superseded | ADR index maps coverage and states that specification ADR-004, ADR-006, and ADR-007 remain authoritative | SettleFlow Project / this milestone |
| "Current Node.js LTS" changes over time | An unverified exact pin could become stale or incompatible | Verify official support and compatibility during scaffolding, then pin all exact versions consistently | Scaffolding plan owner / before manifests |
| Raw SQL exception expands beyond necessity | Boundary, tenant, or invariant risk | Require documented Prisma limitation, parameterization, ownership, review, and real PostgreSQL tests | Database reviewer / each use |
| Local tooling is mistaken for production authorization | Unsafe deployment claims | Repeat simulation-only scope and prohibit real funds, card data, or provider secrets | Maintainers / continuous |

## Execution checklist

- [x] Design and boundaries reviewed.
- [x] Required ADR/specification relationship reviewed.
- [x] Five ADRs created and indexed.
- [x] Cross-document and invariant review passed.
- [x] Security and sensitive-data review passed.
- [x] Commands/results and deviations recorded below.

## Verification record

| Command or review | Result | Date/evidence |
| --- | --- | --- |
| Pre-edit `git status --untracked-files=all` | Pass: clean `main`, synchronized with `origin/main` | 2026-07-31 |
| Authoritative document review | Pass: governance files inspected; specification SHA-256 `77E3A5B44C4EE20F2E241DDC5CE2991D64BE82128E31EFBEE6DEC86239F239A6` | 2026-07-31 |
| ADR structure and decision-coverage validation | Pass: 5/5 ADRs contain all required sections and requested decisions | 2026-07-31 |
| Specification/invariant cross-check | Pass: no contradiction; INV-01 through INV-10 remain authoritative | 2026-07-31 |
| Markdown link, ASCII/LF, trailing-whitespace, secret-pattern, and scope checks | Pass: all links resolve; seven documentation-only changes; no secret or scaffold artifact | 2026-07-31 |
| `git diff --check` and new-file `git diff --no-index --check` | Pass; command-local conversion suppression used only for new-file checks, without changing Git configuration | 2026-07-31 |
| Initial combined PowerShell validators | Corrected after syntax/file-filter errors before validation completed; subsequent checks passed | 2026-07-31 |
| Final `git status --untracked-files=all` | Pass: one tracked documentation modification and six untracked documentation files; nothing staged | 2026-07-31 |

## Definition of done

All five requested ADRs are accepted, complete, linked, consistent with the specification and INV-01 through INV-10, and indexed. The plan records final verification. The diff contains only the architecture-decision milestone, no secrets or application artifacts, and no commit or push occurs.
