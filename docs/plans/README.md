# Implementation Plans

This directory contains execution plans required by [PLANS.md](../../PLANS.md). Start from [implementation-plan-template.md](implementation-plan-template.md).

## Naming and status

Use `YYYY-MM-DD-short-title.md` unless a stable issue/milestone convention has been approved. Each plan identifies its owner, status, requirement IDs, and related ADRs. Valid statuses are `Draft`, `Approved`, `In progress`, `Completed`, and `Superseded`.

## Expectations

- Base the plan on inspected repository behavior and the complete specification, not assumptions.
- Make transaction boundaries, module ownership, database effects, failure recovery, security, observability, and verification reviewable before implementation.
- Label open choices **To be decided** with an owner and decision deadline.
- Update the plan during implementation when evidence changes the design, risk, or scope.
- Record commands and results before marking the plan completed.
- Link superseded plans instead of deleting history.

Plans do not override the specification or accepted ADRs. A material conflict must go through specification change control and, where appropriate, a new ADR.
