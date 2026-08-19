# Implementation Plan: Operational Readiness and v1 Release

- **Status:** In progress — implementation-order steps 2 through 7 and the bounded Step 9 public-documentation foundation implemented
- **Owner:** SettleFlow Project
- **Created:** 2026-08-03
- **Last updated:** 2026-08-15
- **Related issue/PR:** To be decided
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0002](../adr/0002-node-typescript-package-manager-and-version-policy.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0004](../adr/0004-rabbitmq-outbox-inbox-and-message-delivery.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md), [ADR-0013](../adr/0013-problem-details-audit-and-retention-boundaries.md), [ADR-0014](../adr/0014-webhook-endpoint-url-and-ssrf-policy.md), [ADR-0018](../adr/0018-signed-webhook-delivery-contract.md), [ADR-0019](../adr/0019-webhook-delivery-reliability-and-lifecycle.md), [ADR-0020](../adr/0020-immutable-double-entry-ledger-foundation.md), and [ADR-0021](../adr/0021-settlement-ledger-accounts-and-guarded-posting.md)

## Goal

Make the committed SettleFlow finance-grade simulation observable, reproducible, recoverable, security-reviewable, and releasable as a public v1 case study without changing its financial behavior. A reviewer must be able to start a production-shaped local topology, run a deterministic end-to-end demonstration, inspect safe operational signals, exercise failure and database recovery, and verify the same release gates in CI.

Success means:

- API and worker emit one consistent structured-log contract, preserve request/event/delivery correlation, expose protected Prometheus-compatible metrics, and create bounded OpenTelemetry spans without making telemetry a command dependency;
- liveness remains process-only and readiness accurately reflects each deployable's required dependencies and responsibilities;
- pull requests, `main`, scheduled verification, and releases have explicit blocking quality, migration, financial, security, contract, performance, and documentation gates;
- API and worker have pinned, non-root, independently runnable OCI images and a production-shaped **release-simulation** Compose topology;
- a fresh clone reaches a deterministic synthetic demonstration in no more than 15 minutes on the documented reference environment;
- logical PostgreSQL backup and isolated restore are exercised against the complete migration history and all financial invariants, with measured reference RPO/RTO evidence and honest RabbitMQ limitations;
- release artifacts clearly state that SettleFlow moves no real funds and is not a production, regulatory, security, or compliance certification; and
- every P0 requirement is either proven or listed in an owner-approved waiver with rationale, risk, and follow-up ownership.

### Non-goals

- No real payment provider, payout, bank transfer, provider credential, or live-funds operation.
- No dashboard or admin UI, KYC, card data, customer wallet, subscription, authorization flow, partial capture, dispute, chargeback, FX, tax, or customer-facing frontend.
- No manual replay API, Ledger read API, new Payment Intent behavior, new settlement/reconciliation behavior, or new financial state transition.
- No mutable financial repair, direct Ledger/Settlement/Outbox/Inbox/Webhook/Audit row repair, or destructive evidence cleanup.
- No Kubernetes, service mesh, multi-region, active-active, or production certification claim.
- No production KMS adapter. The accepted local webhook keyring remains forbidden when `NODE_ENV=production`.
- No change to existing API, event, webhook, CSV, fee, money, lifecycle, idempotency, retry, or accounting contracts except additive internal operational endpoints/metadata approved below.

## Specification traceability

- **Sections:** Goals, Scope, and Success Criteria; Architecture and Technical Design; Migrations and Compatibility; Security and Threat Model; Reliability and Operational Design; Verification and Quality Strategy; Delivery and Repository Plan; Acceptance Baseline; Appendix A.
- **Requirement IDs:** FR-13 will be implemented directly. FR-01 through FR-12 and FR-14 are regression/release-gate inputs. FR-15 and FR-16 remain explicit P1 deferrals.
- **Invariant IDs:** INV-01 through INV-10 are unchanged and remain release-blocking.
- **Acceptance/release gates:** specification Table 9 success measures; Tables 31-40 service objectives, failure handling, telemetry, runbooks, verification, performance, release, milestone, and CI gates; Table 45 definition of done.

This plan is the M4 Operations/Hardening and M5 Public Release plan. It does not silently promote P1 features or waive P0 gaps. The repository owner approved Gates 1-10 on 2026-08-09, including the classified P0 waivers, P1 deferrals, and operational limitations recorded below. Every final `v1.0.0` artifact and release note must preserve that classification.

The following specification tension is material:

- the endpoint catalog and FR-10 baseline include delivery inspection and controlled replay, while accepted ADR-0019 and the current task explicitly defer manual replay;
- the endpoint catalog includes `GET /v1/ledger/transactions/{id}`, while the accepted Ledger foundation and the current task explicitly defer the Ledger read API;
- Table 23 describes bounded Idempotency/Eventing/Reconciliation retention, while accepted ADRs and implemented milestones authorize no destructive cleanup job yet;
- OQ-06 defaults to Prometheus plus Grafana, but dashboards are excluded from this milestone and FR-16 is P1; and
- production rejects the local webhook keyring, while a production KMS adapter is outside this simulation release.

The approved resolution is an honest release waiver/known-limitations record, not implementation in this plan and not a false claim of complete production readiness. Public material must describe SettleFlow only as a **finance-grade simulation**.

## Evidence inspected and existing behavior

### Repository baseline

- Git was clean on `main` at committed settlement/reconciliation revision `85085a4`, tracking `origin/main`.
- The complete authoritative v1.0 `.docx` was inspected, including all tables, requirements, invariants, service objectives, runbooks, CI stages, release gates, and acceptance conditions.
- Governance, architecture, all indexed ADR decisions, completed plans, the Prisma schema and 11 migrations, package scripts, source, tests, runbooks, examples, Compose, environment validation, OpenAPI, event schemas, SECURITY/CONTRIBUTING, and root README were inspected.
- The committed Settlement/Reconciliation verification record reports 44 unit/contract suites with 196 tests and 10 real-dependency integration suites with 61 tests, all passing, plus clean migration, build, OpenAPI, formatting, lint, type, and documentation gates. This plan treats that record as baseline evidence; it does not rerun implementation gates during this documentation-only milestone.

### Current operational surface

- `apps/api` and `apps/worker` are separate NestJS entrypoints. Both validate environment at bootstrap and close Prisma/dependency resources on shutdown.
- API liveness is process-only. API readiness checks PostgreSQL and RabbitMQ with a bounded timeout and returns a generic RFC 9457 `503` when unavailable.
- The worker is an application context with no HTTP listener. Its in-memory readiness requires PostgreSQL, RabbitMQ publisher/topology, active RabbitMQ consumers, Reconciliation processing, and Webhook delivery. A debug heartbeat logs the current health snapshot.
- API `X-Request-Id` handling rejects duplicate, overlong, or log-injection values, returns one canonical ID, and passes it into command/event records. AMQP `messageId`/`correlationId` and headers carry event/request/merchant identity. Webhook deliveries preserve event and delivery IDs.
- Modules expose bounded observer/signal types, and the API/worker emit JSON fragments through Nest's default logger. There is no common JSON logger, request-completion access log, AsyncLocalStorage context, Prometheus registry/endpoint, OpenTelemetry SDK/exporter, trace-context policy, or alert-rule implementation.
- `compose.yaml` contains only loopback-published PostgreSQL 18.4 and RabbitMQ 4.3.4 with health checks and named volumes. It has no API, worker, migration job, telemetry service, isolated networks, or production-shaped application configuration.
- No Dockerfile or `.dockerignore` exists. The API and worker production builds run from the host toolchain only.
- No `.github/workflows` directory, automated dependency-update configuration, CODEOWNERS, license, changelog, release checklist, performance directory, SBOM, provenance, or release artifact workflow exists.
- Existing commands cover frozen installation, Prisma generate/validate/deploy/status, role provisioning, format, lint, type-check, unit tests, integration tests, build, and OpenAPI drift. There is no module-boundary command, Markdown-link command, coverage threshold, migration upgrade harness, performance command, secret/SAST/dependency/container scan, recovery exercise, or clean-room demo command.
- The repository has an exact synthetic reconciliation CSV shape fixture but no seed command, demo merchant/key provisioner, signed webhook receiver, end-to-end demo orchestration, or sanitized demo evidence output.
- Eight feature runbooks exist. The required database recovery runbook, general incident-response/severity policy, alert catalog, release runbook, and exercised evidence index do not.
- `SECURITY.md` still contains unresolved private-reporting contact/channel and response-policy placeholders. `package.json` remains version `0.0.0` and `UNLICENSED`.

## Proposed design

### 1. Telemetry boundary and non-interference rule

Use an Infrastructure-owned telemetry adapter, composed separately by API and worker, with these exact rules:

1. Domain modules retain their current observer ports and do not import NestJS, Prometheus, OpenTelemetry, or a vendor SDK.
2. `packages/infrastructure` owns logger, context, metric-registry, trace-bootstrap, and internal HTTP exposition adapters. App-level adapters map existing bounded domain observations to that infrastructure.
3. Use official OpenTelemetry JavaScript SDK/exporter packages for tracing and `prom-client` for Prometheus-compatible metrics. Use built-in `node:http` for the internal worker/admin listener. Exact stable versions are verified against pinned Node 24.18.0 and pinned exactly during implementation under ADR-0002.
4. Telemetry calls are synchronous-safe or best-effort buffered, catch their own failures, never start/commit/roll back a business transaction, and never affect an API response, broker acknowledgement, lease finalization, Webhook outcome, or readiness except that the internal telemetry listener's own health is reported diagnostically.
5. PostgreSQL remains authoritative. Metrics, logs, traces, Prometheus, and an OTLP collector may all be unavailable without changing financial state.
6. The default exporter is no-op when telemetry is disabled. An OTLP exporter uses bounded queue, export timeout, and shutdown flush; export failure is rate-limited to a safe structured warning.

Rejected alternatives:

- putting vendor SDKs inside domain packages, because it reverses the adapter dependency and can make telemetry a business dependency;
- using logs as metrics or audit evidence, because logs are sampled/retained operational data rather than authoritative state;
- adding a mutable telemetry table, because PostgreSQL telemetry persistence is not required and could contend with financial transactions; and
- adding Grafana/admin dashboards in this milestone, because the user explicitly excludes dashboards and FR-16 is P1.

### 2. Structured logging and correlation

Replace decorated mixed Nest output with one JSON object per line on stdout/stderr. Every entry has the bounded base contract:

