# Implementation Plan: Reconciliation claim ownership correction

- **Status:** Completed
- **Owner:** SettleFlow Project
- **Created:** 2026-10-19
- **Last updated:** 2026-10-19
- **Related issue/PR:** `fix/reconciliation-claim-ownership`
- **Related ADRs:** ADR-0003, ADR-0004

## Goal

Make reconciliation lease timing and terminal ownership explicit so clock skew, expiry, reclamation, or interruption cannot let a stale processor commit results, summaries, failure state, or `reconciliation.completed.v1`.

### Non-goals

- No schema migration, generic lease framework, scheduling change, public contract change, or reconciliation-policy refactor.

## Specification traceability

- **Sections:** FR-07/FR-12; reconciliation workflow; runtime responsibilities; Tables 19, 32, 35, and 36.
- **Requirement IDs:** FR-07, FR-12, FR-13.
- **Invariant IDs:** asynchronous integrity and atomic reconciliation completion; INV-01 through INV-10 remain unaffected.
- **Acceptance/release gates:** deterministic reconciliation, real-PostgreSQL concurrency/failure proof, and no skipped affected integration tests.

## Existing behavior

`PrismaReconciliationRepository.claimAndProcess` selects expiry with PostgreSQL time but writes a JavaScript-clock lease, identifies ownership only by process-level `lockedBy`, and updates terminal state by import ID. Real-PostgreSQL investigation confirmed incorrect recovery timing under clock skew, while repeatable-read conflicts and uniqueness prevented duplicate durable evidence.

## Proposed design

- Create a distinct per-attempt ownership value in `ReconciliationProcessor`, bounded to the existing `VARCHAR(128)` column.
- Claim with one raw SQL statement using `clock_timestamp()` once for both `locked_at` and `lease_expires_at = locked_at + interval '30 seconds'`, retaining `FOR UPDATE SKIP LOCKED`.
- Before terminal evidence is persisted, execute a conditional raw SQL fence using fresh `clock_timestamp()` and matching import ID, staged status, owner, and unexpired lease. Zero returned rows raises ownership loss and aborts the complete repeatable-read transaction.
- Preserve the 30-second Prisma transaction timeout. Tests will prove expiry and timeout behavior rather than introducing renewal.

Rejected: JavaScript clock arithmetic; process ID alone; a new token column/migration; relying only on repeatable-read write conflicts or uniqueness.

## Affected modules and files

| Module/file area                  | Ownership or change                                                   | Boundary impact |
| --------------------------------- | --------------------------------------------------------------------- | --------------- |
| Reconciliation service/repository | Per-attempt owner, PostgreSQL claim clock, terminal fence             | None            |
| Reconciliation unit tests         | Owner construction and ownership-loss behavior                        | None            |
| PostgreSQL integration tests      | Skew, reclaim, stale/expired workers, interruption, overflow, timeout | None            |

## API and integration impact

None. REST, CSV, event, RabbitMQ, webhook, idempotency, and report contracts are unchanged.

## Database and migration impact

No migration. `locked_by VARCHAR(128)` stores an opaque per-attempt owner; existing nullability, lifecycle checks, grants, indexes, and immutable evidence constraints remain unchanged. Raw SQL remains parameterized and Reconciliation-owned.

## Transaction boundaries and concurrency

The short claim transaction commits the PostgreSQL-authored lease. Classification remains one `REPEATABLE READ` transaction with a 30-second timeout. A successful terminal fence locks and transitions the import inside that transaction; results, two summaries, terminal state, and completion outbox event then commit or roll back together. Failure fencing uses the same owner and fresh database-time conditions.

## Security and privacy

No authentication, tenant query, secret, CSV, or logging behavior changes. Ownership values contain only generated operational identifiers and are not emitted as sensitive telemetry.

## Failure, retry, and recovery behavior

