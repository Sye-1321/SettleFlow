# Implementation Plan: Short title

- **Status:** Draft
- **Owner:** To be decided
- **Created:** YYYY-MM-DD
- **Last updated:** YYYY-MM-DD
- **Related issue/PR:** To be decided
- **Related ADRs:** None

## Goal

State the user/operator outcome and measurable success condition.

### Non-goals

- Explicitly excluded scope.

## Specification traceability

- **Sections:**
- **Requirement IDs:**
- **Invariant IDs:**
- **Acceptance/release gates:**

Explain any P1/P2 work or waiver. Plans cannot silently change the specification.

## Existing behavior

Describe the current code, schema, contracts, tests, operational behavior, and evidence inspected. Include relevant file paths and commands.

## Proposed design

Describe the end-to-end design and alternatives rejected. Identify all decisions still **To be decided**, with owner and deadline.

## Affected modules and files

| Module/file area | Ownership or change | Boundary impact |
| --- | --- | --- |
| To be decided | To be decided | To be decided |

State any new dependency direction or cross-module read. Direct cross-module writes are not permitted.

## API and integration impact

Document REST/OpenAPI, event, RabbitMQ, webhook, CSV, pagination, error, idempotency, and compatibility effects. State `None` where verified.

## Database and migration impact

Describe tables, constraints, triggers, indexes, raw SQL, data/backfill volume, migration ordering, API/worker compatibility, lock/runtime risk, empty-database application, and prior-version upgrade testing.

## Transaction boundaries and concurrency

Define transaction start/end, rows locked, isolation level, uniqueness constraints, lock/statement timeouts, single-winner behavior, network calls outside transactions, retryable SQL states, and whole-transaction retry limits.

For a financial command, show how domain state, balanced ledger entries, and the outbox event commit or roll back together.

## Security and privacy

Cover authentication, authorization in merchant-scoped predicates, operator permissions, secret/key lifecycle, input/resource validation, sensitive data/logging, webhook signing/replay/SSRF, least privilege, and required security review.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario | Expected safe state | Retry/recovery | Evidence |
| --- | --- | --- | --- |
| To be decided | To be decided | To be decided | To be decided |

Include dependency outages, crash points, duplicate commands/messages/webhooks, stale leases, partial work, dead-lettering, manual replay, and rollback or forward fix as applicable.

## Observability and operations

List traces, metrics, structured log fields, health/readiness effects, backlog signals, alerts, audit events, dashboards, and runbooks. Confirm that telemetry contains no prohibited data and is not a financial dependency.

## Test strategy

- **Unit:**
- **Database constraints/migrations:**
- **Integration with real dependencies:**
- **Contract:**
- **Concurrency/race:**
- **Failure injection/recovery:**
- **Security:**
- **Performance:**
- **Documentation/link checks:**

List repository commands and pass conditions. If a command does not exist yet, mark it **To be defined**, not passed.

## Documentation impact

List architecture, invariant, ADR, OpenAPI/schema, example, runbook, contribution, security, and release-note changes.

## Rollback or forward-recovery strategy

Explain which changes are safely reversible, when forward fix is required, how schema compatibility is preserved, and how posted ledger/audit evidence remains immutable.

## Risks and assumptions

| Risk or assumption | Impact | Mitigation/validation | Owner/deadline |
| --- | --- | --- | --- |
| To be decided | To be decided | To be decided | To be decided |

## Execution checklist

- [ ] Design and boundaries reviewed.
- [ ] Required ADR/specification change approved.
- [ ] Implementation and migrations completed.
- [ ] Tests and failure scenarios pass.
- [ ] Security and sensitive-data review pass.
- [ ] Documentation and runbooks updated.
- [ ] Commands/results and deviations recorded below.

## Verification record

| Command or review | Result | Date/evidence |
| --- | --- | --- |
| To be recorded | Not run | To be recorded |

## Definition of done

List scope-specific, observable acceptance conditions, including requirements, invariants, recovery, verification, documentation, review, and clean-diff expectations.
