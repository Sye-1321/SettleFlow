# Implementation Plan: Settlement Projection Event Ordering

- **Status:** In progress
- **Owner:** SettleFlow Project
- **Created:** 2026-10-16
- **Last updated:** 2026-10-18
- **Related issue/PR:** To be decided
- **Related ADRs:** [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0004](../adr/0004-rabbitmq-outbox-inbox-and-message-delivery.md), and [ADR-0006](../adr/0006-payment-and-settlement-lifecycle-state-ownership.md)

## Goal

Make the Settlement lifecycle projection converge when capture and cumulative refund events are delivered out of order. Refunds must not disappear, projected cumulative refunds must not regress, duplicate delivery must remain idempotent, and only refunds not already reflected in a settled batch snapshot may create adjustments.

### Non-goals

- No event-contract, RabbitMQ topology, API, ledger, outbox, reconciliation, or payment-lifecycle change.
- No schema migration, new ordering framework, pending-event store, dependency, or historical-data repair in this change.

## Specification traceability

- **Sections:** FR-11 Settlement Processing; FR-12 Reconciliation; asynchronous reliability and settlement projection requirements.
- **Requirement IDs:** FR-11 and FR-12.
- **Invariant IDs:** INV-07 and INV-10 are directly relevant. INV-08 and INV-09 remain unchanged.
- **Acceptance/release gates:** Real-PostgreSQL coverage for capture-before-refund, refund-before-capture, reversed cumulative refund delivery, duplicate delivery, and refund-after-settlement behavior; Settlement unit tests; typecheck; focused lint/formatting; and Git whitespace validation.

This plan refines implementation behavior within the existing architecture and introduces no new architecture decision.

## Existing behavior and reproduction

`InboxService` reserves a settlement lifecycle event and executes its projection effect in one serializable PostgreSQL transaction. Before this correction, a refund with no `settlement_positions` row returned successfully, so its inbox record committed and the consumer could acknowledge it. A later capture created the position with a projected refunded amount of zero. Refund projection also assigned the event's cumulative value directly, allowing an older event to lower a newer projection.

Focused tests against real PostgreSQL reproduced both defects:

- refund-before-capture committed one settlement inbox row; the later capture produced `refunded_amount_minor = 0` instead of the authoritative `3000`; and
- cumulative refund `3000` followed by older cumulative refund `1000` reduced the projection to `1000`.

Existing inbox uniqueness prevented duplicate processing, and adjustment uniqueness protected post-settlement refunds from duplicate adjustment rows. Neither safeguard repaired a successfully processed refund with no position or prevented cumulative state from regressing.

Follow-up PostgreSQL reproduction also confirmed that a delayed older refund created an adjustment after the batch had already snapshotted that refund, deducting the same amount twice from settlement obligations.

## Implemented design

The existing Payments settlement read port now returns the Payments-owned cumulative `refundedAmountMinor` with projection identity. It does not add a general payment-facts read.

When capture projection creates a settlement position, it initializes `refunded_amount_minor` from that authoritative cumulative value. This makes a later capture recover refund state when the refund event was processed first. For an existing position, capture projection continues to update capture amount, availability, and capture-event metadata; it does not overwrite the projected refunded amount.

Refund projection uses one merchant- and currency-scoped PostgreSQL `UPDATE` with `GREATEST(current, incoming)` so older cumulative deliveries cannot reduce the position. When a batch item exists, an adjustment is created only if the event's cumulative refunded amount exceeds the immutable batch-item refunded snapshot. Existing unique refund/source-event constraints remain unchanged.

Rejected alternatives were failing the missing-position refund indefinitely, which does not provide reliable recovery when capture is queued behind it; persisting pending events, which would require new schema and recovery semantics; and ordering by event timestamp, which is not authoritative cumulative-state conflict resolution.

## Affected modules and files

| Module/file area                                 | Change                                                                   | Boundary impact                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Payments settlement read port and Prisma adapter | Expose authoritative cumulative refunded amount with projection identity | Preserves the existing Payments-to-Settlements read boundary |
| Settlement projection service and types          | Pass the cumulative Payments-owned value to repository projection        | No new dependency direction                                  |
| Settlement Prisma repository                     | Seed capture-created positions and apply monotonic refund updates        | Parameterized raw SQL remains Settlement-owned               |
| Settlement unit and PostgreSQL integration tests | Cover ordering, duplicates, and existing adjustment behavior             | Test-only                                                    |

## API and integration impact

No REST, OpenAPI, domain-event, RabbitMQ, webhook, reconciliation, or compatibility contract changes. Consumer acknowledgement behavior remains: acknowledge only after the serializable inbox/projection transaction commits.

## Database and migration impact

No schema, constraint, trigger, index, grant, or migration change. The refund projection changes from a Prisma assignment to a parameterized atomic `UPDATE` over the existing settlement-position row. Capture creation reads the current cumulative refund value through the existing Payments read port.

## Transaction boundaries and concurrency

Inbox reservation, Payments identity/cumulative-refund reads, settlement-position mutation, and any post-settlement adjustment insertion commit or roll back in the existing serializable inbox transaction. The Payments read is merchant-scoped but does not explicitly lock the payment row. The settlement refund `UPDATE` obtains PostgreSQL's normal row lock and changes the row only when its position, merchant, and currency match; a zero-row result fails the transaction. Existing serializable retry handling covers SQLSTATE `40001`, `40P01`, and Prisma `P2034` for the whole transaction.

