# Implementation Plan: Local infrastructure and dependency readiness

- **Status:** Completed
- **Owner:** SettleFlow Project
- **Created:** 2026-07-31
- **Last updated:** 2026-07-31
- **Related issue/PR:** None
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0002](../adr/0002-node-typescript-package-manager-and-version-policy.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0004](../adr/0004-rabbitmq-outbox-inbox-and-message-delivery.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md)

## Goal

Provide reproducible local PostgreSQL and RabbitMQ services and make API/worker readiness truthfully reflect bounded real connectivity, including clean connection shutdown and real-dependency integration evidence.

### Non-goals

- Payment, ledger, idempotency, authentication, webhook, settlement, reconciliation, provider, or business-event behavior.
- Prisma, database schema/migrations, tables, SQL beyond a read-only health probe, RabbitMQ topology, messages, publishers, or consumers.
- Dockerfiles, application containers, production infrastructure, telemetry backends, or real credentials/data.

## Specification traceability

- **Sections:** Goals, Scope, and Success Criteria; Architecture and Technical Design; Reliability and Operational Design; Verification and Quality Strategy; Delivery and Repository Plan.
- **Requirement IDs:** Implements the dependency-health portion of FR-13 only.
- **Invariant IDs:** INV-01 through INV-10 remain unchanged and are not implemented by this milestone.
- **Acceptance/release gates:** Health behavior, real-dependency integration, reproducible local startup, documentation, static checks, builds, and clean-diff evidence.

This is an M0 infrastructure slice and does not claim the remaining FR-13 telemetry/correlation work or any financial feature.

## Existing behavior

The clean committed scaffold has separate NestJS API and worker entrypoints on Node.js 24.18.0/pnpm 11.18.0. Readiness currently reports dependency checks as deferred. There is no Compose file, database/broker client, shared runtime package, or integration-test project. Evidence inspected includes the complete specification, governance/architecture documents, ADR-0001 through ADR-0005, the completed runnable-foundation plan, source/configuration files, `git status`, repository file inventory, package scripts, and local Docker availability.

## Proposed design

- Add a Compose project containing only PostgreSQL 18.4 and RabbitMQ 4.3.4 management, pinned by exact tags and multi-platform digests, with loopback-only ports, persistent named volumes, and bounded health checks.
- Add a small `packages/infrastructure` workspace package that owns reusable `pg` and `amqplib` connections, bounded dependency probes, sanitized results, and idempotent shutdown. It contains no domain or persistence behavior.
- Require validated PostgreSQL/RabbitMQ URLs and a bounded readiness timeout in both entrypoints. API readiness probes both required dependencies per this milestone. Worker readiness probes PostgreSQL and RabbitMQ on bootstrap and its existing heartbeat cadence.
- Keep liveness process-only. Return HTTP 503 with stable, non-sensitive check statuses when an API dependency is down; keep the worker running but internally not ready during recoverable dependency outages.
- Add isolated Testcontainers integration tests for real-success and unavailable-dependency behavior. Unit tests continue to run without Docker.
- Document Compose start, stop, status/log inspection, per-service outage testing, and explicitly destructive volume reset.

Verified exact additions are `pg` 8.22.0, `@types/pg` 8.20.0, `amqplib` 2.0.1, `@testcontainers/postgresql` 12.0.4, and `@testcontainers/rabbitmq` 12.0.4. PostgreSQL 18.4 is the current supported minor; RabbitMQ 4.3.4 is the current fully supported patch line. Alternatives rejected: duplicate connection implementations in both apps, fake dependency readiness, Prisma installation before a schema milestone, and broker/database startup as a hard process-bootstrap requirement.

## Affected modules and files

| Module/file area                 | Ownership or change                                    | Boundary impact                                                                                  |
| -------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Root Compose/environment/scripts | Local PostgreSQL/RabbitMQ operations and safe examples | Supporting services only                                                                         |
| `packages/infrastructure`        | Shared health-only clients and lifecycle cleanup       | Entry points depend inward on a reusable infrastructure adapter; no bounded module is introduced |
| `apps/api`                       | Dependency-aware HTTP readiness and shutdown           | No API business contract beyond FR-13 health behavior                                            |
| `apps/worker`                    | Dependency-aware internal readiness and shutdown       | No queue topology or message behavior                                                            |
| `test/integration`               | Disposable real-dependency readiness proof             | Test-only dependency direction                                                                   |
| README/this plan                 | Commands, limits, recovery, and evidence               | Documentation only                                                                               |

