## Summary

Describe the outcome and why it is needed.

## Scope

- **In scope:**
- **Out of scope:**
- **Issue / implementation plan:**
- **Related ADRs:**

## Specification traceability

- **Specification sections:**
- **Requirement IDs:**
- **Invariant IDs:**
- **Release/acceptance gates:**

## Design and boundaries

- **Affected modules and owned data:**
- **Dependency/read paths:**
- **Transaction boundaries and locks:**
- **Idempotency and concurrency behavior:**
- **Outbox/inbox, retry, duplicate, and partial-failure behavior:**
- **API/event/webhook/CSV compatibility:**

## Database and migrations

Describe schema, constraints, triggers, indexes, raw SQL, data migration, lock/backfill impact, API/worker compatibility, clean install, prior-version upgrade, and rollback/forward-fix strategy. Write `None` only after checking.

## Security and sensitive data

Describe authentication/authorization, merchant-scoped predicates, operator audit, validation/resource limits, secrets/logging, webhook signature/replay/SSRF, dependency risk, and required security review.

## Observability and recovery

List metrics, traces, structured logs, health/readiness behavior, alerts, audit events, runbooks, terminal states, replay, rollback, or forward recovery.

## Verification evidence

| Command or review | Result |
| --- | --- |
| `command` | Pass/fail and relevant evidence |

List skipped checks with the reason and owner/date for follow-up. Do not mark an undefined command as passing.

## Documentation

List updated OpenAPI/schemas, architecture, invariants, ADRs, plan, runbooks, examples, migration notes, security/contribution guidance, and release notes.

## Risk and rollout

- **Primary risks and mitigations:**
- **Assumptions / To be decided:**
- **Rollout sequence:**
- **Rollback or forward-recovery limits:**

## Author checklist

- [ ] I read the relevant specification sections and cited requirement/invariant IDs.
- [ ] This PR is focused and contains no unrelated refactoring, formatting, or dependency changes.
- [ ] Module ownership is preserved; there are no direct cross-module persistence writes.
- [ ] Money uses integer minor units and affected financial invariants remain database-enforced.
- [ ] Financial state, ledger postings, and the outbox event share one explicit transaction where required.
- [ ] Idempotency, duplicate/concurrent requests, at-least-once delivery, and crash/partial-failure behavior are covered.
- [ ] Authentication, authorization, input validation, secrets/logging, webhook signing/replay, and SSRF were reviewed as applicable.
- [ ] Migrations apply cleanly and preserve rolling compatibility as applicable.
- [ ] Relevant unit, database, integration, contract, concurrency, failure, security, and performance checks pass.
- [ ] Documentation, plans, ADRs, and runbooks match the behavior.
- [ ] I reviewed the complete diff, ran `git diff --check`, checked for secrets, and disclosed skipped verification.

## Reviewer focus

Call out the highest-risk transaction, invariant, security boundary, migration, failure point, or compatibility decision for reviewers.
