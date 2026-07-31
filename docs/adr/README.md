# Architecture Decision Records

ADRs record material SettleFlow design decisions and their consequences. Use [0000-adr-template.md](0000-adr-template.md) and name new records `NNNN-short-title.md` with a monotonically increasing four-digit number.

## Decision index

| ADR | Status | Decision | Specification baseline |
| --- | --- | --- | --- |
| [ADR-0001](0001-nestjs-modular-monolith-and-two-deployables.md) | Accepted | NestJS and TypeScript modular monolith with separate API and worker deployables | Records specification ADR-001 |
| [ADR-0002](0002-node-typescript-package-manager-and-version-policy.md) | Accepted | Current verified Node.js LTS policy, TypeScript, pnpm workspaces, and exact-version pinning during scaffolding | Refines the technology/dependency baseline |
| [ADR-0003](0003-postgresql-prisma-and-financial-data-access.md) | Accepted | PostgreSQL authority, Prisma default access, and narrow reviewed parameterized raw-SQL exceptions | Records PostgreSQL portion of ADR-002 and ADR-005 |
| [ADR-0004](0004-rabbitmq-outbox-inbox-and-message-delivery.md) | Accepted | RabbitMQ at-least-once delivery with outbox, inbox, confirms, manual acknowledgements, and dead-letter recovery | Records RabbitMQ portion of ADR-002 and ADR-003 |
| [ADR-0005](0005-local-development-and-test-environment.md) | Accepted | Docker Compose supporting services, Testcontainers integration tests, deterministic mock provider, and bounded scope | Refines technology, test, and delivery baselines |

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

## Specification baseline coverage

The five indexed ADRs record the decisions required before safe project scaffolding. Their numbering is the repository sequence and does not renumber or supersede the specification's initial ADR register.

The specification's remaining accepted baselines still apply directly:

- ADR-004: keep payment status separate from settlement status;
- ADR-006: do not introduce Redis in v1.0 without a measured use case;
- ADR-007: treat registered webhook URLs as an SSRF boundary.

Standalone repository ADRs for those decisions are **To be created** when the affected implementation milestone requires them. Until then, the specification and architecture documents remain authoritative. The indexed ADRs do not authorize Redis, combined lifecycles, or weakened webhook SSRF controls.