| Field                                       | Rule                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `timestamp`                                 | UTC RFC 3339 with milliseconds, emitted by the logger                     |
| `level`                                     | `debug`, `info`, `warn`, or `error`                                       |
| `service`                                   | exactly `api` or `worker`                                                 |
| `environment`                               | bounded configured environment name, not a hostname or credential         |
| `releaseVersion`                            | immutable build/tag version                                               |
| `event`                                     | stable dotted event name                                                  |
| `code`                                      | optional stable bounded outcome/error code                                |
| `requestId`                                 | canonical request/correlation ID when known                               |
| `traceId` / `spanId`                        | OpenTelemetry identifiers when a span is active                           |
| `eventId` / `deliveryId`                    | safe public asynchronous identifiers when known                           |
| `merchantId`                                | internal UUID only where the existing telemetry classification permits it |
| `durationMs`, `attempt`, `count`, `outcome` | bounded numeric/enumerated operational fields                             |

Use Node `AsyncLocalStorage` to hold request or message context. The API middleware creates context before authentication, then enriches it after successful merchant authentication. RabbitMQ consumers create a fresh context from validated AMQP metadata and event bytes. Scheduled/claimed worker operations create a worker-operation context. The context is always cleared after the unit of work.

The API emits one completion log per request using the route template, method, status class, duration, request ID, and safe authenticated identifiers. It never logs raw URL query strings, headers, bodies, external references, amounts, file names/content, or exception text. Worker logs use existing stable events and safe IDs. Bootstrap/config failures use allowlisted error codes rather than raw messages that could contain connection or secret material.

The following are prohibited in logs, trace attributes, metric labels, alert annotations, demo artifacts, and CI output: Authorization/API/idempotency values, raw request or response bodies, amount values, external/provider references, CSV rows/checksums, endpoint URL components or DNS answers, webhook bytes/signatures/secrets/encryption material, database/RabbitMQ URLs, SQL, stack traces in public output, and arbitrary dependency exception text.

`X-Request-Id`, current outbox `request_id`, AMQP `correlationId`, event ID, and Webhook delivery ID remain the stable cross-system correlation chain. P0 does not add trace-parent columns or change strict event/AMQP contracts. HTTP W3C trace context may create an API span, while a consumer starts a new trace with request/event IDs as safe correlation attributes. End-to-end parent/child propagation through the outbox is P1 and requires a later additive design if needed.

### 3. Traces

Add explicit bounded spans matching the specification:

- API: `http.request`, `merchant.authenticate`, `idempotency.acquire`, `idempotency.replay`, `payment.create`, `payment.capture`, `payment.refund`, `settlement.finalize`, `reconciliation.stage`, and `webhook_endpoint.command`;
- shared operations: `ledger.post`, `outbox.persist`, and bounded PostgreSQL transaction/retry events;
- worker: `outbox.claim`, `outbox.publish`, `rabbit.consume`, `webhook.project`, `webhook.deliver`, `settlement.project`, and `reconciliation.classify`.

Allowed span attributes are service, operation, route template, method, status class, stable outcome/code, retry count, event type, and safe public/correlation IDs. Merchant ID is allowed only under the existing specification classification and is never a metric label. No body, amount, reference, destination, SQL, secret, or raw error attribute is allowed.

Default sampling for the release simulation is parent-based 10% for successful requests/operations plus 100% for errors and explicitly instrumented release-demo runs. This is an operational recommendation, not a correctness dependency. Export queue overflow drops telemetry and increments a bounded self-observation; it never blocks a financial command.

### 4. Metrics and protected exposition

Use a distinct Prometheus registry per process with stable prefix `settleflow_`. No metric label may contain merchant, request, payment, refund, Ledger, settlement, reconciliation, event, endpoint, or delivery IDs. Allowed labels are closed enumerations such as service, command, event type, consumer, outcome, error class, dependency, and currency where explicitly bounded to ETB/USD.

Minimum metrics:

| Family                                                                     | Type              | Required bounded dimensions                   |
| -------------------------------------------------------------------------- | ----------------- | --------------------------------------------- |
| `build_info`                                                               | gauge             | service/version/commit only                   |
| `process_ready` and `dependency_ready`                                     | gauge             | service; dependency                           |
| `http_requests_total` / `http_request_duration_seconds`                    | counter/histogram | method, route template, status class          |
| `payment_commands_total` / `payment_command_duration_seconds`              | counter/histogram | create/capture/refund, outcome, currency      |
| `idempotency_outcomes_total`                                               | counter           | acquired/replay/conflict/in-progress/expired  |
| `ledger_postings_total` / `ledger_invariant_failures_total`                | counters          | business type/outcome; stable invariant class |
| `outbox_publish_total` / `outbox_publish_duration_seconds`                 | counter/histogram | event type, outcome                           |
| `outbox_pending` / `outbox_oldest_age_seconds`                             | gauges            | event type only                               |
| `rabbit_messages_total` / `inbox_dedup_hits_total`                         | counters          | consumer/event type/outcome                   |
| `webhook_due` / `webhook_due_oldest_age_seconds` / `webhook_dead_lettered` | gauges            | no endpoint/merchant labels                   |
| `webhook_attempts_total` / `webhook_delivery_duration_seconds`             | counter/histogram | outcome, bounded HTTP status class            |
| `settlement_runs_total` / `settlement_batch_duration_seconds`              | counter/histogram | outcome, currency                             |
| `settlement_pending_adjustments`                                           | gauge             | currency                                      |
| `reconciliation_imports_total` / `reconciliation_duration_seconds`         | counter/histogram | outcome                                       |
| `reconciliation_results_total`                                             | counter           | closed result bucket, currency                |
| `reconciliation_reports_with_difference`                                   | gauge             | currency only; no amount value                |
| `transaction_retries_total`                                                | counter           | module, stable SQL retry class                |

Queue depth comes from the RabbitMQ management/Prometheus interface or a bounded collector, not from a high-cost scrape inside command handling. PostgreSQL backlog gauges run bounded indexed queries in a background collector with their own timeout and last-success metric. Scrape failure returns the last known safe process metrics plus a collector-failure signal, never a business failure.

Expose `/metrics`, `/health/live`, and `/health/ready` on a dedicated internal listener for the worker. Keep the existing API health contracts unchanged and expose API metrics on a dedicated internal listener rather than through merchant authentication. The internal listeners bind to loopback in host development and to a non-published internal Compose network in release-simulation mode. They are never host/public ingress in production-like guidance. Metrics require no merchant key and are protected by network boundary; public exposure is a deployment error tested by Compose inspection.

### 5. Health and startup behavior

- API liveness remains process-only. API readiness preserves the committed PostgreSQL/RabbitMQ policy and bounded two-second dependency checks.
- Worker liveness becomes externally probeable on its internal listener and remains process-only. Worker readiness reports the existing components separately: PostgreSQL, publisher/topology, RabbitMQ consumers, Reconciliation processor, and Webhook dispatcher.
- Configuration is validated before listeners or claims start. Invalid production/local-keyring combinations continue to fail startup.
- Readiness becomes false before shutdown stops new work. The existing ten-second drains and lease recovery remain unchanged.
- Readiness responses and logs expose only dependency class and `up`/`down`, never endpoints or raw errors.
- Compose uses a startup check appropriate to migrations/configuration, liveness for restart decisions, and readiness for dependency/traffic eligibility. A dependency outage does not cause a liveness restart loop.
- Add unit/integration tests for startup failure, dependency transitions, worker internal probes, shutdown ordering, telemetry-export outage, and redaction.

### 6. Reference alert rules and service objectives

Prometheus recording/alert rules are approved reference defaults for the single-environment simulation. They do not claim a staffed 24x7 service. Every alert links to a runbook and uses only safe labels. The approved thresholds are:

| Condition                                                                                              | Severity / evaluation                              | Response                                                                  |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------- |
| Any Ledger invariant, immutable-evidence, tenant-isolation, or committed Settlement arithmetic failure | critical immediately                               | stop the affected command path and release; use Ledger/Settlement runbook |
| PostgreSQL readiness down                                                                              | critical after 1 minute                            | reject financial work safely; restore DB and verify migration/invariants  |
| API overall readiness down                                                                             | warning after 2 minutes; critical after 5 minutes  | inspect configuration/PostgreSQL/RabbitMQ without restart loops           |
| Worker readiness down                                                                                  | warning after 5 minutes; critical after 15 minutes | restore dependency/consumer/dispatcher and verify backlog catch-up        |
| RabbitMQ publisher or consumer down                                                                    | warning after 5 minutes; critical after 15 minutes | preserve outbox/queues; use outbox/projection runbooks                    |
| Outbox oldest unpublished age > 30 seconds                                                             | warning for 5 minutes                              | inspect relay/broker; reference SLO remains p95 < 10 seconds              |
| Outbox oldest unpublished age > 300 seconds                                                            | critical for 5 minutes                             | incident; never edit or purge rows                                        |
| Due Webhook oldest age > 120 seconds                                                                   | warning for 10 minutes                             | inspect dispatcher/dependency/endpoint outcome                            |
| Due Webhook oldest age > 900 seconds                                                                   | critical for 10 minutes                            | incident; preserve leases/attempts                                        |
| Any new database Webhook dead letter                                                                   | warning within 5 minutes                           | classify endpoint/security/attempt outcome; no ad hoc replay              |
| 10 or more new Webhook dead letters in 15 minutes                                                      | critical                                           | possible systemic delivery/configuration problem                          |
| Reconciliation report has a non-zero difference or mismatch bucket                                     | ticket/warning, not pager                          | use mismatch runbook; never repair finance state from the report          |
| Reconciliation processor/import infrastructure failure persists                                        | critical after 15 minutes                          | restore processor and let leases recover                                  |
| Valid synchronous command error ratio > 2% over 10 minutes with >= 100 attempts                        | warning                                            | inspect by stable outcome; excludes 4xx invalid/auth requests             |
| Valid synchronous command error ratio > 0.5% over 60 minutes with >= 500 attempts                      | critical                                           | threatens >=99.5% reference objective                                     |
| Create/capture p95 > 300 ms or p99 > 600 ms for 15 minutes with >= 100 attempts                        | warning                                            | investigate without weakening correctness                                 |
| Telemetry collector/export failure                                                                     | warning after 15 minutes                           | restore evidence pipeline; do not stop finance commands                   |

`@Sye-1321`, as the repository owner, is the sole incident and alert acknowledgement owner for this simulation. There is no backup maintainer, staffed paging rotation, or 24x7 support commitment. The implemented alert catalog must use a verified notification/escalation path owned by that account. `promtool test rules` must prove every rule against synthetic series before merge.

### 7. CI quality and security gates

Use GitHub Actions because the repository is hosted on GitHub. Every third-party or GitHub action is pinned to a full immutable commit SHA with a comment naming the reviewed release. Workflows have least permissions, concurrency cancellation for superseded PR runs, no `pull_request_target` execution of untrusted code, and no release secrets in ordinary PR jobs.

#### Pull-request blocking workflow