No module-owned table, cross-module write, financial transaction, or reverse domain dependency is introduced.

## API and integration impact

`GET /health/live` remains process-only. `GET /health/ready` keeps its route but changes from static/deferred output to live PostgreSQL and RabbitMQ statuses, returning 200 only when both are up and 503 otherwise. `GET /api/v1` is unchanged. The worker remains a standalone application context with internal readiness; no HTTP listener, event, webhook, CSV, queue, or public business contract is added.

## Database and migration impact

PostgreSQL is started locally and queried with `SELECT 1` for health only. No Prisma package, schema, migration, database object, seed, role, constraint, trigger, financial table, or write is created. Named local volumes preserve service data until the operator explicitly runs the reset command.

## Transaction boundaries and concurrency

None. Health probes perform no transaction or state change. Connection creation is single-flight per process; RabbitMQ probes open and close a channel to verify the broker. Probe timeouts are bounded, and network work is unrelated to any future financial transaction.

## Security and privacy

Compose binds published ports to loopback and reads synthetic development-only credentials from an ignored root `.env` copied from `.env.example`. Application examples contain only matching local values. Readiness returns stable `up`/`down` statuses without URLs, credentials, raw errors, or internal addresses. No real data or secret is committed or logged.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario | Expected safe state                                                | Retry/recovery                                                           | Evidence                                     |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------- |
| PostgreSQL unavailable        | API 503; worker not ready; liveness remains healthy                | Restore service; next bounded probe reconnects                           | Unit, integration, and local outage exercise |
| RabbitMQ unavailable          | API 503 per milestone requirement; worker not ready                | Restore service; stale connection is discarded and next probe reconnects | Unit, integration, and local outage exercise |
| Probe timeout/error           | Sanitized `down`; process does not crash                           | Automatic next-request/heartbeat retry                                   | Unit/integration tests                       |
| SIGINT/SIGTERM                | Process becomes stopping/unready and closes pool/broker connection | Supervisor may restart                                                   | Lifecycle unit/process exercise              |
| Compose restart               | Named volume data persists                                         | `infra:up` recreates services                                            | Compose inspection                           |
| Explicit reset                | Local named volumes are removed                                    | Recreate empty services with `infra:up`                                  | Documented destructive command only          |

No message retry, delivery, duplicate effect, dead-letter, or financial recovery behavior exists in scope.

## Observability and operations

Health responses and worker lifecycle logs report only service name, readiness state, and dependency status. Worker heartbeats refresh readiness. Compose exposes container health and bounded logs through documented commands. Metrics, traces, alerts, broker backlogs, and production runbooks remain deferred.

## Test strategy

- **Unit:** API 200/503 mapping and worker lifecycle/readiness state with dependency doubles.
- **Database constraints/migrations:** Not applicable; none exist.
- **Integration with real dependencies:** Testcontainers starts pinned real PostgreSQL/RabbitMQ images and proves both-up plus safe unavailable results.
- **Contract:** Start Compose and API; verify all three foundation routes and the readiness response/status.
- **Concurrency/race:** Only single-flight connection acquisition is reviewed; no financial concurrency exists.
- **Failure injection/recovery:** Stop one required Compose service, verify API 503 and worker not-ready behavior, restart, and verify recovery.
- **Security:** Inspect examples/diff for secrets and health output for sensitive diagnostics.
- **Performance:** Not applicable beyond bounded readiness timeouts.
- **Documentation/link checks:** Verify relative Markdown links, `git diff --check`, and complete status/diff review.

Commands include frozen pnpm install, lint, format check, type-check, unit tests, Testcontainers integration tests, production build, Compose config/up/ps/health, API/worker startup probes, dependency-stop/recovery checks, link validation, `git diff --check`, and `git status`.

## Documentation impact

Update the root README with exact environment, infrastructure, development, inspection, shutdown, reset, test, and outage commands. Complete this plan with verification evidence. Architecture, ADR, invariant, OpenAPI, schema, and business runbook authority remain unchanged.

## Rollback or forward-recovery strategy

Code/configuration changes are reversible without data migration. `docker compose down` preserves named volumes; reset is separately documented as destructive. A dependency-version correction is a focused manifest/lockfile/image-digest forward fix. No financial or audit record exists to repair.

## Risks and assumptions

