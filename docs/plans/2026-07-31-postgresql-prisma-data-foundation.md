# Implementation Plan: PostgreSQL and Prisma data foundation

- **Status:** Completed
- **Owner:** SettleFlow Project
- **Created:** 2026-07-31
- **Last updated:** 2026-07-31
- **Related issue/PR:** None
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0002](../adr/0002-node-typescript-package-manager-and-version-policy.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md)

## Goal

Establish a reproducible Prisma schema, client, and migration workflow against the existing PostgreSQL service, with one lifecycle-managed Prisma client per process and real empty-database verification, without introducing an unjustified domain table.

### Non-goals

- Payments, payment intents, refunds, transactions, ledger, balances, idempotency, authentication, webhooks, settlements, reconciliation, providers, RabbitMQ topology, outbox/inbox, or business events.
- Financial tables or columns, tenant behavior, supported-currency policy, demo fixtures, or invented reference data.
- Replacing the existing health-only `pg` readiness pool or implementing a production migration runner.

## Specification traceability

- **Sections:** Design principles; Goals, Scope, and Success Criteria; Architecture and Technical Design; Data Architecture and Integrity Controls; Verification and Quality Strategy; Delivery and Repository Plan.
- **Requirement IDs:** No functional requirement is claimed. This is an M0 database/migration and reproducibility foundation supporting later FR-01 through FR-14 work.
- **Invariant IDs:** INV-01 through INV-10 remain unchanged and are not implemented because no financial model is introduced.
- **Acceptance/release gates:** Fresh setup, full migration history on an empty real PostgreSQL database, generated-client validation, graceful resource cleanup, documentation, static checks, tests, builds, and clean-diff evidence.

The specification's core-entity table contains bounded-domain entities only. It does not define a standalone reference-data entity. OQ-01 names default demo currencies but leaves the fixture choice to the M1 deadline and does not authorize a currency table. Therefore this milestone intentionally adds zero Prisma models and no seed.

## Existing behavior

The clean committed repository has Node.js 24.18.0, pnpm 11.18.0, TypeScript 6.0.3, PostgreSQL 18.4, RabbitMQ 4.3.4, two NestJS entrypoints, a shared health-only infrastructure package, one lockfile, Compose health checks, and real Testcontainers readiness tests. PostgreSQL readiness uses a bounded `pg` pool and `SELECT 1`; there is no Prisma dependency, schema, migration, generated client, lifecycle manager, or database workflow.

Evidence inspected includes the complete specification, governance and architecture documents, ADR-0001 through ADR-0005, both completed implementation plans, README, Compose/environment configuration, workspace manifests/scripts, current infrastructure source/tests, and a clean `git status` at commit `0f3d120`.

## Proposed design

- Pin Prisma CLI, Prisma Client, and the PostgreSQL driver adapter at 7.9.1. Official requirements support Node.js 24, TypeScript 5.4+, and self-hosted PostgreSQL 9.6+, which covers the repository's Node.js 24.18.0, TypeScript 6.0.3, and PostgreSQL 18.4 pins. pnpm is an officially documented install/run path and the repository keeps pnpm 11.18.0.
- Put `schema.prisma` and migration history under root `prisma/`, matching the specification's recommended structure. Put CLI connection configuration in root `prisma.config.mts` and load an optional ignored root `.env` through Node.js 24's built-in environment-file loader.
- Use the Prisma 7 `prisma-client` generator with an explicit ignored output inside `packages/infrastructure/src/generated/prisma`, CommonJS module output for the existing repository module format, and explicit generation before compile/test gates.
- Add one lazy `PrismaDatabase` provider per Nest application context. It owns one Prisma Client/adapter, exposes connectivity for infrastructure tests, and makes disconnect idempotent. API and worker lifecycle paths close it alongside existing dependency connections.
- Retain the existing `pg` readiness probe unchanged. It is already bounded, real, and health-only; replacing it would add scope without improving this milestone's readiness contract.
- Commit one intentionally empty baseline migration so migration application and history are testable. Applying it creates no application table; Prisma's internal `_prisma_migrations` history table is the only database object introduced.
- Do not configure seeding because there is no authorized reference model or deterministic initial record to create.

Alternatives rejected: a `Currency` table based only on OQ-01 defaults, a `Merchant` table without the Merchant Access milestone, generated client code committed to Git, a Prisma client per controller/request, Prisma-backed replacement of the proven readiness adapter, and schema synchronization through `db push` instead of reviewed migrations.

## Affected modules and files

| Module/file area                | Ownership or change                                          | Boundary impact                                                                           |
| ------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Root Prisma/schema/migrations   | CLI configuration and reviewed migration history             | Infrastructure only; no bounded-module table ownership exists yet                         |
| `packages/infrastructure`       | Generated-client target and lifecycle-managed Prisma adapter | Shared adapter available to future module-owned persistence; no cross-module table access |
| API and worker composition      | One Prisma provider and shutdown delegation per process      | Entrypoints remain thin; no query or business behavior                                    |
| Root scripts/lock/tooling       | Exact Prisma commands, generation gates, dependencies        | One workspace and lockfile remain authoritative                                           |
| Integration tests               | Empty-database migration and Prisma connectivity proof       | Real PostgreSQL only; no in-memory substitute                                             |
| README/plan/environment example | Safe commands, reset warning, decision evidence              | Documentation/configuration only                                                          |