1. Checkout and activate exact Node 24.18.0/pnpm 11.18.0.
2. `corepack pnpm install --frozen-lockfile`; fail on manifest/lockfile drift or an additional lockfile.
3. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm boundaries:check`, `pnpm docs:check`, `pnpm prisma:validate`, and `pnpm openapi:check`.
4. Run unit/contract tests with approved coverage floors.
5. Run the real PostgreSQL/RabbitMQ/HTTP integration suite with Docker and no skipped financial/security tests.
6. Apply all migrations to an empty PostgreSQL 18.4 instance, provision/check `settleflow_app`, compare Prisma/schema drift, and run permission/invariant checks.
7. Validate exact OpenAPI/event schemas/examples, Compose configuration, Dockerfile lint, Prometheus rules, and telemetry redaction contract.
8. Build both OCI targets and scan their effective user, health metadata, file ownership, package inventory, secrets, and high/critical vulnerabilities.

#### Main, scheduled, and release gates

- Repeat the mandatory capture/refund/idempotency/outbox/settlement races three times on `main` and nightly; one intermittent failure blocks release and opens a flake investigation rather than being retried to green.
- Run failure injection for PostgreSQL/RabbitMQ outage, publish-before-mark, commit-before-ack, Webhook HTTP timeout/dead-letter, and worker shutdown/lease recovery.
- Run k6 smoke on `main`; run the extended reference scenarios nightly and before a release candidate.
- Run database backup/isolated restore plus invariant verification on schedule and before release.
- Run secret scan, CodeQL JavaScript/TypeScript SAST, dependency review, `pnpm audit --prod`, license policy, and container scan.
- Generate SPDX or CycloneDX SBOMs for API and worker images and retain them with release evidence.

Approved security policy:

- zero critical findings and zero unreviewed high findings are release-blocking;
- a false positive or non-exploitable high finding needs a checked-in exception containing advisory/tool ID, exact affected package/image, rationale, compensating control, owner, approval, and expiry no later than 30 days;
- expired exceptions fail CI;
- medium/low findings are recorded with owner and target date but do not automatically block unless they affect a financial, tenant, secret, SSRF, migration, or recovery boundary;
- automated dependency updates are weekly, grouped only for compatible development tooling, and still run the full affected gates; and
- dependency/action/image updates never auto-merge.

Approved coverage floors are overall 85% statements/lines and 80% branches/functions; Payments, Ledger, Idempotency, Settlements, Reconciliation, Eventing, and Webhooks each require 90% statements/lines and 85% branches. Coverage never substitutes for PostgreSQL constraints, races, or failure tests.

### 8. Migration and deployment safety

No Prisma model or migration is planned for this milestone. The release pipeline nevertheless treats the current migration history as an artifact:

1. Build immutable API/worker images once.
2. Provision the non-owner runtime role through the controlled owner job.
3. Back up the authoritative database before an upgrade and record its checksum/location without secret data in logs.
4. Run `prisma migrate deploy` as a one-shot owner job. API/worker images never run migrations on startup.
5. Verify migration status, required constraints/triggers/indexes, eight-account chart completeness, and `settleflow_app` grants before making new processes ready.
6. Start one worker and API, run smoke/readiness checks, then enable the full release-simulation topology.
7. For future schema changes, require expand-migrate-contract and explicit API/worker/schema compatibility. A rollback may redeploy compatible code but never reverse or edit an applied financial migration with data; use a reviewed forward fix.

CI applies all migrations to empty PostgreSQL. Because v1.0 has no previous public release, a public prior-version upgrade is recorded `not applicable` for the first tag, but the repository must retain a synthetic pre-release fixture that exercises existing populated Merchant, Payment, Ledger, Webhook, Settlement, and Reconciliation evidence. Starting with v1.0.1, an upgrade from the latest supported release fixture is mandatory.

### 9. OCI images and production-shaped local Compose

Add one multi-stage root `Dockerfile` with shared dependency/build stages and separate `api` and `worker` final targets. Both images:

- use the exact Node 24.18.0 base pinned by digest after verification;
- install with frozen lockfile and include only required production/runtime output;
- run as a fixed non-root UID/GID with no shell-dependent entrypoint;
- contain OCI source/revision/version/created labels, generated SBOM, and no `.env`, Git metadata, tests, source maps containing secrets, caches, or owner credentials;
- use exec-form commands and stop signals compatible with the current graceful shutdown; and
- are tested with read-only root filesystem, writable temporary `tmpfs` only where Node requires it, dropped Linux capabilities, and `no-new-privileges`.

Keep `compose.yaml` as the convenient supporting-service topology. Add a standalone `compose.release.yaml` for the production-shaped **release simulation** with:

- one-shot runtime-role provisioning and migration jobs;
- API and worker image targets with explicit health/startup dependencies;
- PostgreSQL/RabbitMQ on an internal network with no host-published data/broker/management ports;
- API exposed only on loopback;
- internal telemetry listeners reachable only by Prometheus/collector;
- named data volumes and explicit resource/stop-grace bounds;
- optional Prometheus and OpenTelemetry Collector profiles, pinned by digest;
- no Grafana/dashboard service; and
- generated ignored secret/config files mounted read-only, never baked into an image or committed.

This topology must be named `release-simulation`, not `production`. It runs built artifacts and production-shaped isolation but uses the accepted development-only local webhook keyring/policy because the production KMS adapter is deferred. It therefore uses a non-production Node environment and must fail any command that tries to relabel it as production. Production deployment guidance remains conceptual until an approved KMS/secret manager and egress policy exist.

Add `pnpm config:check` to validate API/worker schemas for development/test/release-simulation profiles and `docker compose ... config --quiet` for both Compose files. Placeholder keyring values fail release-simulation startup. No secret value appears in the rendered CI log.

### 10. Deterministic seed and end-to-end demonstration

Do not add a public merchant-onboarding or API-key-management endpoint. Add a local-only fixture provisioner that composes Merchant Access and Ledger application ports with the existing runtime-role/transaction rules. It must:

- refuse `NODE_ENV=production`, a non-loopback/non-demo database target, or a database not marked with an explicit `SETTLEFLOW_DEMO_MODE=true` sentinel;
- create one synthetic merchant and its exact eight-account ETB/USD chart idempotently;
- issue a new high-entropy scoped API key through `MerchantAccessService`, never store plaintext in PostgreSQL, and keep it only in the parent demo process memory;
- create separately provisioned synthetic Payment/capture evidence only through existing Payment/Idempotency/Ledger/Eventing services with bounded command/ID sources while retaining authoritative PostgreSQL transaction time, so every financial invariant and outbox rule remains identical to normal behavior;
- never update/delete/reseed a committed financial row; repeated execution detects the stable fixture and reuses it or refuses with safe guidance; and
- write no credential, webhook secret, raw payload, amount, external reference, or CSV row to committed output.

The recommended `pnpm demo` orchestration uses an isolated Compose project and disposable demo volumes. Destructive reset is a separate explicit `pnpm demo:reset` command scoped to the validated demo project name and requires confirmation/`--yes`; the normal development volumes are never targeted.

Exact demo sequence:

1. Validate prerequisites/config; build images; start isolated PostgreSQL/RabbitMQ, provision role, and apply all migrations.
2. Provision the synthetic merchant/chart and one in-memory API key with exactly `payments:read`, `payments:write`, `webhooks:read`, `webhooks:manage`, `settlements:read`, `settlements:write`, `reconciliation:read`, and `reconciliation:write`.
3. Start API, worker, Prometheus, an OTLP collector, and an in-process synthetic webhook receiver on an explicitly allowlisted development origin.
4. Register a Webhook endpoint and retain its one-time secret only in memory. The receiver verifies exact bytes, timestamp recency, delivery/event IDs, and HMAC; it returns a deterministic retryable failure once and then `204` to prove signed retry/delivery.
5. Create a Payment Intent, replay the create, and execute a bounded concurrent same-key full-capture storm. Verify response equivalence and exactly one Payment transition, Ledger posting, and outbox event through safe read-only assertions.
6. Create a partial refund and prove cumulative projections, balanced immutable Ledger evidence, event publication, Webhook projection, retry, and delivery.
7. Use the separately provisioned historical captured fixture to run one ETB settlement. Verify `settlement_fee_v1`, batch/item uniqueness, adjustment rules, guarded Ledger posting, audit, and outbox evidence. The demo never implies a bank payout.
8. Generate a bounded synthetic reconciliation CSV from the run's safe identifiers, containing deterministic exact and mismatch cases. Import it, let the worker complete it, and verify stable buckets/per-currency totals without logging raw rows or amounts.
9. Stop RabbitMQ briefly, show API/worker readiness and pending outbox behavior, restore it, and verify catch-up/deduplication without row/queue edits.
10. Produce a sanitized pass/fail manifest containing version/commit, elapsed time, test names, counts, terminal states, and links to commands/runbooks. Normalize random IDs/timestamps and omit secrets, amounts, references, payloads, URLs, and raw logs.

The pass condition is deterministic business outcomes, not byte-identical random IDs/secrets. The clean-room target is fresh clone to completed demo in at most 15 minutes; the concise reviewer path should be five minutes after dependencies/images are warm.

### 11. Backup, restore, and incident recovery

PostgreSQL is the only authoritative financial backup target. Add a local/reference backup tool that calls pinned PostgreSQL client tools through the container using argument arrays, creates a custom-format `pg_dump` without owner/ACL, writes to an ignored operator-selected directory, and emits a SHA-256 manifest with schema/release version and timestamp. The backup contains hashed/encrypted credentials and financial evidence, so it is sensitive, access-restricted, encrypted at rest outside the repository, and never attached to public CI artifacts.

Restore is always into a newly created disposable PostgreSQL instance/database, never over the active source. The exercise:

1. verifies checksum and expected release metadata;
2. provisions owner/runtime roles without restoring credential hashes for database roles;
3. restores the logical dump;
4. applies any later migrations through the controlled job;
5. verifies all 11 migration records, named Ledger/Settlement/Audit/Webhook constraints and triggers, runtime grants, eight-account charts, balanced/finalized/immutable Ledger transactions, refund/settlement totals, unique batch membership, outbox/inbox/marker/delivery consistency, and Reconciliation summary consistency;
6. starts API/worker against the restored copy and runs readiness plus non-mutating smoke checks; and
7. records measured backup age, data cutoff, RPO, restore duration/RTO, command versions, and sanitized result.

Reference targets remain RPO <= 15 minutes and RTO <= 60 minutes for PostgreSQL in the documented release-simulation environment. The project may report them only after a scheduled 15-minute backup cadence and an exercised restore achieve them. A manual one-off dump is evidence of restorability, not an RPO claim.

RabbitMQ topology is declarative and recreated. RabbitMQ message data is not authoritative and is not included in the logical PostgreSQL backup. A catastrophic broker-volume loss after an outbox row was marked published but before all consumers committed can lose in-flight asynchronous delivery because no controlled replay tool exists. v1 must disclose this residual simulation limitation; it must not clear `published_at`, move queues manually, or claim full async RPO. Closing that gap requires a separately approved authenticated/audited recovery design and is excluded here.

Add a general incident-response runbook with severity, incident commander, evidence handling, containment, communications, recovery approval, post-incident review, and explicit prohibited direct-edit actions. Complete the existing database-recovery runbook placeholder. Every current runbook receives exact metric/alert names, approved thresholds, owner, exercise date, and evidence link after failure injection.

### 12. Release/versioning and public documentation

Approved release policy:

- use Apache License 2.0 for its explicit patent grant, after confirming contribution provenance and third-party license/notice requirements; include the complete `LICENSE` and every required attribution/notice in source and image distributions;
- use Semantic Versioning, with API major `/v1` independent from the artifact tag;
- create `v1.0.0-rc.1` after all technical gates, but do not publish its API or worker images publicly; use the locally built candidate digests for the clean-room release simulation;
- create `v1.0.0` only after the clean-room simulation passes, every approved waiver is recorded, the security process is enabled and tested, and the repository owner manually approves release;
- tag only a protected `main` commit, build once, and promote exactly the same digest-tested API/worker images that passed the clean-room simulation;
- only after that clean-room pass, publish the tested digests as `ghcr.io/sye-1321/settleflow-api:v1.0.0` and `ghcr.io/sye-1321/settleflow-worker:v1.0.0`; do not substitute or rebuild a digest during publication;
- attach checksums, SBOMs, provenance/attestation where supported and verified, OpenAPI/event schemas, sanitized verification summary, release notes, and known limitations;
- keep all workspace packages private; do not publish npm packages; and
- do not change `GET /v1`'s API-major response to artifact SemVer. Expose release version only in build labels, startup telemetry, and internal metrics.

README becomes a concise entry page with problem/guarantees, architecture and failure model, 15-minute setup, five-minute warm demo, exact commands, evidence links, and prominent limitations. Add Mermaid source diagrams for system context, payment/Ledger atomicity, outbox/inbox flow, Webhook flow, settlement/reconciliation, and deployment. Add a generated/readable ERD/schema inventory without exposing data.

Release documentation includes changelog, v1 release checklist, upgrade/migration guide, support/version policy, observability/alert catalog, configuration reference, backup/recovery, incident response, demo guide, threat model, example HTTP collection, reference performance environment/results, and a requirements/invariants evidence matrix. CI badges link to meaningful workflows only after those workflows exist.

`SECURITY.md` must replace every placeholder before public `v1.0.0`. GitHub Private Vulnerability Reporting is the primary channel and must be enabled and tested, with repository Security-alert email notifications verified. `@Sye-1321` is the Security Owner, Incident Commander, disclosure authority, and release stop/go authority. There is no backup maintainer and no 24x7 support commitment.

The approved response commitments are acknowledgement within three business days, initial triage within seven business days, and support for the latest v1 minor/patch line only. On confirmation of a critical issue, withdraw affected public artifacts when discovered and target a fix/advisory within seven calendar days; target high findings within 30 days, medium findings within 90 days, and low findings in a planned release. Exercise one private-advisory/incident tabletop before `v1.0.0`. These are public simulation-maintenance commitments, not a production service SLA.

## Affected modules and files

No Prisma schema, migration, domain financial service, public business endpoint, or event/webhook/CSV body is changed by this plan. The implementation is expected to touch only the following approved areas.

| Module/file area                                                                                                                                                              | Ownership or planned change                                                                                                    | Boundary impact                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `packages/infrastructure/package.json`, `src/index.ts`, `src/telemetry/*`                                                                                                     | Exact OTel/Prometheus dependencies; context, logger, metrics, trace, redaction, exporter, internal HTTP adapters               | Infrastructure adapter only; no domain import of vendor SDKs                              |
| `apps/api/package.json`, `src/main.ts`, `src/app.module.ts`, `src/api-lifecycle.service.ts`, `src/config/environment.ts`, `src/http/request-id.ts`, new `src/telemetry/*`     | Initialize context/logging/tracing, API request completion, metric mappings, internal telemetry listener, safe shutdown/config | Existing API/business contracts unchanged                                                 |
| `apps/worker/package.json`, `src/main.ts`, `src/worker.module.ts`, `src/config/environment.ts`, `src/health/worker-health.service.ts`, `src/runtime/*`, new `src/telemetry/*` | External worker health/metrics, signal-to-metric/span mapping, correlation context, shutdown/export drain                      | Existing relay/consumer/delivery/settlement/reconciliation semantics unchanged            |
| Existing module observer types/services and focused specs only where needed                                                                                                   | Wire existing bounded observations; add safe outcomes if a required metric has no existing signal                              | No module owns another module's persistence; no financial decision delegated to telemetry |
| `packages/modules/merchant-access/src/*` focused synthetic-provisioning boundary and specs                                                                                    | Internal demo-only merchant/key provisioning through Merchant Access with no public onboarding route                           | Plaintext credentials remain one-time process values; persistence retains only hashes     |
| `packages/modules/webhooks/src/node-webhook-http-client.ts` and focused spec                                                                                                  | Preserve the URL policy's single pinned address under Node 24 hostname lookup behavior                                         | SSRF re-resolution, redirect, timeout, signing, and retry contracts remain unchanged      |
| `apps/api/src/reconciliation/reconciliation.controller.ts` and focused spec                                                                                                   | Accept the documented two-field/one-file multipart request while retaining independent exact field/file/size bounds            | Existing CSV/API contract and Reconciliation service behavior remain unchanged            |
| Root `package.json`, `pnpm-lock.yaml`, `.npmrc`, `.gitignore`, `.env.example`, app `.env.example` files                                                                       | Exact dependencies/scripts, coverage/security/config/demo/recovery commands, safe placeholders, ignored output                 | No real secret; frozen install remains mandatory                                          |
| `Dockerfile`, `.dockerignore`, `compose.release.yaml`, `compose.demo.yaml`, `compose.yaml` only if shared health metadata is needed                                           | API/worker OCI targets, one-shot jobs, isolated release-simulation/demo topologies, health/resources/telemetry profiles        | ADR-0001/0005 deployable model preserved                                                  |
| `ops/prometheus/prometheus.yml`, `ops/prometheus/rules/*.yml`, `ops/prometheus/tests/*.yml`, `ops/otel-collector/config.yml`                                                  | Pinned collector/scrape config and executable alert rules; no dashboard                                                        | Telemetry is non-authoritative and internal                                               |
| `tools/quality/check-module-boundaries.mjs`, `check-markdown-links.mjs`, `check-contracts.mjs`                                                                                | Deterministic local/CI gates using the pinned toolchain                                                                        | Enforces existing rules; no runtime effect                                                |
| `tools/database/verify-invariants.mjs`, `verify-migrations.mjs`; `test/fixtures/migrations/*`                                                                                 | Empty/prior-fixture migration and read-only invariant/grant proof                                                              | Owner/read-only tools; never repair data                                                  |
| `tools/demo/*`, `examples/demo/*`, `examples/webhooks/*`                                                                                                                      | Local-only synthetic provisioner, receiver/verifier, CSV generator, orchestration, sanitized assertions                        | Uses application ports; no public onboarding or real provider                             |
| `tools/operations/backup.mjs`, `restore-exercise.mjs`, `release-check.mjs`                                                                                                    | Safe argument-array backup/isolated restore/release evidence                                                                   | Explicit target validation; no active-database overwrite                                  |
| `perf/k6/*.js`, `perf/README.md`                                                                                                                                              | Specification reference load, retry storm, Webhook fanout, Settlement, and Reconciliation scenarios                            | Synthetic only; no performance claim without environment record                           |
| `.github/workflows/ci.yml`, `security.yml`, `performance.yml`, `release.yml`                                                                                                  | Blocking, scheduled, and manual-approved release gates                                                                         | Least privilege; immutable action refs                                                    |
| `.github/dependabot.yml`, `.github/CODEOWNERS`, `.github/release.yml`, `.github/security-advisory-exceptions.yml`                                                             | Dependency/review/release/security exception policy                                                                            | Exact owners/contact require approval                                                     |
| `test/observability/*`, `test/release/*`, existing API/worker/integration tests                                                                                               | Log/metric/trace/redaction, internal probes, image/Compose, migration/recovery, clean-room demo evidence                       | Additive regression proof only                                                            |
| `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `LICENSE`                                                                                                      | Public release/setup/security/version/license policy                                                                           | No behavior change                                                                        |
| `docs/operations/*`, `docs/release/*`, `docs/demo/*`, `docs/architecture/*`, `docs/review/*`, `docs/runbooks/*`, `docs/api/*`, `docs/events/*`, `examples/*`                  | Final configuration, threat/evidence matrices, diagrams, runbooks, examples, release notes/limitations                         | Contracts are documented, not changed                                                     |

The exact file list must be narrowed during implementation review. A file is not authorization for unrelated cleanup.

## API and integration impact

- Public merchant API routes, problem responses, OpenAPI business schemas, money values, event bodies, Webhook bodies/signatures, AMQP routing/metadata, and CSV contracts remain unchanged.
- Existing API health routes remain. Add internal-only metrics exposure; add worker internal health/metrics exposure. These internal endpoints are documented but excluded from merchant OpenAPI.
- Continue returning canonical `X-Request-Id`. Add trace IDs only to internal telemetry, not public response bodies.
- Do not add trace fields to strict events or Webhooks. Existing event/request/delivery IDs provide P0 cross-component correlation.
- Release OCI/image/Compose interfaces and configuration names become compatibility surfaces and require documentation/change control.

## Database and migration impact

- No Prisma model, SQL migration, financial table/column, telemetry table, seed table, or retention job is proposed.
- Demo data is ordinary synthetic domain data written through current ports and constraints into a separately identified demo database.
- Backup/restore and invariant verification are read/restore tooling, not schema mutation or repair authority.
- CI must prove all existing migrations from empty, existing populated fixture compatibility, constraint/trigger presence, grants, and zero schema drift.
- Future migration release policy is expand-migrate-contract with one-shot owner deployment and forward fix after immutable evidence exists.

## Transaction boundaries and concurrency

- No existing transaction, lock order, isolation level, lease, retry bound, idempotency key, outbox/inbox ordering, or settlement claim changes.
- Telemetry records only after/beside observed operations and cannot participate in commit decisions. A `ledger.post` staged observation must not be counted as committed success until the coordinator reports commit/replay.
- Background backlog collectors run bounded read-only indexed queries with timeouts and never share a financial transaction.
- The demo provisioner uses existing application transaction boundaries. It does not direct-write financial tables or retry a partial Ledger/Payment sequence.
- Recovery tooling never updates the source database and restores only to a validated fresh target.

## Security and privacy

- Internal metrics/health use network isolation and are never exposed through public ingress by default.
- Telemetry uses field/label allowlists plus recursive redaction tests; a secret-like field name or prohibited value fails tests.
- CI logs, caches, artifacts, SBOMs, demo summaries, backups, and release attestations are reviewed separately for sensitive content.
- GitHub workflows use minimal permissions, immutable action refs, protected release environment approval, and no untrusted-code access to secrets.
- Images run non-root, contain no owner/database/broker/KMS credentials, and are scanned before publication.
- Demo keys/secrets are generated at runtime, held in memory, and never committed or printed. Only synthetic data is permitted.
- Backups are sensitive even in the simulation because they contain hashes, ciphertext, and financial evidence; store encrypted outside the repository with least access.
- Production remains unauthorized without KMS/secret manager, egress controls, independent review, and real operational ownership.

Required reviews: architecture/operations for telemetry/deployment; security for logging, metrics exposure, CI, images, secrets, demo, backup, and incident policy; database for migration/recovery/invariant scripts; financial/domain for demo assertions and release waiver evidence.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario            | Expected safe state                                                        | Retry/recovery                                                               | Evidence                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| Logger/metric/trace exporter unavailable | Business operation continues; bounded signal may be dropped                | Backoff/rate-limit exporter; alert on telemetry degradation                  | Unit/failure test proving unchanged command result/commit |
| Metrics scrape collector query times out | No command impact; last collector success becomes stale                    | Record collector failure; next scheduled scrape retries                      | Timeout test and stale signal                             |
| API/worker config invalid                | Process never becomes ready or starts work                                 | Correct ignored secret/config; restart through release procedure             | Config matrix tests                                       |
| PostgreSQL unavailable                   | Existing API/worker readiness fails and finance work rejects/pauses safely | Restore DB; verify migrations/invariants/backlogs                            | Health and outage integration tests                       |
| RabbitMQ unavailable                     | Outbox remains authoritative; worker unready; no row/queue edit            | Restore broker; lease/retry catches up                                       | Existing plus release failure test                        |
| CI runner/tool outage                    | Gate is not green; release stops                                           | Rerun only after service recovery; do not waive financial/security failure   | Required-check state and incident note                    |
| High/critical advisory                   | Release blocked                                                            | Upgrade/mitigate or approve bounded expiring exception                       | Scan report and exception validation                      |
| Migration job fails                      | API/worker requiring schema stay unready/unstarted                         | Restore pre-migration backup if no irreversible write, otherwise forward fix | Empty/fixture migration test and release runbook          |
| Demo runs twice                          | No duplicate financial effect or destructive reset                         | Detect existing fixture/replay idempotently or refuse                        | Demo rerun assertion                                      |
| Demo receiver fails once                 | Delivery remains retrying then delivered under existing policy             | Automatic persisted retry only                                               | Signature/attempt evidence                                |
| Backup interrupted/corrupt               | Source DB unchanged; backup unusable                                       | Discard failed artifact; take new backup                                     | checksum/restore-negative test                            |
| Restore validation fails                 | Isolated target remains quarantined; source unchanged                      | Preserve evidence and forward-fix tooling/data issue                         | invariant report and database-recovery runbook            |
| RabbitMQ volume lost                     | PostgreSQL finance state survives; possible async gap remains              | Recreate topology; escalate; no ad hoc republish                             | documented v1 limitation/incident evidence                |
| Shutdown during telemetry flush          | New work already stopped; business drains retain current bounds            | Bounded flush then drop telemetry; leases recover                            | shutdown ordering test                                    |

## Observability and operations

The telemetry, alert, health, correlation, runbook, and recovery designs above are the operational product of this milestone. Operators must be able to move from any alert to a safe runbook using request/event/delivery/public resource identifiers without selecting protected payload columns.

Telemetry retention follows ADR-0013: default seven days locally and configurable 7-30 days in a reference environment. Prometheus cardinality and storage budgets must be measured under the reference workload. No identifier is a metric label. Logs/traces/metrics are disposable operational evidence and never authorize a financial mutation.

## Test strategy

- **Unit:** context propagation/cleanup; redaction; JSON logger; trace/metric observer mappings; label allowlist; histogram buckets; alert-series fixtures; config; demo normalizer; backup target validation.
- **Database constraints/migrations:** full history on empty PostgreSQL; populated pre-release fixture; schema drift; named constraint/trigger/grant inventory; eight-account chart; read-only invariant verifier; isolated dump/restore.
- **Integration with real dependencies:** API/worker internal probes; Prometheus scrape; OTLP exporter available/unavailable; PostgreSQL/RabbitMQ outages; graceful shutdown; existing domain/race suites; release Compose startup.
- **Contract:** OpenAPI/event/Webhook/CSV unchanged; structured-log JSON schema; metric-name/label catalog; internal health schemas; OCI labels/SBOM; demo evidence schema.
- **Concurrency/race:** current mandatory financial races repeated; two relay/consumer/dispatcher/settlement workers; telemetry concurrency/cardinality; no AsyncLocalStorage context leak between requests/messages.
- **Failure injection/recovery:** telemetry outage; publish-before-mark; consume-before-ack; broker outage; Webhook 500/timeout; expired leases; migration failure; backup corruption; isolated restore; process kill during drain.
- **Security:** tenant isolation; secrets/log scan; metric/trace redaction; internal listener exposure; URL/SSRF/signature regressions; CSV bounds; action/image/dependency/secret/SAST/container scans; non-root/read-only image.
- **Performance:** k6 scenarios from specification Table 37. Record CPU/RAM, OS/container runtime, image digests, database/broker versions, dataset, warm-up, duration, and limitations. Threshold failures block release; no target is weakened to green CI.
- **Documentation/link checks:** all local Markdown paths/anchors; OpenAPI/event JSON parse; Mermaid source validation where tooling exists; command snippets exercised in a clean clone.

### Planned repository commands

Existing commands remain and new commands should make each gate reproducible locally:

```shell
corepack pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm boundaries:check
pnpm docs:check
pnpm prisma:validate
pnpm prisma:generate
pnpm db:migrate:verify
pnpm db:permissions:check
pnpm db:invariants:check
pnpm test
pnpm test:coverage
pnpm test:integration
pnpm test:concurrency
pnpm test:failure
pnpm test:observability
pnpm test:recovery
pnpm openapi:check
pnpm contracts:check
pnpm perf:smoke
pnpm perf:reference
pnpm config:check
pnpm images:build
pnpm images:scan
pnpm release:check
pnpm demo
```

Commands not currently defined are **To be implemented and must not be reported as passed before they exist**. CI uses the same scripts rather than hidden workflow-only commands.

## Documentation impact

Planned documentation changes:

- restructure `README.md` around guarantees, architecture, setup, demo, evidence, and limitations;
- finalize `SECURITY.md`, license, CODEOWNERS, changelog, contribution/review expectations, supported versions, and release checklist;
- add observability/metrics/alerts/configuration and deployment/release guides;
- add system, transaction, reliable-flow, state, deployment, and ERD diagrams;
- add database recovery and incident response runbooks and update every current runbook with exact signals/thresholds/exercise evidence;
- add deterministic demo, webhook verifier, HTTP examples, reconciliation fixture generation, performance environment/results, SBOM/provenance references, and clean-room evidence;
- add a P0/P1/P2 and INV-01-INV-10 release matrix with pass/waived/deferred state; and
- explicitly document no real rails, no payout, no production KMS, no production certification, no manual replay, no Ledger read API, no dashboards/admin UI, and broker-disaster residual risk.

## Rollback or forward-recovery strategy

- Telemetry/config/docs/CI can be disabled or reverted if they have written no business state, but release gates cannot be bypassed by removing them.
- An image rollback redeploys a previously verified schema-compatible digest. API and worker versions must remain compatible with the current shared schema.
- Migrations run separately and are never automatically rolled back after financial/audit evidence exists. Restore to an isolated environment for diagnosis; production/reference recovery uses a reviewed forward fix.
- Demo reset affects only a validated isolated demo Compose project and is explicitly destructive/recoverable only by rerunning the demo.
- If logging/telemetry leaks a secret, stop export, restrict/delete non-authoritative telemetry under the retention provider's incident procedure, rotate the secret, inspect artifacts/history, and preserve authoritative financial/audit evidence.
- If a released image/security artifact is defective, mark it affected, stop promotion, publish a fixed patch/digest and corrected attestation; do not retag an existing immutable version.

## Approved gates and owner decisions

The repository owner approved Gates 1-10 on 2026-08-09. The approval is limited to the exact decisions below; an implementation discovery that crosses these boundaries returns to design review.

1. **Telemetry stack and boundary — Approved:** use official OpenTelemetry JS plus `prom-client`, an Infrastructure-owned adapter, internal HTTP health/metrics listeners for both deployables, Prometheus plus an OTLP Collector in an optional Compose profile, and no Grafana/dashboard or trace-storage backend in v1.
2. **Telemetry contract — Approved:** use JSON stdout logs, AsyncLocalStorage request/message context, the metric/span catalog and prohibited-data rules, 10% successful trace sampling plus 100% errors/demo, no event/schema trace fields, and network-isolated metrics with no bearer secret.
3. **Alert thresholds — Approved:** use the exact threshold/severity table in section 6 as reference defaults, with the repository owner as the sole incident and acknowledgement owner and no staffed 24x7 claim.
4. **CI/security policy — Approved:** use GitHub Actions with SHA-pinned actions, required PR/main/scheduled gates, the exact coverage floors, repeated race policy, zero critical/unreviewed high findings, and reviewed security exceptions expiring within 30 days.
5. **Release and license — Approved with publication sequencing:** license SettleFlow under Apache-2.0, use SemVer, keep workspace packages private, create `v1.0.0-rc.1` without public GHCR images, and publish only the tested `v1.0.0` API/worker digests after the clean-room release simulation passes. Publication uses the exact names and evidence contract in section 12, including SBOM/provenance.
6. **Migration/deployment — Approved:** use one-shot role provisioning then migration before API/worker readiness, prove the complete migration history on empty and populated pre-release databases for v1, and use forward-fix-only financial migration recovery.
7. **Release-simulation Compose — Approved:** add separate `compose.release.yaml`, built non-root images, internal PostgreSQL/RabbitMQ/telemetry networks, a loopback-only API, an optional Prometheus/OTLP profile, and an explicit non-production local-keyring limitation. The topology is named only `release-simulation`.
8. **Demo provisioning — Approved:** use a local-only internal synthetic merchant/chart/key provisioner, create fixed historical data exclusively through current application ports, keep one-time secrets in memory, use isolated disposable demo volumes, and implement the exact ten-step demo flow.
9. **Recovery, security, and incident ownership — Approved:** exercise PostgreSQL logical backups every 15 minutes and claim RPO <= 15 minutes/RTO <= 60 minutes only after measured proof; restore only into isolation; make no RabbitMQ message-backup or full asynchronous-RPO claim; enable and test GitHub Private Vulnerability Reporting; and apply the ownership and response commitments in sections 6, 11, and 12. `@Sye-1321` holds the Security Owner, Incident Commander, disclosure authority, and release stop/go roles. There is no backup maintainer or 24x7 support commitment.
10. **v1 scope treatment — Approved:** publish only as a **finance-grade simulation**, with the following classifications:
    - **P0/specification waivers:** no controlled/manual Webhook replay API or corresponding privileged replay audit path; no merchant Webhook-delivery inspection API; no public Ledger transaction read API; and no destructive retention jobs implementing the Table 23 disposal windows.
    - **P1 deferrals:** no FR-15 authorize-then-capture flow, FR-16 dashboards/operator search views or Grafana default, distributed trace continuity through the outbox, or production KMS/keyring adapter.
    - **Operational limitations:** catastrophic RabbitMQ volume loss may lose published-but-unconsumed asynchronous work because no controlled recovery replay exists; there is no staffed 24x7 response, SLA, or production-support commitment; OCI/Compose is a release simulation rather than a production deployment; and prior-public-version upgrade proof is not applicable to initial v1 but becomes mandatory from `v1.0.1`.

Every waiver, deferral, and limitation must appear in the requirements/evidence matrix and release notes with its rationale, risk, owner, follow-up issue/milestone, and review before the next minor release. The project must not claim every endpoint in specification Table 25, all of FR-10, production readiness, or complete v1.0 specification conformance.

No new ADR is recommended if these choices are approved exactly as implementation/refinement of the specification and accepted ADRs. A decision to expose telemetry publicly, change deployment topology beyond API/worker, add a production KMS/provider, alter event/financial behavior, or claim a different recovery model requires an ADR.

## Risks and assumptions

| Risk or assumption                                                 | Impact                                     | Mitigation/validation                                                                              | Owner/deadline                                         |
| ------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Telemetry changes command timing or throws                         | Financial correctness/latency              | Non-interference adapter, failure injection, reference load, no telemetry in transaction decisions | Operations/financial reviewers before merge            |
| Metric cardinality leaks IDs or exhausts memory                    | Security/availability                      | Closed label schema, registry tests, scrape/storage budget, no IDs                                 | Security/Operations before merge                       |
| Raw Nest/bootstrap errors leak URLs/secrets                        | Credential exposure                        | One JSON logger and allowlisted startup codes; redaction/secret scan                               | Security before release candidate                      |
| Worker admin listener is publicly reachable                        | Internal state exposure                    | Separate internal network/loopback, Compose exposure test, docs                                    | Security/Platform before release candidate             |
| CI is expensive/flaky                                              | Contributors bypass or distrust gates      | Split PR/main/nightly, cache safely, fail on flake, publish diagnostics without secrets            | Maintainers before required checks                     |
| Scanner false positives block release                              | Delayed release                            | Exact 30-day reviewed exception format; never auto-waive critical                                  | Security owner before release                          |
| Image/Compose drift from host workflow                             | Demo/runtime inconsistency                 | Same scripts/artifacts, pinned digests, clean-room comparison                                      | Platform owner before release                          |
| Demo seed bypasses module boundaries                               | Invalid finance evidence                   | Internal ports only, DB sentinel, no direct financial writes, invariant tests                      | Financial/architecture reviewers before implementation |
| Demo retry delay can take up to one minute                         | Warm demo duration variability             | Document bound and poll evidence; do not change ADR retry policy                                   | Demo owner before clean-room review                    |
| Backup exposes hashes/ciphertext                                   | Security incident                          | Encrypted restricted external path, no CI artifact, negative path tests                            | Security/DB owner before exercise                      |
| PostgreSQL logical backup does not cover broker in-flight messages | Incomplete async disaster recovery         | Explicit waiver/residual risk; topology recreation; no false full-RPO claim                        | Project owner before final tag                         |
| No previous public release fixture exists                          | Cannot prove public upgrade for v1.0       | Mark initial release N/A; keep populated pre-release fixture; mandatory from v1.0.1                | DB/release owner before tag                            |
| Production KMS is absent                                           | Images cannot honestly be production-ready | Label release-simulation; local provider remains production-fatal                                  | Project owner in release notes                         |
| P0 catalog features remain excluded                                | Spec-completeness claim would be false     | Approval Gate 10 waiver and traceability matrix; pre-release if not approved                       | Project owner before `v1.0.0`                          |
| Security contact/incident owners are unknown                       | Unsafe public disclosure/response          | Gate 9 blocks final release                                                                        | Project owner before release candidate                 |
| Apache-2.0 or GHCR publication is not approved                     | Legal/distribution blocker                 | Gate 5; remain prerelease/unpublished until resolved                                               | Project owner before release candidate                 |

## Implementation order

1. Approve or adjust Gates 1-10; create an ADR only if an approved answer crosses the boundaries listed above.
2. Add deterministic local quality commands: documentation links, contracts, module boundaries, migration/invariant/grant checks, config validation, and coverage.
3. Implement the Infrastructure telemetry adapter and API/worker composition with redaction, internal probes, tests, and no business changes.
4. Add Prometheus/OTLP configs, executable alert rules, metrics/runbook catalog, and observability failure tests.
5. Add OCI targets and release-simulation Compose; prove non-root/read-only/config/readiness/shutdown behavior.
6. Add CI/security/dependency/container/reliability workflows and make repository scripts their single source of commands. Performance remains blocked on the approved reference workload and demo prerequisites in Steps 7 and 9; a missing performance command must remain visible rather than becoming a placeholder pass.
7. Add the local-only demo provisioner, receiver/verifier, fixtures, orchestration, and sanitized evidence assertions.
8. Add backup/isolated restore/invariant tooling; exercise and document measured RPO/RTO and broker residual risk.
9. Complete public architecture, threat, operations, runbook, example, performance, release, support, license, and security documentation.
10. Run full gates in a clean clone, produce `v1.0.0-rc.1`, perform a second-person/clean-room review, resolve or accept every waiver, then manually approve the immutable `v1.0.0` artifacts.

On 2026-08-10 the repository owner explicitly assigned the next implementation slice as **Step 7 release-gate remediation**: clear the unchanged coverage floors and zero-critical/unreviewed-high runtime-image policy before beginning the originally numbered demo work. This was a sequencing clarification, not authorization for recovery, publishing, or final-release work in the original Steps 8-10; those remain deferred. On 2026-08-15 the owner separately authorized the originally numbered Step 7 deterministic demo slice after the remediation commit `b1dbab8`.

## Verification commands

Documentation-only planning verification for this milestone:

```shell
corepack pnpm exec prettier --check docs/plans/2026-08-03-operational-readiness-and-v1-release.md
# repository-local relative Markdown-link validation for the new plan
git diff --check
git status --short --branch
```

Implementation verification is the command set in Test Strategy plus:

```shell
docker compose config --quiet
docker compose -f compose.release.yaml config --quiet
docker compose -f compose.release.yaml up --detach --wait
docker compose -f compose.release.yaml ps
pnpm db:migrate:status
pnpm openapi:check
git diff --check
git status --short --branch
```

Every final verification record must state exact tool/image/action versions and digests, environment resources, suite/test counts, elapsed demo/setup/restore/performance times, skipped checks, waivers, and evidence locations. No command is considered passing solely because a workflow file exists.

## Execution checklist

- [x] Approval Gates 1-10 resolved and owners recorded on 2026-08-09.
- [x] Step 2 deterministic documentation, contract, module-boundary, configuration, database, and coverage commands implemented with focused tests.
- [x] Step 3 Infrastructure telemetry boundary, redaction, correlation, internal probes, metrics/tracing adapters, lifecycle behavior, and degradation runbook implemented with focused tests.
- [x] Step 4 Prometheus/Collector configuration, executable alerts, bounded background collectors, and alert-rule tests implemented.
- [x] Step 5 pinned OCI targets, secret-safe generated configuration, one-shot migration sequencing, and release-simulation Compose implemented and verified from a cleaned build context and empty synthetic volumes.
- [x] Required dependency and license supply-chain review completed; exact runtime and tooling dependencies are pinned, with no active security exception.
- [x] Step 6 CI, migration, security, dependency, container, contract, concurrency, and failure-injection gates implemented as repository commands and SHA-pinned workflows.
- [x] Step 7 approved coverage gates pass after behavior-focused unit and real-dependency integration coverage; thresholds and source inclusion remain unchanged.
- [x] Step 7 runtime image vulnerability gates pass with the pinned distroless runtime and zero critical/high findings; no exception or suppression was created.
- [ ] Performance and recurring-RPO gates remain deferred to their approved prerequisites; they are not represented as passing CI checks.
- [ ] OCI images and release-simulation Compose verified from a clean clone.
- [x] Demo seed/orchestration is deterministic, synthetic, secret-safe, and invariant-safe.
- [x] Step 8 sensitive logical-backup, fresh isolated restore, grant reconstruction, migration/invariant verification, API/worker smoke, cleanup, and incident/database-recovery runbooks implemented and exercised.
- [x] Public README/evidence navigation, Apache-2.0 licensing, and the pre-release security policy are published without representing the remaining Steps 8-10 as complete.
- [ ] Before `v1.0.0`, confirm contribution/source provenance and that no proprietary or confidential source is being relicensed; review third-party dependency/material obligations and preserve every required Apache or third-party NOTICE/attribution.
- [ ] Backup/isolated restore meets measured reference targets or release remains pre-release.
- [x] The one-off isolated restore meets the 60-minute reference RTO; the 15-minute RPO remains explicitly unclaimed until scheduled-cadence evidence exists.
- [ ] License, security contact, CODEOWNERS, version policy, release notes, limitations, and evidence matrix complete.
- [ ] All P0 requirements/invariants are passed or explicitly owner-waived; no financial/security blocker remains.
- [x] Step 7 commands, results, owner-directed sequencing deviation, and remaining release deferrals recorded below.

## Verification record

| Command or review                   | Result  | Date/evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean baseline                      | Pass    | 2026-08-03: clean `## main...origin/main` at `85085a4` before this plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Specification/repository inspection | Pass    | Complete specification including tables; governance, architecture, ADRs/plans, schema/migrations, runtime/config, tests, runbooks, Compose, CI absence, examples, and current docs inspected                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Owner approval                      | Pass    | 2026-08-09: repository owner approved Gates 1-10, including revised GHCR sequencing, sole security/incident ownership, response commitments, and classified release scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Steps 2-3 baseline                  | Pass    | 2026-08-09: clean `## main...origin/main` at remote commit `c43a847` before implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Step 4 baseline                     | Pass    | 2026-08-09: clean `## main...origin/main` at remote commit `e3e20f6` before implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Step 5 baseline                     | Pass    | 2026-08-10: clean `## main...origin/main` at remote commit `a2f895b` before implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Step 6 baseline                     | Pass    | 2026-08-10: clean `## main...origin/main` at remote commit `d6141a8` before implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Step 7 remediation baseline         | Pass    | 2026-08-10: clean `## main...origin/main` at `664133f` before the owner-directed coverage and runtime-image remediation slice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Step 6 workflow policy              | Pass    | 2026-08-10: three GitHub Actions workflows parsed as YAML and passed least-permission, safe-trigger, immutable-action-SHA, checkout-credential, timeout, concurrency, and failure-suppression policy tests; no repository secret or variable is required                                                                                                                                                                                                                                                                                                                                                                                       |
| Step 6 dependency/security policy   | Pass    | 2026-08-10: frozen install; exact dependency policy; `pnpm audit --prod` with zero high/critical findings; bounded license review; zero active exceptions; Gitleaks 8.30.1 over 36 commits plus the complete tracked/untracked change set; Hadolint 2.15.1 at warning severity; and 18 focused CI/security tool tests passed                                                                                                                                                                                                                                                                                                                   |
| Step 6 migration validation         | Pass    | 2026-08-10: isolated PostgreSQL/RabbitMQ infrastructure accepted all 11 migrations, runtime-role grants, migration history, deferred financial invariants, and Prisma schema-drift comparison without using retained application data                                                                                                                                                                                                                                                                                                                                                                                                          |
| Step 6 full regression              | Pass    | 2026-08-10: 53 unit suites/226 tests and 10 real PostgreSQL/RabbitMQ/HTTP integration suites/63 tests passed; format, lint, type-check, build, boundaries, configuration, OpenAPI, API/event contracts, telemetry rules, and documentation links passed                                                                                                                                                                                                                                                                                                                                                                                        |
| Step 6 scheduled reliability        | Pass    | 2026-08-10: corrected the CI wrapper's literal argument separator without changing a test or timeout; three independent no-retry concurrency repetitions each passed 3 suites/28 tests, and the one no-retry failure-injection run passed 4 suites/23 tests. An earlier pre-correction local attempt failed closed when scanner-loaded Docker Desktop exceeded Testcontainers' internal 10-second host-port inspection bound; no assertion failed, and the failure was not hidden or retried inside the gate                                                                                                                                   |
| Step 6 OCI build/evidence           | Pass    | 2026-08-10: cleaned 34.47 KB context built non-root API `sha256:0b26198fb6843cbac926619b33168a936ecd36b8ba70ecc570afc30ce4da1e14`, worker `sha256:e6cf8ebab224e36afcc6b9bbefcbc868f5764de8049cf7cc9b172e29c696f922`, and migrator `sha256:a34b49c66c2d315bc12ec189a03f0c5bb878538409cf008da6da29d57153a017`; local SPDX JSON SBOMs and a bounded release-evidence manifest bind them to `d6141a8`                                                                                                                                                                                                                                              |
| Step 6 image vulnerability policy   | Blocked | 2026-08-10: Trivy 0.73.0 found 5 critical and 17 high Debian findings in each pinned Debian 12.15 runtime image; application Node packages and filesystem secrets had zero findings. Installed packages equal the current pinned-base candidates; no exception, suppression, severity downgrade, or base-image change was made                                                                                                                                                                                                                                                                                                                 |
| Step 6 GitHub execution             | Pending | Workflow YAML and repository policy pass locally, but Dependency Review service availability, CodeQL upload, hosted-runner behavior, artifact retention, OIDC evidence attestation, required-check selection, and branch protection require the first GitHub run/owner configuration; no push or repository setting change occurred                                                                                                                                                                                                                                                                                                            |
| Step 7 coverage remediation         | Pass    | 2026-08-10: all coverage shards passed before merge; global statements/branches/functions/lines are 91.46/84.71/91.80/92.13% against 85/80/80/85. Critical modules against 90/85/85/90 are Eventing 90.05/87.76/90.45/90.68, Idempotency 97.14/94.55/100/96.97, Ledger 94.72/90.70/100/95.38, Payments 92.42/88.71/92.19/93.47, Reconciliation 95.71/87.73/100/96.28, Settlements 94.31/89.73/94.44/95.45, and Webhooks 91.67/85.22/96.12/92.47; thresholds and source inclusion are unchanged                                                                                                                                                 |
| Step 7 final runtime images         | Pass    | 2026-08-10: the build toolchain uses pinned Node.js 24.18.0 Trixie-slim and exact OpenSSL packages; final stages use pinned distroless Node.js 24 Debian 13 as non-root UID/GID `10001:10001` with no shell/package manager. API `sha256:ca82d28a900a34c3fff95d26ae50b2fc5dd4bc0e2cf3bea2ca1385b9c532e9bd`, worker `sha256:587af315a0136ed670a0e8bb7261bdfae5c55232e8153744b11d674dc84cdd19`, and migrator `sha256:9f4da761be690045ffc417435f838e84dddf039fde9f61032f8165a2023ef96f` pass identity, contents, read-only runtime, and release-Compose inspection                                                                                |
| Step 7 image vulnerability policy   | Pass    | 2026-08-10: Trivy 0.73.0 reports zero critical/high package findings and zero filesystem-secret findings in each final API, worker, and migrator image; no threshold, suppression, allowlist, or exception changed                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Step 7 release-simulation smoke     | Pass    | 2026-08-10: role provisioning and the single migrator exited successfully before API/worker startup; PostgreSQL, RabbitMQ, API, and worker became healthy; API liveness/readiness returned 200; dependency/diagnostic ports remained internal; and the project stopped cleanly while retaining only its named synthetic volumes                                                                                                                                                                                                                                                                                                                |
| Step 7 source and repository gates  | Pass    | 2026-08-10: frozen install, format, lint, type-check, production build, Prisma validation/generation, boundaries, strict API/event contracts, OpenAPI, compiled configuration, 20 quality-tool tests, 72 unit suites/481 tests, 10 real-dependency integration suites/63 tests, Collector/Prometheus config plus 22 alert rules, documentation links, and `git diff --check` passed                                                                                                                                                                                                                                                            |
| Step 7 database gates               | Pass    | 2026-08-10: the checked synthetic local PostgreSQL target accepted runtime-role provisioning; all 11 migrations were current; exact migration history, least-privilege permissions, deferred financial invariants, and Prisma schema drift checks passed                                                                                                                                                                                                                                                                                                                                                                                       |
| Step 7 security and evidence        | Pass    | 2026-08-10: repository/action pinning, zero active exceptions, zero critical/unreviewed-high dependencies, reviewed production licenses, 37-commit plus dirty-tree secret scanning, Dockerfile lint, image inspection, three zero-high/critical Trivy scans, SPDX SBOMs, and the bounded source/image evidence manifest passed. Ignored release configuration was regenerated to bind OCI revision metadata to `664133f`; the prior ignored config remains recoverably preserved locally and no artifact was published                                                                                                                         |
| Original Step 7 demo baseline       | Pass    | 2026-08-15: clean `## main...origin/main` at committed and pushed remediation baseline `b1dbab8` before the deterministic demo implementation; no schema, migration, dependency, public contract, retry policy, coverage threshold, or security exception changed                                                                                                                                                                                                                                                                                                                                                                              |
| Demo safety and focused tests       | Pass    | 2026-08-15: seven focused Node tests proved production/missing-sentinel/unsafe-target refusal, isolated project and exact-volume protection, bounded secret-free evidence, repeat no-op behavior, exact-byte/HMAC validation, and deterministic one-failure-then-success Webhook reception; focused Webhook hostname pinning and reconciliation multipart regressions also passed                                                                                                                                                                                                                                                              |
| Deterministic ten-step demo         | Pass    | 2026-08-15: `pnpm demo` completed from explicitly reset isolated volumes in 323,869 ms; all 11 migrations, one merchant, the exact eight-account ETB/USD chart, eight scopes, Payment create replay, a 12-request same-key capture storm, one capture Ledger/outbox effect, one partial refund Ledger/outbox effect, signed Webhook retry/delivery, one ETB settlement/audit/outbox effect, five exact reconciliation cases plus one provider-only mismatch, and sanitized terminal evidence passed                                                                                                                                            |
| Demo outage and recovery            | Pass    | 2026-08-15: stopping RabbitMQ made API and worker readiness return non-ready while a new Payment Intent committed with an unpublished outbox row; broker restart restored readiness, publisher confirms advanced the row, the subscribed Webhook arrived, and the inbox contained exactly one deduplication record without SQL, row, or queue repair                                                                                                                                                                                                                                                                                           |
| Demo evidence and repeat behavior   | Pass    | 2026-08-15: ignored `.settleflow/demo/evidence.json` passed the closed schema/redaction validator and contains only source state, elapsed time, named checks, bounded counts, terminal states, and command/runbook paths; a second `pnpm demo` preserved its SHA-256 exactly, started no containers, and instructed the reviewer to use the separately guarded reset command                                                                                                                                                                                                                                                                   |
| Demo final repository gates         | Pass    | 2026-08-15: Node.js 24.18.0 and pnpm 11.18.0 passed the frozen install, format, lint, type-check, production build, Prisma validation/generation, all 11 migrations, exact migration history, runtime grants, financial invariants, zero schema drift, boundaries, strict API/event contracts, OpenAPI, configuration, 27 quality-tool tests, 72 unit suites/484 tests, 10 real-dependency integration suites/63 tests, Collector/Prometheus configuration plus 22 alert rules, documentation links, and `git diff --check` without changing a threshold or exception.                                                                         |
| Demo concurrency/failure gates      | Pass    | 2026-08-15: the three-run concurrency gate passed 3 suites/28 tests in each run (84 executions total); the failure-injection gate passed 4 suites/23 tests. An initial failure run observed one delayed RabbitMQ management-stat acknowledgement under sustained local load; the unchanged projection suite passed 4/4 alone and the unchanged official failure gate then passed 23/23, so no timeout, retry, consumer, or financial behavior was changed.                                                                                                                                                                                     |
| Demo final OCI/security evidence    | Pass    | 2026-08-15: freshly rebuilt non-root images passed identity, metadata, dependency, artifact, read-only runtime, and release-Compose inspection: API `sha256:0bda991f43a078238070fa698376bffa9f6cc4892de40fed9958906c94df1936`, worker `sha256:9fffba68dca8632f6ef6aec401c5b76c042e7c2b2c017e3890aee0a77754609d`, migrator `sha256:7af4f07253002a8241193608493b2b01b4256902c6b33742378c4fb24c00847a`. Pinned Trivy 0.73.0 reported zero high/critical findings for every image, pinned Syft 1.50.0 emitted SPDX JSON SBOMs, and nothing was published.                                                                                          |
| Step 9 docs foundation              | Pass    | 2026-08-15: README, evidence guide, architecture baseline, Apache-2.0 license, and approved pre-release security commitments updated. Frozen install, formatting, Markdown links, contracts, 29 quality-tool tests, security policy, and `git diff --check` passed. Private Vulnerability Reporting enablement/testing and Steps 8-10 were still open at that milestone.                                                                                                                                                                                                                                                                       |
| Step 8 recovery-tool safety         | Pass    | 2026-08-19: seven focused Node tests proved closed backup metadata, explicit sensitive-storage acknowledgement, ignored in-repository output, size/SHA-256 corruption rejection, isolated credential boundaries, no owner credential in API/worker configuration, exact recovery topology/startup sequencing, and read-only database checks. The source dump and all generated credentials/evidence remain under ignored `.settleflow/`; no backup was attached to CI or a public artifact.                                                                                                                                                    |
| Step 8 logical backup               | Pass    | 2026-08-19: the digest-pinned PostgreSQL 18.4 container produced a 209,797-byte custom-format `--no-owner --no-acl` logical dump of the existing synthetic demo state with a closed SHA-256 manifest, all 11 migration records, source release metadata, data cutoff, and client/server tool versions. The source project was not mutated by recovery tooling.                                                                                                                                                                                                                                                                                 |
| Step 8 isolated restore and RTO     | Pass    | 2026-08-19: an older synthetic demo backup was restored through a fresh randomly named Compose project using new owner/runtime credentials, single-transaction `pg_restore`, exact post-restore least-privilege grants, current migration verification, named constraints/indexes/deferred triggers, chart/Ledger/Payment/refund/Settlement/Reconciliation/asynchronous-evidence checks, API and worker readiness, and a second post-start check. The final measured restore was 78 seconds against the 3,600-second reference target; all disposable recovery containers, networks, volumes, and ephemeral recovery credentials were removed. |
| Step 8 PostgreSQL RPO claim         | Blocked | 2026-08-19: the final successful one-off exercise measured a 2,840-second simulated data-cutoff interval because the selected backup was 2,839 seconds old. Evidence correctly records `NOT_CLAIMED_ONE_OFF_EXERCISE`; no 900-second RPO is claimed until an approved scheduler demonstrates successful backups no more than 15 minutes apart and a restore from that cadence passes.                                                                                                                                                                                                                                                          |
| Step 8 RabbitMQ recovery boundary   | Pass    | 2026-08-19: the isolated worker recreated declarative topology on a fresh broker, while tooling made no attempt to back up messages, clear `published_at`, move queues, or replay events. Evidence records `TOPOLOGY_ONLY_NO_MESSAGE_BACKUP`; catastrophic published-but-unconsumed loss remains an explicit simulation limitation requiring a separately approved replay design.                                                                                                                                                                                                                                                              |
| Step 5 reproducible OCI builds      | Pass    | 2026-08-10: Node.js 24.18.0 Bookworm-slim digest, pnpm 11.18.0, exact OpenSSL packages, frozen lockfile, reduced 34.47 KB clean source context, non-root production deployments, SBOMs, and maximal provenance; final indexes API `sha256:6aadcb72f955d237d9a144554fa54a5b548b70c67adb120efecaf5ef3904a031`, worker `sha256:50ecfb565460c15c61069c41066f4d58d7accc362ba61d0de3bec73ab74c05ee`, migrator `sha256:c1cd7e38ba5430ef3a54fce16c83de989900ed4474573a6c96109bb2e91c6c03`                                                                                                                                                              |
| Image artifact inspection           | Pass    | 2026-08-10: API, worker, and migrator use fixed UID/GID `10001:10001`, exec-form Node commands, expected OCI labels, no baked secret environment, and pass read-only/capability-free filesystem checks; API/worker contain no Prisma CLI, test, TypeScript, map, or build dependencies                                                                                                                                                                                                                                                                                                                                                         |
| Empty-volume release startup        | Pass    | 2026-08-10: fresh PostgreSQL/RabbitMQ volumes initialized; one role-provisioner and one migrator applied all 11 migrations and verified exact history, grants, and financial invariants before API/worker became healthy                                                                                                                                                                                                                                                                                                                                                                                                                       |
| RabbitMQ startup isolation          | Pass    | 2026-08-10: root health-check Erlang-cookie race reproduced as `eacces`, fixed by running diagnostics as `rabbitmq`, protected by Compose inspection, and proven with cookie ownership `999:999` mode `0400` on a fresh volume                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Release runtime/security smoke      | Pass    | 2026-08-10: API liveness/readiness and worker internal readiness returned 200; unauthenticated `/v1` remained 401; only API `127.0.0.1:3000` was default host ingress; PostgreSQL, RabbitMQ, worker, OTLP, and application metrics remained unexposed                                                                                                                                                                                                                                                                                                                                                                                          |
| Optional release telemetry          | Pass    | 2026-08-10: targeted `--no-deps` startup made Prometheus ready on loopback `9091`, loaded 22 alerts, and converged API/worker/Collector scrape targets to up without changing role/migrator timestamps, restart counts, or migrator log length                                                                                                                                                                                                                                                                                                                                                                                                 |
| Graceful release shutdown           | Pass    | 2026-08-10: API received SIGTERM; worker projection, outbox, and delivery loops emitted drained stops; Collector/Prometheus exited 0; no OOM kill; project containers/networks removed while three named synthetic data volumes remained                                                                                                                                                                                                                                                                                                                                                                                                       |
| Final migrated-volume startup       | Pass    | 2026-08-10: final migrator image reported 11 migrations, no pending migration, and passing permission/invariant verification before final API/worker health; release project then stopped cleanly                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Step 5 full unit regression         | Pass    | 2026-08-10: 53 suites and 226 tests passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Step 5 integration regression       | Pass    | 2026-08-10: first full run passed 9/10 suites and 62/63 tests but saw one transient initial outbox-publisher readiness result; unchanged isolated Eventing suite passed 10/10, then unchanged full rerun passed 10/10 suites and 63/63 tests in 308.49 seconds                                                                                                                                                                                                                                                                                                                                                                                 |
| Step 5 repository gates             | Pass    | 2026-08-10: frozen offline install, Prisma validation, format, lint, type-check, production build, OpenAPI, compiled configuration, boundaries, contracts, 10 quality-tool tests, telemetry rules/config, release topology, image inspection, and documentation links passed                                                                                                                                                                                                                                                                                                                                                                   |
| Deterministic quality tools         | Pass    | 2026-08-09: seven focused tool tests passed; repository module-boundary, contract, configuration, documentation-link, migration, permission, and financial-invariant checks passed                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Telemetry unit/regression suites    | Pass    | 2026-08-09: 51 suites and 215 tests passed, including Infrastructure redaction/context/metrics/tracing/probes, API middleware/lifecycle, and worker lifecycle tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Internal runtime probes             | Pass    | 2026-08-09: built API and worker returned HTTP 200 for loopback liveness, readiness, and Prometheus exposition with real local PostgreSQL/RabbitMQ dependencies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Step 6 approved coverage floors     | Blocked | 2026-08-10: all 226 instrumented tests passed; aggregate statements/branches/functions/lines were 62.45/53.93/50.45/63.58%, below the approved 85/80/80/85% floors, and every critical module remained below at least one 90/85/85/90 floor; thresholds and exclusions were not changed                                                                                                                                                                                                                                                                                                                                                        |
| Real-dependency integration         | Pass    | 2026-08-09: 10/10 suites and 63/63 tests passed in 215.291 seconds against real PostgreSQL/RabbitMQ dependencies, including the bounded Eventing, Webhooks, Settlements, and Reconciliation collectors                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Step 4 telemetry unit tests         | Pass    | 2026-08-09: four focused suites and 17 tests passed for metric label/value bounds, last-safe-value retention, independent collector failure, scheduling, startup/readiness non-interference, and shutdown drain                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Step 4 full unit regression         | Pass    | 2026-08-09: 53 suites and 223 tests passed with no business-behavior regression                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Prometheus/Collector validation     | Pass    | 2026-08-09: digest-pinned Prometheus 3.13.2 and OpenTelemetry Collector Contrib 0.158.0 images validated Compose and Collector/Prometheus configuration; `promtool` loaded 22 rules and all rule tests passed                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Telemetry runtime smoke             | Pass    | 2026-08-09: both telemetry-profile containers became healthy; Prometheus returned ready with 22 loaded alert rules; only loopback ports 4317, 4318, and 9090 were published and port 8888 remained internal                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Step 4 repository gates             | Pass    | 2026-08-09: format, lint, type-check, build, config, OpenAPI, module-boundary, contract, quality-tool, and documentation-link gates passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| New-plan Markdown format            | Pass    | 2026-08-09: `corepack pnpm exec prettier --check docs/plans/2026-08-03-operational-readiness-and-v1-release.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| New-plan relative links             | Pass    | 2026-08-09: PowerShell local-link validation resolved all 11 relative references to repository targets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `git diff --check`                  | Pass    | 2026-08-09: final scoped steps 2-3 implementation diff produced no whitespace errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Final Git status                    | Pass    | 2026-08-09: `main` still tracks `origin/main`; only scoped quality, telemetry, app-composition, documentation, test, manifest, and lockfile changes are present; no commit or push occurred                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Definition of done

This planning milestone is complete when this file is the only worktree change; it accurately traces FR-13, INV-01-INV-10, release gates, current evidence/gaps, exact boundaries/files, telemetry and alert contracts, CI/security/migration/release processes, production-shaped simulation, deterministic demo, recovery/incident design, tests, risks, waivers, approved owner decisions, and implementation order; Markdown formatting/relative links and `git diff --check` pass; and no implementation, dependency, schema, migration, API, finance behavior, commit, or push occurs.

The later implementation is complete only when approved Gates 1-10 are implemented, all existing financial/security behavior remains unchanged and fully regressed, the release-simulation/demo/recovery paths are reproducible, every blocking gate passes, documentation and evidence are current, a clean-room reviewer signs off, and the project either satisfies or explicitly waives every P0 gap before the final immutable tag. A metrics endpoint, green build, happy-path demo, or successful backup alone is insufficient.