Inbox primary-key uniqueness keeps duplicate event delivery idempotent. Existing unique constraints on settlement position, adjustment refund ID, and adjustment source event remain defense in depth. No network call occurs inside the transaction.

## Security and privacy

Payments and refund identity lookups remain merchant-scoped, and Settlement mutation adds merchant and currency predicates. The existing currency identity check remains fail closed. No new sensitive data, logging, telemetry, permissions, or external input surface is introduced.

## Failure, retry, and recovery behavior

| Scenario                                                 | Safe result                                                                                             | Recovery/evidence                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Refund arrives before capture projection                 | Inbox commits; no position exists yet; later capture creation seeds the authoritative cumulative refund | Real-PostgreSQL integration test                     |
| Older cumulative refund arrives later                    | Stored cumulative value does not decrease                                                               | Atomic `GREATEST` update and integration test        |
| Duplicate event delivery                                 | Existing inbox row returns `duplicate`; no second mutation or adjustment                                | Inbox integration assertion                          |
| Refund already included in settled snapshot arrives late | No adjustment is created                                                                                | Batch-item cumulative snapshot comparison            |
| New refund arrives after settlement                      | One adjustment is created for the refund                                                                | Existing integration flow and database uniqueness    |
| Merchant/currency mismatch or zero-row refund update     | Entire inbox/projection transaction fails and is not acknowledged as processed                          | Existing fail-closed checks and transaction rollback |

Historical rows corrupted before this correction are not repaired automatically. Re-delivering an already processed refund normally returns `duplicate` because its inbox record already exists. Any historical diagnosis and forward repair therefore requires separate investigation, explicit approval, preserved evidence, and a reviewed repair procedure; deleting or bypassing inbox evidence is not part of this plan.

## Observability and operations

No signal, metric, readiness, alert, or runbook change. Existing settlement consumer processed/retry/dependency signals continue to apply. Historical repair remains an unresolved operational task only if affected production data is identified.

## Test strategy and verification record

| Command or review                                                                                                                                                                                          | Result    | Date/evidence                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| Focused pre-fix PostgreSQL reproduction                                                                                                                                                                    | Confirmed | 2026-10-18: delayed included refund created a `1000` adjustment; earlier ordering defects also reproduced |
| `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --selectProjects integration --runInBand test/integration/settlements-reconciliation.int-spec.ts -t "keeps settlement refund projections"` | Passed    | 2026-10-18: 1 passed; ordering, duplicate, settled-snapshot, and capture-first paths                      |
| `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --selectProjects integration --runInBand test/integration/settlements-reconciliation.int-spec.ts`                                          | Passed    | 2026-10-18: 2 passed; includes legitimate post-settlement adjustment flow                                 |
| `pnpm test:settlements`                                                                                                                                                                                    | Passed    | 2026-10-18: 5 suites, 23 tests                                                                            |
| `pnpm typecheck`                                                                                                                                                                                           | Passed    | 2026-10-18                                                                                                |
| Focused ESLint and Prettier checks on changed source/tests                                                                                                                                                 | Passed    | 2026-10-18                                                                                                |
| `git diff --check`                                                                                                                                                                                         | Passed    | 2026-10-18: no output                                                                                     |

No migration, contract, security-scan, performance, or broker test was required because this change adds no schema, contract, dependency, network path, or broker behavior.

## Documentation and rollback

The requirements evidence matrix, draft release notes, and pre-release checklist record the new PostgreSQL financial-correctness evidence without changing release approval or unverified gate status. No API, architecture, runbook, contract, specification, or ADR update is required. The code-only correction is reversible without a migration, but reverting would restore the confirmed ordering defects. Existing ledger, outbox, inbox, adjustment, audit, and reconciliation evidence must not be rewritten during rollback or any later historical repair.

## Risks and assumptions

| Risk or assumption                                                       | Impact                                                        | Mitigation or follow-up                                                                          | Owner/deadline                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Historical projections may already be missing or regressed               | Settlement candidates may be overstated                       | Separate approved investigation and evidence-preserving forward repair if affected data is found | SettleFlow Project / To be decided |
| Payments cumulative refund is authoritative when capture projection runs | Capture-created position must reflect committed Payment state | Read within the same serializable inbox transaction through the Payments-owned port              | SettleFlow Project / complete      |

## Execution checklist

- [x] Design, ownership boundaries, specification requirements, and invariants reviewed.
- [x] Defects reproduced against real PostgreSQL.
- [x] Implementation and focused tests completed without a migration or contract change.
- [x] Unit, integration, typecheck, lint, formatting, and Git whitespace checks passed.
- [ ] Final patch review completed.

## Definition of done

The correction is complete when final review accepts the patch; capture-before-refund and refund-before-capture converge to the Payments-owned cumulative value; refund projections cannot regress; duplicate deliveries remain idempotent; only refunds beyond the settled batch snapshot create adjustments; merchant/currency predicates and existing transaction semantics remain intact; no migration or contract change is introduced; and the recorded checks pass.
