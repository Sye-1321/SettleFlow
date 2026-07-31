# Implementation Plan: Runnable application foundation

- **Status:** Completed
- **Owner:** SettleFlow Project
- **Created:** 2026-07-31
- **Last updated:** 2026-07-31
- **Related issue/PR:** None
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0002](../adr/0002-node-typescript-package-manager-and-version-policy.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0004](../adr/0004-rabbitmq-outbox-inbox-and-message-delivery.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md)

## Goal

Create the smallest reproducible NestJS/TypeScript foundation that runs separate API and worker processes, validates its environment, reports process-appropriate foundation health, shuts down cleanly, and passes formatting, lint, type-check, unit-test, and production-build gates.

### Non-goals

- Payments, ledger postings, financial calculations, bounded domain modules, or invented financial behavior.
- PostgreSQL/Prisma schema, migrations, database connections, RabbitMQ, outbox/inbox, Docker/Compose, authentication, webhooks, settlements, reconciliation, providers, OpenAPI, or telemetry backends.
- Real bank/card/payment integrations, real secrets or data, subscriptions, FX, tax, Kafka, event sourcing, or a customer-facing frontend.

## Specification traceability

- **Sections:** Goals, Scope, and Success Criteria; Architecture and Technical Design; API and Integration Contracts; Reliability and Operational Design; Verification and Quality Strategy; Delivery and Repository Plan.
- **Requirement IDs:** Partial foundation for FR-13 only; no other functional requirement is claimed as implemented.
- **Invariant IDs:** INV-01 through INV-10 are unchanged and not implemented by this scaffold.
- **Acceptance/release gates:** Static checks, unit tests, production builds, process startup, required foundation routes, reproducible installation, documentation, and clean-diff evidence.

This is an M0 foundation slice. It does not waive any P0 behavior or claim v1.0 readiness.

## Existing behavior

The clean repository contains governance, architecture summaries, five accepted ADRs, and the authoritative specification. It has no package manifest, application source, dependency lockfile, database artifacts, broker artifacts, or root README. Evidence inspected includes `git status --short --branch`, `rg --files`, all governing documents, the complete 1,540-paragraph specification, and official runtime/tool package metadata.

## Proposed design

- Use one pnpm workspace and lockfile with `apps/api`, `apps/worker`, and a reserved `packages/` area that contains no shared runtime package until one is justified.
- Pin Node.js `24.18.0` (the current official LTS patch) and pnpm `11.18.0` exactly. Use NestJS `11.1.28` and TypeScript `6.0.3`; TypeScript 7 is not selected because the current `typescript-eslint` and `ts-jest` support ranges exclude it.
- Use NestJS application modules with separate bootstrap/configuration paths. The API exposes `GET /health/live`, `GET /health/ready`, and `GET /api/v1`. The worker uses a standalone Nest application context with internal liveness/readiness state and structured startup/shutdown evidence rather than an unnecessary HTTP server.
- Validate app-specific environment files at startup. Commit placeholder `.env.example` files only; local `.env` files remain ignored.
- Foundation readiness covers configuration and completed bootstrap only. Responses/logs disclose PostgreSQL and RabbitMQ checks as deferred. Dependency-aware readiness becomes mandatory in the milestone that introduces those dependencies.
- Use Jest/ts-jest for unit tests, ESLint with type-aware TypeScript rules, Prettier, strict TypeScript, and Nest CLI builds.
- Override vulnerable transitive `brace-expansion` releases with reviewed patched release `5.0.9`; retain pnpm's default blocked-build posture and explicitly reject the unnecessary `unrs-resolver` fallback postinstall because its exact platform binding is already installed.

Alternatives rejected: one combined process (contradicts ADR-0001), TypeScript 7 (unsupported by selected lint/test tooling), creating a shared runtime package for a few app-specific types (unnecessary coupling), and fake database/broker readiness (misleading and outside scope).

## Affected modules and files