| Risk or assumption                                                            | Impact                                                                                   | Mitigation/validation                                                                                               | Owner/deadline                            |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Docker may be unavailable on another workstation/CI runner                    | Integration suite cannot start                                                           | Detect/report the exact runtime blocker; keep unit/static gates independent                                         | SettleFlow Project / runner setup         |
| Image tag and digest can diverge during an update                             | Reproducibility or supply-chain ambiguity                                                | Pin both and update together through review                                                                         | SettleFlow Project / dependency update    |
| API broker readiness is stricter than future synchronous command availability | Deployment admission may stop routing while committed financial state would remain valid | Follow this milestone's explicit requirement; revisit only through approved readiness policy work                   | SettleFlow Project / operations milestone |
| Health clients could be mistaken for persistence/eventing implementation      | Scope confusion                                                                          | Expose only `SELECT 1`, connection/channel checks, and close; no Prisma, schema, topology, publish, or consume APIs | SettleFlow Project / this milestone       |

## Execution checklist

- [x] Design and boundaries reviewed.
- [x] Required ADR/specification change approved or not required.
- [x] Implementation completed; migrations are not applicable.
- [x] Tests and failure scenarios pass.
- [x] Security and sensitive-data review pass.
- [x] Documentation updated.
- [x] Commands/results and deviations recorded below.

## Verification record

| Command or review                                              | Result                                                                                                                                                  | Date/evidence |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Initial `git status --short --branch`                          | Pass: clean `main...origin/main`                                                                                                                        | 2026-07-31    |
| Specification/governance/ADR/scaffold review                   | Pass: no material contradiction                                                                                                                         | 2026-07-31    |
| Official release and local runtime review                      | Pass: exact versions above; Docker Engine 29.4.3 and Compose 5.1.3 available                                                                            | 2026-07-31    |
| `corepack pnpm install --offline --frozen-lockfile`            | Pass: one frozen workspace lockfile installed without lifecycle scripts                                                                                 | 2026-07-31    |
| `docker compose config --quiet` and resolved-config inspection | Pass: only PostgreSQL/RabbitMQ, exact images, two named volumes, loopback ports, and bounded health checks                                              | 2026-07-31    |
| Compose startup and native service diagnostics                 | Pass: both services healthy; `pg_isready` accepted connections and RabbitMQ ping succeeded                                                              | 2026-07-31    |
| `pnpm test:integration`                                        | Pass: one suite/two tests with real pinned containers plus unavailable endpoints                                                                        | 2026-07-31    |
| `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`       | Pass: zero lint/type errors; four unit suites/six tests; both deployables and shared package built                                                      | 2026-07-31    |
| `pnpm format:check`                                            | Pass                                                                                                                                                    | 2026-07-31    |
| API live/ready/version route exercise                          | Pass: all returned HTTP 200 with both dependencies healthy                                                                                              | 2026-07-31    |
| API dependency failure and recovery exercise                   | Pass: liveness stayed HTTP 200, readiness became HTTP 503 when RabbitMQ stopped, and readiness recovered to HTTP 200 after restart                      | 2026-07-31    |
| Worker healthy/failure/recovery exercise                       | Pass: worker reported ready, remained live but not ready during RabbitMQ outage, then recovered                                                         | 2026-07-31    |
| Graceful dependency cleanup                                    | Pass: API and worker lifecycle unit tests verify connection cleanup                                                                                     | 2026-07-31    |
| Host-port deviation                                            | Default host port 5432 was reserved by the workstation; verified with command-local `POSTGRES_PORT=55432`, and documented the supported `.env` override | 2026-07-31    |
| Compose teardown                                               | Pass: containers/network removed and named volumes preserved                                                                                            | 2026-07-31    |
| Markdown links, `git diff --check`, and final `git status`     | Pass; final status intentionally contains only this uncommitted milestone                                                                               | 2026-07-31    |

## Definition of done

- Compose starts only healthy PostgreSQL/RabbitMQ services from pinned images with persistent named volumes and safe examples.
- API and worker report bounded, truthful dependency readiness and close connections cleanly.
- Unit, Testcontainers, static, format, build, HTTP, worker, Compose-health, outage/recovery, link, diff, and status checks pass or an exact environmental blocker is recorded.
- README and this plan document exact commands, destructive reset semantics, versions, limits, and deferred work.
- No schema, migration, Prisma model, financial/business behavior, Dockerfile, real secret, commit, or push is introduced.