## API and integration impact

No REST, OpenAPI, event, RabbitMQ, webhook, CSV, pagination, idempotency, or error contract changes. The three existing API routes and API/worker readiness behavior remain unchanged because the raw readiness implementation remains in place.

## Database and migration impact

- The Prisma schema declares PostgreSQL and a generated client but contains no model or enum.
- The baseline migration contains no DDL for application tables. `prisma migrate deploy` records it in Prisma's internal `_prisma_migrations` table.
- Migration creation is `migrate dev --create-only`; generated SQL must be reviewed before application. Committed migrations are applied with `migrate deploy`; status and destructive local reset have separate scripts.
- Empty-database application and second application are tested. A prior application-schema fixture does not exist, so prior-version upgrade proof is not applicable beyond applying this first baseline to the committed empty foundation.
- API and worker compatibility is unchanged because there is no application schema dependency.

## Transaction boundaries and concurrency

No domain transaction, row lock, isolation level, retryable SQL state, uniqueness rule, or financial concurrency path exists. Migration application is a controlled one-shot operator action. Runtime Prisma connectivity performs only a read-only probe in integration verification; no network call is added to a financial transaction.

## Security and privacy

Only the existing synthetic local PostgreSQL URL is added to the root example. Real `.env` files remain ignored. Prisma configuration does not log the URL or provide a silent production fallback. Generated code and local service state remain ignored. No merchant identifier, personal data, regulated data, authorization value, financial request, or real secret is created.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario                 | Expected safe state                                                              | Retry/recovery                                                    | Evidence                         |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------- |
| Missing/invalid database URL for a DB command | Command fails before migration                                                   | Correct ignored environment and rerun                             | CLI exercises                    |
| PostgreSQL unavailable                        | Migration/connectivity command fails; no application DDL is partially introduced | Restore service and rerun controlled command                      | Integration and local checks     |
| Baseline migration applied twice              | Second deploy reports no pending migration; one successful history row remains   | No repair required                                                | Empty-database integration test  |
| Process shutdown                              | Prisma disconnect and existing readiness/broker cleanup are invoked once safely  | Supervisor may restart                                            | Lifecycle unit/integration tests |
| Migration review finds unsafe SQL             | Migration is not applied/committed                                               | Revise the unapplied migration; use forward fix after application | Documented workflow              |
| Local reset                                   | All local database data is destroyed and committed migrations reapplied          | Explicit operator confirmation; no production guidance implied    | README warning                   |

No command/message duplicate, outbox, dead-letter, or financial recovery behavior is in scope.

## Observability and operations

Existing health responses/logs remain unchanged. Prisma CLI status and migration history provide operator evidence. Prisma connectivity errors are consumed only as boolean test/readiness-style results and do not expose URLs or raw errors. Metrics, traces, migration alerts, production roles, backup/restore, and production runbooks remain deferred.

## Test strategy

- **Unit:** API and worker lifecycle tests prove both existing dependency connections and Prisma lifecycle are closed.
- **Database constraints/migrations:** Apply the complete one-migration history to a disposable empty PostgreSQL database twice; assert one successful migration and no application tables.
- **Integration with real dependencies:** Prove the Prisma client connects to PostgreSQL and disconnects; retain existing PostgreSQL/RabbitMQ readiness integration tests.
- **Contract:** Start Compose/API and recheck the three unchanged routes.
- **Concurrency/race:** Not applicable; no domain write or row claim exists.
- **Failure injection/recovery:** Repeated migration deployment and clean shutdown.
- **Security:** Verify ignored environment targets, synthetic examples, no unexpected schema objects, and no secret-bearing output.
- **Performance:** Not applicable beyond bounded connection configuration.
- **Documentation/link checks:** Validate Markdown links, inspect all changes/migration SQL, run `git diff --check`, and report complete status.

Commands include frozen pnpm installation, Compose health checks, Prisma validate/generate/migrate status/deploy, integration tests, format, lint, type-check, unit tests, build, HTTP/process shutdown exercises, link validation, `git diff --check`, and `git status`.

## Documentation impact

Update README with exact generate, validate, migration create/apply/status, Studio inspection, destructive database reset, environment, and no-seed commands/decisions. Complete this plan with evidence. Architecture, ADR, invariant, API/event schema, and business runbook authority remain unchanged.

## Rollback or forward-recovery strategy

Before application, the empty migration and configuration can be reverted without application data impact. After application, removing the migration file would corrupt migration history; keep history and use a forward migration for corrections. Local-only reset may recreate the database from committed history. No financial or audit record exists to reverse or repair.

## Risks and assumptions

