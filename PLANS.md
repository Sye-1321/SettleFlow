# SettleFlow Implementation Plans

Implementation plans make substantial work reviewable before code or schema changes create risk. Plans live under `docs/plans/` and use [the implementation plan template](docs/plans/implementation-plan-template.md).

## When a plan is mandatory

Create a plan before work that does any of the following:

- implements or materially changes a specification requirement;
- changes a money-moving path, ledger posting, financial projection, payment or settlement transition, or reconciliation result;
- adds or changes a database schema, constraint, trigger, migration, lock, isolation level, claim query, or retention job;
- crosses a module boundary or affects more than one bounded module;
- changes idempotency, outbox/inbox handling, RabbitMQ topology, retries, acknowledgements, leases, dead-lettering, or recovery behavior;
- changes authentication, authorization, secret handling, webhook signing, replay protection, SSRF controls, validation, auditability, or sensitive logging;
- changes a public API, OpenAPI document, domain event, webhook, CSV contract, or compatibility policy;
- adds a production dependency, deployable, module, external integration, or architecture decision;
- changes operational readiness, data recovery, migrations, or a release gate;
- is expected to require multiple coordinated commits or cannot be safely reviewed as a small local edit.

A plan is usually unnecessary for a narrowly scoped typo, link repair, or mechanical documentation correction that changes no behavior or policy.

## Required content

Every plan must contain:

1. Goal and non-goals.
2. Specification requirement IDs and relevant invariant IDs.
3. Existing behavior and evidence inspected.
4. Proposed design and alternatives considered.
5. Affected modules and files.
6. API, event, webhook, and compatibility impact.
7. Database and migration impact.
8. Explicit transaction boundaries and concurrency controls.
9. Security and privacy considerations.
10. Failure, retry, duplicate-delivery, partial-failure, and recovery behavior.
11. Observability signals and operator impact.
12. Test strategy and verification commands.
13. Documentation impact.
14. Rollback or forward-recovery strategy.
15. Risks, assumptions, and decisions still open.
16. Definition of done.

## Plan lifecycle

- Name plans `YYYY-MM-DD-short-title.md` unless an issue or milestone establishes another stable convention.
- Mark the plan `Draft`, `Approved`, `In progress`, `Completed`, or `Superseded` and identify its owner.
- Resolve material ambiguity before implementation. Label unresolved items **To be decided**; do not hide a choice inside code.
- Update the plan when discoveries change affected modules, transaction boundaries, migration sequencing, security controls, recovery, or scope.
- Record verification evidence and deviations as the work proceeds. A plan is a living execution record, not only an upfront proposal.
- If a decision changes the architecture or accepted baseline, create or update an ADR and follow specification change control.
- Close the plan only after its definition of done is satisfied or document why it was superseded.
