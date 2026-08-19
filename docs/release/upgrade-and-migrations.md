# Installation, Upgrade, and Migration Guide

## First-release installation

The initial v1 candidate is installed into an empty supported PostgreSQL database. It does not claim an upgrade from a prior public release.

1. Verify the source commit/tag, image digest, checksum, SBOM, provenance, release notes, and known limitations.
2. Supply credentials through an external secret mechanism; do not use committed local-development values.
3. Start PostgreSQL and RabbitMQ and wait for their health checks.
4. Run the one-shot runtime-role provisioner as the database owner.
5. Run the one-shot migrator once with `MIGRATION_DATABASE_URL`.
6. Verify the exact migration history, schema drift, grants, named triggers/constraints, and INV-01–INV-10.
7. Start API and worker only after provisioning/migration completes successfully; verify internal liveness/readiness and the authenticated `/v1` surface.

The executable release-simulation sequence is documented in [OCI Images and Release Simulation](../operations/release-simulation.md). Normal API/worker processes receive only `DATABASE_URL` for `settleflow_app`; they never receive the owner URL.

## Local migration commands

```shell
pnpm prisma:validate
pnpm prisma:generate
pnpm db:provision-runtime-role
pnpm db:migrate:apply
pnpm db:migrate:status
pnpm db:migrate:verify
pnpm db:permissions:check
pnpm db:invariants:check
pnpm db:schema:drift
```

`pnpm db:migrate:create` is a development authoring command, not a deployment command. `pnpm db:reset` is destructive local-development guidance only; it must never target a shared, release, recovery-source, or authoritative database.

## Migration review contract

Every schema change must:

- be a new committed migration reviewed with the owning modules and relevant ADR/plan;
- preserve tenant predicates, one-currency money rules, immutable evidence, deferred Ledger constraints, runtime grants, and transaction boundaries;
- document locks, expected duration, data backfill, API/worker compatibility, failure point, and forward recovery;
- apply to an empty database and the maintained prior-public-version fixture; and
- pass drift, permission, financial-invariant, integration, backup/restore, and contract checks affected by the change.

Prisma is the default routine data-access layer. Parameterized raw SQL remains limited to reviewed lock/claim, constraint-trigger, grant, and concurrency paths Prisma cannot express safely.

## Failure and rollback policy

Financial migrations use forward-fix-only recovery after application to authoritative data. Do not edit an applied migration, delete its history, restore over the active source, disable an invariant trigger, or patch posted records to make a deployment pass.

If provisioning or migration fails before normal startup:

1. keep API/worker unready and preserve logs without credentials/data;
2. stop subsequent startup jobs;
3. identify whether no change, a transactional rollback, or a committed partial DDL boundary occurred;
4. restore into isolation if backup validation is required;
5. implement and review a new corrective migration or code forward fix; and
6. rerun the complete migration/grant/invariant suite before starting normal processes.

Container rollback is safe only when the older API/worker is compatible with the already-applied schema and no contract/invariant is weakened. Otherwise remain stopped and forward-fix.

## Backup and recovery prerequisite

Take and verify a sensitive logical backup under the [database recovery procedure](../operations/database-recovery.md) before any future non-trivial upgrade. Restore exercises target a newly created disposable instance, never the active source. RabbitMQ is recreated from declarative topology and is not a financial backup target.

The current isolated exercise proves restorability and a 78-second RTO result against the simulation's 60-minute target. The 15-minute RPO remains unclaimed until a sustained approved backup cadence is implemented and exercised.