| Risk or assumption                                               | Impact                                 | Mitigation/validation                                                                                                   | Owner/deadline                                     |
| ---------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Prisma 7 uses a driver adapter and generated TypeScript          | Module-format or build incompatibility | Explicit CommonJS generator; run generate, strict type-check, both builds, and runtime connectivity                     | SettleFlow Project / this milestone                |
| An empty migration may be mistaken for domain progress           | False implementation claim             | Comment migration/schema and assert no application table exists                                                         | SettleFlow Project / this milestone                |
| Root `.env` port can diverge from Compose/app examples           | CLI targets the wrong local port       | Document one coordinated override and verify against the resolved Compose port                                          | SettleFlow Project / this milestone                |
| Future modules could bypass table ownership with a shared client | Boundary erosion                       | Permit the client only inside future module-owned infrastructure adapters; add boundary enforcement with those packages | SettleFlow Project / module milestone              |
| No prior schema fixture exists                                   | Full upgrade-path gate cannot yet run  | Record not-applicable baseline; establish the fixture when the first application schema is committed                    | SettleFlow Project / first domain schema milestone |

## Execution checklist

- [x] Design and boundaries reviewed.
- [x] Required ADR/specification change approved or not required.
- [x] Implementation and migrations completed.
- [x] Tests and failure scenarios pass.
- [x] Security and sensitive-data review pass.
- [x] Documentation and runbooks updated.
- [x] Commands/results and deviations recorded below.

## Verification record

| Command or review                                                                                        | Result                                                                                                              | Date/evidence |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------- |
| Initial `git status --short --branch`                                                                    | Pass: clean `main...origin/main` at `0f3d120`                                                                       | 2026-07-31    |
| Complete specification/governance/ADR/workspace review                                                   | Pass: zero reference models and no seed are authorized for this milestone                                           | 2026-07-31    |
| Official Prisma compatibility review                                                                     | Pass: Prisma 7.9.1 supports Node.js 24, TypeScript 5.4+, self-hosted PostgreSQL 9.6+, and documented pnpm workflows | 2026-07-31    |
| Fresh `pnpm install --offline --frozen-lockfile` after removing all workspace `node_modules` directories | Pass: 815 packages restored from the integrity-addressed store; lockfile and supply-chain policies passed           | 2026-07-31    |
| `pnpm prisma:validate` and `pnpm prisma:generate`                                                        | Pass: schema valid; Prisma Client 7.9.1 generated to the ignored infrastructure output                              | 2026-07-31    |
| `docker compose up --detach --wait` and native health commands                                           | Pass: PostgreSQL 18.4 and RabbitMQ 4.3.4 healthy; `pg_isready` accepted and RabbitMQ ping succeeded                 | 2026-07-31    |
| `pnpm db:migrate:apply` twice and `pnpm db:migrate:status`                                               | Pass: baseline applied once, second deploy had no pending migration, status current                                 | 2026-07-31    |
| Database object/history inspection                                                                       | Pass: `_prisma_migrations` was the only public table and had one successful row                                     | 2026-07-31    |
| Seed verification                                                                                        | Not applicable by design: no authorized reference model and no seed command/process                                 | 2026-07-31    |
| `pnpm format:check`, `pnpm lint`, and `pnpm typecheck`                                                   | Pass                                                                                                                | 2026-07-31    |
| `pnpm test`                                                                                              | Pass: 4 suites, 6 tests                                                                                             | 2026-07-31    |
| `pnpm test:integration`                                                                                  | Pass: 2 suites, 4 tests with real PostgreSQL/RabbitMQ containers                                                    | 2026-07-31    |
| `pnpm build`                                                                                             | Pass: infrastructure, API, and worker production builds                                                             | 2026-07-31    |
| Built API route checks                                                                                   | Pass: `/health/live`, `/health/ready`, and `/api/v1` returned HTTP 200; readiness reported PostgreSQL/RabbitMQ up   | 2026-07-31    |
| Graceful application-context shutdown                                                                    | Pass: Prisma connectivity was true before `app.close()` and false afterward                                         | 2026-07-31    |
| Markdown local-link check and `git diff --check`                                                         | Pass                                                                                                                | 2026-07-31    |
| Final `git status --short --branch`                                                                      | Pass: only intended milestone files changed/untracked; no staged changes                                            | 2026-07-31    |

Direct Node registry requests were unreliable during the initial dependency refresh. A temporary localhost bridge relayed exact npm registry responses through the working system client; the bridge, logs, and temporary registry setting were removed. The final proof was a fresh offline frozen-lockfile install, so no repository registry override or undeclared artifact is required.

## Definition of done

- Exact Prisma dependencies, schema/configuration, generated-client workflow, and one reviewed empty migration are reproducible with the pinned toolchain.
- Prisma validation/generation and clean/repeated migration deployment pass against real PostgreSQL without creating an application table.
- Each process owns one lazy Prisma client and closes it cleanly; existing raw readiness and API contracts remain unchanged.
- Full static, unit, integration, build, Compose, HTTP, link, diff, and status gates pass.
- README and this plan explicitly document the no-model/no-seed decision, commands, destructive reset, limitations, and deferred work.
- No financial/domain table or behavior, authentication, eventing topology, real secret, commit, or push is introduced.