| Module/file area | Ownership or change | Boundary impact |
| --- | --- | --- |
| Root workspace/tooling | Exact pins, scripts, lint/test/build configuration, one lockfile | Establishes repository-wide tooling only |
| `apps/api` | HTTP bootstrap, app module, environment validation, version and health controllers | Thin entrypoint; no domain behavior |
| `apps/worker` | Standalone bootstrap, runtime lifecycle, environment validation, health state | Thin entrypoint; no table or broker access |
| `packages/` | Boundary note only | No shared package or dependency direction introduced |
| Root README | Setup, commands, routes, worker health behavior, limitations | Documentation only |

No bounded domain module, cross-module read/write, or financial transaction path is introduced.

## API and integration impact

Adds only the requested foundation routes: `GET /health/live`, `GET /health/ready`, and `GET /api/v1`. No payment API, authentication contract, event, RabbitMQ, webhook, CSV, pagination, idempotency, or financial error contract is created. OpenAPI is deferred with the product endpoints.

## Database and migration impact

None. Prisma compatibility is verified, but Prisma packages, schema, migrations, SQL, PostgreSQL configuration, and Testcontainers code are intentionally not installed or created in this milestone.

## Transaction boundaries and concurrency

None. There is no persistence, financial command, lock, isolation choice, uniqueness control, network call, or retry loop. INV-01 through INV-10 remain unaffected.

## Security and privacy

Only allowlisted environment keys with bounded numeric/string values are accepted. Example environment files contain non-secret local placeholders. No authorization, credentials, sensitive payloads, real data, outbound URLs, or secret logging is introduced. Processes bind the API to loopback by default.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario | Expected safe state | Retry/recovery | Evidence |
| --- | --- | --- | --- |
| Invalid environment value | Process fails before accepting work | Correct configuration and restart | Startup validation check |
| API bootstrap/listen failure | Non-zero process exit; no partial application state | Correct cause and restart | Startup exercise |
| Worker bootstrap failure | Non-zero process exit; worker never reports ready | Correct cause and restart | Startup exercise |
| SIGINT/SIGTERM | Nest shutdown hooks run; worker clears its keepalive and becomes unready | Supervisor may restart | Hook inspection plus programmatic Nest close exercise |
| PostgreSQL/RabbitMQ outage | Not applicable because neither dependency exists yet | Add real bounded checks with those integrations | Explicit deferred-check metadata |

No command/message duplicate behavior exists in this scope.

## Observability and operations

Nest startup output plus small structured API/worker lifecycle messages identify the service and state without secrets. API liveness is process-only. API and worker readiness report only current foundation checks and list future dependency checks as deferred. Metrics, tracing, correlation IDs, alerts, dashboards, and production runbooks remain deferred.

## Test strategy

- **Unit:** One API test covers liveness/readiness and one worker test covers live, ready, and stopping state.
- **Database constraints/migrations:** Not applicable; no database artifacts.
- **Integration with real dependencies:** Not applicable; Prisma/Testcontainers/PostgreSQL/RabbitMQ are deferred.
- **Contract:** Start the API and verify the three exact routes and statuses.
- **Concurrency/race:** Not applicable.
- **Failure injection/recovery:** Verify invalid environment rejection and controlled shutdown behavior where practical.
- **Security:** Inspect examples and diff for secrets; validate bounded configuration.
- **Performance:** Not applicable at foundation scale.
- **Documentation/link checks:** Inspect Markdown links, run `git diff --check`, and review the complete diff/status.

Commands: exact-pnpm install from an absent `node_modules`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, API/worker startup probes, `git diff --check`, and `git status`.

## Documentation impact

Create the root README setup/command section and this execution plan. No architecture, invariant, ADR, OpenAPI, schema, runbook, or release-note authority changes.

## Rollback or forward-recovery strategy

All changes are new source/configuration files with no persistent state. They can be reverted as one foundation change. Dependency corrections regenerate the single lockfile from exact reviewed manifest pins. No financial/audit evidence exists to migrate or repair.

## Risks and assumptions