| Scenario                                | Expected safe state                                            | Recovery/evidence                |
| --------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| Clock skew                              | Lease duration remains 30 seconds in PostgreSQL time           | Real-PostgreSQL skew test        |
| Crash/interruption                      | Claim remains staged until database lease expiry               | Reclaim test                     |
| Stale or expired processor              | Fence raises; all evidence rolls back                          | Stale/expiry tests               |
| Competing workers                       | Only current owner commits                                     | Race test and durable row counts |
| Aggregate overflow after ownership loss | Stale failure cannot commit                                    | Overflow race test               |
| Transaction reaches 30 seconds          | Timeout aborts before stale completion; later reclaim succeeds | Timeout/lease interaction test   |

## Observability and operations

Existing cycle-failure logging, readiness, staged-import backlog, and reconciliation telemetry remain. Ownership loss is surfaced as a failed processor transaction; no new high-cardinality metric or log field is added.

## Test strategy

- **Unit:** claim SQL mapping, distinct attempt owner, successful/failed fence loss.
- **Integration:** real PostgreSQL clock skew, lease reclamation, stale completion, expiry during classification, competing workers, interruption, overflow failure, and timeout interaction.
- **Verification:** `pnpm test:reconciliation`, focused integration test, worker test, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `git diff --check`, status and complete diff review.
- **Not applicable:** migration, API/event contract, RabbitMQ, Webhook, performance, and security-scan behavior is unchanged.

## Documentation impact

This plan is the only documentation change. No ADR or specification update is required because the correction implements the existing claim/recovery requirements without changing architecture or contracts.

## Rollback or forward-recovery strategy

The code/test change is reversible before release and has no stored-data compatibility impact. Existing claims remain valid opaque strings. No financial or reconciliation evidence is mutated for rollout or rollback.

## Risks and assumptions

| Risk or assumption                                | Impact                             | Mitigation/validation                                        | Owner/deadline            |
| ------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------ | ------------------------- |
| Per-attempt owner exceeds 128 characters          | Claim failure                      | Fixed bounded format and unit assertion                      | Implementer before review |
| Fence occurs too late to prevent partial evidence | Incorrect transaction structure    | Fence before terminal inserts/updates; forced rollback tests | Implementer before review |
| Lease and 30-second transaction timeout race      | Duplicate work or delayed recovery | Database-time expiry and focused real-PostgreSQL timing test | Implementer before review |

## Execution checklist

- [x] Design and boundaries reviewed.
- [x] ADR/specification change determined unnecessary.
- [x] Implementation completed.
- [x] Concurrency and failure tests pass.
- [x] Static checks and changed-file formatting pass.
- [x] Final diff reviewed and verification recorded.

## Verification record

| Command or review                                     | Result                                         | Date/evidence |
| ----------------------------------------------------- | ---------------------------------------------- | ------------- |
| `pnpm test:reconciliation`                            | Pass: 5 suites, 44 tests                       | 2026-10-19    |
| Focused reconciliation claim integration suite        | Pass: 1 suite, 7 tests                         | 2026-10-19    |
| Settlement/reconciliation integration suites together | Pass: 2 suites, 9 tests                        | 2026-10-19    |
| Focused worker runtime suite                          | Pass: 1 suite, 4 tests                         | 2026-10-19    |
| `pnpm typecheck`                                      | Pass                                           | 2026-10-19    |
| `pnpm lint`                                           | Pass                                           | 2026-10-19    |
| Changed-file Prettier check                           | Pass                                           | 2026-10-19    |
| `pnpm format:check`                                   | Baseline failure: 390 unrelated files reported | 2026-10-19    |
| `pnpm boundaries:check`                               | Pass                                           | 2026-10-19    |
| `pnpm docs:check`                                     | Pass                                           | 2026-10-19    |

## Definition of done

One PostgreSQL clock defines each lease; every claim attempt has distinct ownership; completion and terminal failure require the current unexpired claim; ownership loss rolls back all derived evidence and outbox work; focused real-PostgreSQL and affected repository gates pass; no migration or unrelated change is introduced.
