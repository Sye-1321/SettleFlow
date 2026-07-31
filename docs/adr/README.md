# Architecture Decision Records

ADRs record material SettleFlow design decisions and their consequences. Use [0000-adr-template.md](0000-adr-template.md) and name new records `NNNN-short-title.md` with a monotonically increasing four-digit number.

## When an ADR is required

Create an ADR for a material change to architecture, bounded-module ownership or dependencies, transaction/consistency strategy, data access policy, PostgreSQL/RabbitMQ roles, public contracts, security boundaries, deployment topology, or production dependencies. Also use an ADR when choosing among alternatives has meaningful financial, security, reliability, compatibility, or operational consequences.

Small implementation details that follow an accepted design belong in an implementation plan or code review, not a new ADR.

## Authority and status

Allowed statuses are `Proposed`, `Accepted`, `Rejected`, `Deprecated`, and `Superseded`.

- The specification is authoritative. An ADR must cite the relevant requirement IDs and specification sections.
- An ADR may refine unspecified detail. It cannot silently contradict or supersede the specification.
- A decision that changes a material specification baseline requires the specification's change control and version update as well as an accepted ADR.
- Superseding records link both directions and preserve the earlier record.
- Accepted ADRs are immutable except for status/link/typographical corrections; change the decision with a new ADR.

## Workflow

1. Copy the template and complete context, decision drivers, options, consequences, and verification.
2. Mark unresolved facts **To be decided**. Do not bias review by presenting an unexamined choice as settled.
3. Obtain financial, security, database, or architecture review appropriate to the decision.
4. Set `Accepted` only after approval and any required specification change.
5. Update architecture, plans, contracts, tests, and runbooks in the implementation pull request.

The specification already records baseline decisions corresponding to a modular monolith, API/worker deployables, PostgreSQL plus RabbitMQ, transactional outbox/inbox with lease claims, separate payment/settlement lifecycles, Prisma plus reviewed raw SQL, exclusion of Redis without evidence, and webhook URLs as an SSRF boundary. Individual ADR files for those decisions are **To be created** during the relevant implementation milestone; do not infer their approval metadata.