| Risk or assumption | Impact | Mitigation/validation | Owner/deadline |
| --- | --- | --- | --- |
| Local shell initially used Node 22.20.0 | Could hide selected-runtime incompatibility | Install/select Node 24.18.0 with the existing version manager, require it through `.node-version` and engine policy, and record actual versions | SettleFlow Project / this milestone |
| TypeScript 7 is newer but unsupported by current lint/test peers | Unsupported compiler could make gates unreliable | Pin TypeScript 6.0.3, the newest common supported line | SettleFlow Project / this milestone |
| Foundation readiness lacks DB/broker checks | Could be mistaken for final FR-13 compliance | Return/log explicit deferred checks and state partial FR-13 status | SettleFlow Project / database/eventing milestones |
| Testcontainers and Prisma are verified but unused | Installing them now would expand an empty integration surface | Defer packages and exact implementation pins until their approved milestones | SettleFlow Project / database/test milestone |

## Execution checklist

- [x] Design and boundaries reviewed.
- [x] Required ADR/specification change approved or not required.
- [x] Implementation completed; migrations are not applicable.
- [x] Tests and process exercises pass.
- [x] Security and sensitive-data review pass.
- [x] Documentation updated.
- [x] Commands/results and deviations recorded below.

## Verification record

| Command or review | Result | Date/evidence |
| --- | --- | --- |
| Initial `git status --short --branch` and porcelain status | Pass: clean `main...origin/main` | 2026-07-31 |
| Specification/governance/ADR review | Pass: no material contradiction | 2026-07-31 |
| Official compatibility review | Pass: Node 24.18.0 LTS, pnpm 11.18.0, NestJS 11.1.28, TypeScript 6.0.3, and compatible tooling selected | 2026-07-31 |
| Fresh `corepack pnpm install` from absent `node_modules` | Pass after registry retries and selecting Node 24.18.0 with the existing NVM installation; one lockfile generated | 2026-07-31 |
| `corepack pnpm install --frozen-lockfile` | Pass: lockfile already up to date, pnpm 11.18.0 | 2026-07-31 |
| `corepack pnpm audit --audit-level=high` | Pass: no known vulnerabilities after the narrow `brace-expansion` 5.0.9 override | 2026-07-31 |
| `corepack pnpm lint` | Pass: zero warnings/errors | 2026-07-31 |
| `corepack pnpm typecheck` | Pass: strict no-emit TypeScript check | 2026-07-31 |
| `corepack pnpm test` | Pass: 2 suites, 3 tests | 2026-07-31 |
| `corepack pnpm build` | Pass: independent API and worker production outputs | 2026-07-31 |
| `corepack pnpm format:check` | Pass: all matched files use Prettier style | 2026-07-31 |
| Built API route exercise | Pass: `/health/live`, `/health/ready`, and `/api/v1` each returned HTTP 200 with expected JSON; stderr empty | 2026-07-31 |
| Built worker exercise | Pass: process remained running, logged `worker.ready` and `worker.started` with PostgreSQL/RabbitMQ deferred, stderr empty | 2026-07-31 |
| Programmatic graceful-close exercise | Pass: API closed cleanly; worker changed from `ready` to `not_ready` and cleared its lifecycle resources | 2026-07-31 |
| Invalid environment exercises | Pass: invalid API port and worker heartbeat each exited with status 1 before accepting work | 2026-07-31 |
| Markdown relative-link check | Pass: 77 relative links resolved | 2026-07-31 |
| `git diff --check` and final status/diff review | Pass: no whitespace errors; complete status recorded in handoff | 2026-07-31 |

## Definition of done

- Exact Node.js and pnpm pins, one pnpm lockfile, and exact direct dependency versions are present and reproducible.
- Both NestJS processes have separate strict-TypeScript bootstraps, validated configuration, truthful health/readiness behavior, and graceful shutdown.
- The three API routes and worker startup/readiness are exercised.
- Lint, type-check, unit tests, production builds, Markdown links, `git diff --check`, and full status/diff review pass.
- README commands are exact, no secret is committed, and no excluded application/domain/infrastructure behavior is introduced.
- The plan records final evidence and is marked `Completed` only after every applicable condition passes.
