# Implementation Plan: Merchant Access bounded domain

- **Status:** Complete
- **Owner:** SettleFlow Project
- **Created:** 2026-08-01
- **Last updated:** 2026-08-01
- **Related issue/PR:** None
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0002](../adr/0002-node-typescript-package-manager-and-version-policy.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md), [ADR-0005](../adr/0005-local-development-and-test-environment.md)
- **Related plan:** [Identity and access governance decision](2026-08-01-identity-and-access-bounded-domain.md)

## Goal

Implement specification requirement FR-01 as the existing Merchant Access bounded domain: persist merchant lifecycle roots and merchant-owned scoped API keys, issue high-entropy credentials whose plaintext is returned once, authenticate bearer API keys into a non-secret merchant request identity, and fail closed for unknown, malformed, disabled, revoked, rotated, out-of-scope, or disabled-merchant credentials.

### Non-goals

- User accounts, passwords, registration, login, JWTs, sessions, RBAC roles/permissions, or `/auth/me`.
- Merchant self-service onboarding or an unauthenticated/operator lifecycle HTTP API.
- Payments, payment intents, idempotency, ledger, balances, settlements, reconciliation, webhooks, providers, queues, outbox/inbox, business events, or financial behavior.
- Operator authentication, append-only audit events, rate limiting, secret-scanning CI, or production credential-management infrastructure.
- A seed containing a deterministic or committed usable API-key secret.

## Specification traceability

- **Sections:** Prioritized scope; Stakeholders and System Actors; Bounded modules; Functional Requirements; Component responsibilities; Data Architecture and Integrity Controls; API and Integration Contracts; Security and Threat Model; Delivery and Repository Plan; Appendix A traceability.
- **Requirement IDs:** FR-01. FR-13 health behavior must remain unchanged. FR-14 is deferred because no privileged lifecycle endpoint is exposed.
- **Invariant IDs:** INV-01 through INV-10 remain unchanged and out of scope; no financial model or command is introduced.
- **Acceptance/release gates:** Authentication, scope, rotation/revocation, tenant isolation, migration, OpenAPI security scheme, real PostgreSQL integration, dependency/security review, readiness regression, documentation, and clean-diff evidence.

Authorization evidence:

- Table 12 assigns `merchants`, `api_keys`, and scopes to Merchant Access.
- FR-01 requires hashed, scoped, rotatable API keys; unknown/disabled keys must fail, owned queries must be merchant-scoped, and a raw key is shown once.
- Table 21 defines `merchant` as the unique-code active/disabled tenant root and `api_key` as merchant authentication with a unique public prefix, secret hash only, scopes, and rotation/revocation timestamps.
- Table 24 defines `Authorization: Bearer <merchant_api_key>` and keeps operator authentication separate.
- Table 25 authorizes exactly these scope strings: `payments:write`, `payments:read`, `ledger:read`, `webhooks:manage`, `webhooks:read`, `settlements:write`, `settlements:read`, `reconciliation:write`, and `reconciliation:read`.
- The threat matrix requires hash-at-rest, public-prefix lookup, scopes, rotation, revocation, no credential logging, key-lifecycle integration tests, and tenant-isolation tests.
- The API-key lifecycle section requires a visible non-secret prefix, a high-entropy secret, a slow stored hash, one-time plaintext display, and non-recoverability.
- The M0 milestone explicitly includes merchants/API keys, and the FR-01 release artifact includes an OpenAPI security scheme.

## Existing behavior

The clean committed repository at `de6280f` contains separate API/worker processes, PostgreSQL/RabbitMQ readiness, Prisma 7.9.1 with one empty baseline migration, and one lazy Prisma client per process. It contains no application model, authentication guard, OpenAPI output, domain package, credential lifecycle, merchant context, or financial table.

The full specification remains unchanged at SHA-256 `77E3A5B44C4EE20F2E241DDC5CE2991D64BE82128E31EFBEE6DEC86239F239A6` and contains 1,486 non-empty paragraphs. Governance, security policy, architecture/invariants, ADR-0001 through ADR-0005, all prior plans, README, workspace configuration, API composition, Prisma schema/migration/configuration, and existing unit/integration tests were inspected before this plan.

## Proposed design

### Data model

- Add only `Merchant` and `ApiKey` Prisma models owned by Merchant Access.
- `Merchant` has a UUID identifier, unique bounded code, `ACTIVE`/`DISABLED` status, and UTC creation/update timestamps.
- `ApiKey` has a UUID identifier, merchant foreign key, unique public prefix, slow secret hash, non-empty array of specification-listed scopes, `ACTIVE`/`DISABLED`/`REVOKED` status, creation/update timestamps, and optional revocation/rotation timestamps.
- Database checks keep revoked status/timestamp and rotated status/timestamp consistent. A rotated key is revoked; it never remains valid during an overlap window.
- No `Scope` table is added because the specification defines a closed permission vocabulary, not mutable reference data.

### Credential lifecycle

- Use the pinned Node.js runtime's stable built-in `node:crypto` APIs; add no credential-hashing dependency.
- Generate a 72-bit public lookup component and independent 256-bit secret with `randomBytes`, encoded as Base64url. The one-time credential format is `sf_test_<public>.<secret>`; only `sf_test_<public>` is persisted as the safe prefix.
- Derive a 32-byte hash with asynchronous scrypt using explicit parameters and an independent random 16-byte salt. Store a versioned parameter/salt/hash encoding and compare equal-length derived bytes with `timingSafeEqual`.
- Return plaintext only from successful issue/rotation calls. No query or metadata type exposes it later, and no code logs it.
- Issue only for an active merchant and a non-empty allowlisted scope set.
- Revoke through a conditional state update. Disablement and revocation fail authentication immediately.
- Rotate in one PostgreSQL transaction: conditionally retire one non-revoked old key and insert one replacement. Concurrent rotations have one winner; a failed replacement insert rolls back retirement.

### Request authentication

- Add a global Nest guard that parses exactly one bearer credential, authenticates through Merchant Access, and attaches only `merchantId`, `apiKeyId`, and scopes under a private request symbol.
- Add a typed parameter decorator for future merchant-owned controllers and scope metadata for future routes.
- Mark health controllers public. Swagger middleware remains public. The existing `GET /api/v1` version entrypoint becomes bearer-authenticated but requires no business scope; its response does not disclose merchant identity.
- Missing, malformed, unknown, disabled, revoked, rotated, or disabled-merchant credentials return the same generic HTTP 401 response. A valid key lacking explicitly required scope returns generic HTTP 403.

### API documentation

- Pin `@nestjs/swagger` 11.4.6, whose peer range supports the repository's NestJS 11 line.
- Serve Swagger UI at `/docs` and JSON at `/docs/openapi.json` and commit generated `docs/api/openapi.json`.
- Document the named `merchantApiKey` bearer scheme and current public/protected routes without inventing lifecycle endpoints.
- Add `docs/api/merchant-access.md` and README commands for OpenAPI generation/checking, migration, tests, and authenticated `/api/v1` use with a placeholder only.

Alternatives rejected: a recoverable encrypted API-key secret, fast unsalted hash, plaintext lookup, JWT/Passport, mutable scope records, a global unscoped wildcard, public merchant/key CRUD, deterministic seeded credentials, non-atomic rotation, post-query merchant filtering, or a new protected “current merchant” endpoint.

## Affected modules and files

| Module/file area                   | Ownership or change                                                    | Boundary impact                                                          |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `prisma/`                          | Two Merchant Access models, enums, constraints, migration              | First application schema; no financial table                             |
| `packages/modules/merchant-access` | Domain types, credential service, application service, Prisma adapter  | Owns Merchant Access persistence and exposes stable application behavior |
| `packages/infrastructure`          | Shares the existing Prisma client only                                 | No table ownership or direct Merchant Access behavior                    |
| `apps/api`                         | Composition, global guard, public/scope/identity decorators, OpenAPI   | Thin entrypoint depends on Merchant Access; health remains public        |
| `test/integration`                 | Empty/upgrade migration, real PostgreSQL key lifecycle and HTTP proof  | Test-only direct fixture setup; no production cross-module write         |
| Root tooling/docs                  | Build/test/OpenAPI scripts, lockfile, README, generated contract, plan | One workspace and exact dependency pins remain authoritative             |

No worker dependency, cross-module write, reverse financial dependency, external integration, or new deployable is introduced.

## API and integration impact

- `GET /api/v1` changes from public to `Authorization: Bearer <merchant_api_key>` and returns 401 when authentication fails. Its success body is unchanged.
- `GET /health/live` and `GET /health/ready` remain public and behavior-compatible.
- `GET /docs` and `GET /docs/openapi.json` provide the required API documentation artifact.
- No merchant creation, API-key issue/list/disable/revoke/rotate, self-service onboarding, operator, `/auth/me`, event, RabbitMQ, webhook, or CSV endpoint is added. Lifecycle operations are module application services pending separately authenticated/audited operator delivery.
- The committed OpenAPI document names the bearer scheme but never contains a real key.

## Database and migration impact

- Create PostgreSQL enums for merchant and API-key status. Store scopes as a text array protected by a closed allowlist check so the application keeps one exact scope vocabulary without a mutable scope table.
- Create `merchants` and `api_keys` with UUID primary keys, unique merchant code/public prefix, `RESTRICT` ownership FK, UTC timestamps, status/timestamp checks, non-empty scope check, and an index supporting merchant/status lifecycle queries.
- Prisma routine queries are sufficient; no raw runtime SQL is introduced. Reviewed SQL is limited to migration check constraints Prisma cannot express.
- Apply the full history to an empty real PostgreSQL database and upgrade the committed local baseline. Assert the only application tables are `merchants` and `api_keys`.
- API and worker remain compatible while the additive migration rolls out; neither process requires pre-existing rows to start or report readiness.

## Transaction boundaries and concurrency

- Credential hashing occurs before database transactions and performs no network call.
- Issue uses a short transaction to verify active merchant status and insert one API key.
- Revoke/disable use conditional updates so repeated calls are safe and cannot restore a revoked key.
- Rotate uses one short transaction for old-key conditional retirement and replacement insertion. A concurrent loser observes a zero-row conditional update and creates no key.
- Authentication is a read-only database predicate over prefix, key status, revocation state, and active merchant status followed by hash verification outside a transaction.
- No financial transaction, lock, isolation override, retryable SQLSTATE, broker call, or outbox event exists in scope.

## Security and privacy

- Raw keys exist only in generation/request memory and one successful return value. They are never persisted, retrievable, logged, placed in examples, or included in OpenAPI.
- Public-prefix lookup is non-secret; authentication still requires scrypt verification and constant-time digest comparison.
- All status and merchant checks occur in database predicates before request identity is established.
- Request identity contains stable IDs and scopes only, never the secret/hash or a broad merchant record.
- HTTP failures do not reveal whether prefix, hash, key status, or merchant status failed.
- Scope matching is exact and deny-by-default. Health and documentation are the only public surfaces.
- Production issuance, audit, rate limiting, key-rotation operations, and secret-scanning CI remain required future controls before release.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario          | Expected safe state                                          | Retry/recovery                                         | Evidence                             |
| -------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------ |
| Random generation/hash failure         | No row and no plaintext returned                             | Retry whole issue/rotation call                        | Unit fault-path review               |
| Prefix uniqueness collision            | Insert fails; no key becomes usable                          | Generate a new credential and retry at caller boundary | Constraint/integration test          |
| Merchant disabled/missing              | No key issued; authentication denied                         | Controlled operator correction only                    | Unit/integration tests               |
| Missing/malformed/unknown/wrong secret | Generic 401; no identity                                     | Client supplies valid credential                       | HTTP integration tests               |
| Disabled/revoked/rotated key           | Generic 401; no identity                                     | Issue/rotate through future authorized operator path   | HTTP integration tests               |
| Missing required scope                 | Generic 403; no handler execution                            | Use a key with the explicit required scope             | Guard unit test                      |
| Concurrent rotation                    | One replacement; old key revoked; loser creates nothing      | Reload key state; no automatic partial retry           | Real PostgreSQL race test            |
| Replacement insert failure             | Transaction rolls back; old key remains in prior valid state | Fix cause and retry whole rotation                     | Transaction integration test         |
| PostgreSQL unavailable                 | Existing API readiness fails; auth request fails closed      | Restore dependency and retry                           | Existing readiness/integration tests |

## Observability and operations

No raw credential, authorization header, secret hash, or merchant record is logged. Existing API lifecycle/readiness signals remain unchanged. Authentication metrics, correlation IDs, privileged lifecycle audit events, operator search, rate-limit signals, and recovery runbooks are deferred to FR-13/FR-14 and operator-security milestones.

## Test strategy

- **Unit:** Credential format/entropy shape, one-way hash, randomized salts, correct/incorrect verification, malformed encoding, scope allowlist, service issue/revoke/rotate behavior, bearer parsing, public-route bypass, request identity, and scope denial.
- **Database constraints/migrations:** Full migration history on empty PostgreSQL; local upgrade from committed baseline; uniqueness, FK, non-empty scopes, status/timestamp checks, and no unexpected/financial tables.
- **Integration with real dependencies:** Real PostgreSQL issue/authenticate/disable/revoke/rotate, no plaintext persistence, merchant disablement, tenant identity, concurrent rotation, and application shutdown. Retain RabbitMQ readiness integration.
- **Contract:** Generate/check committed OpenAPI, validate security scheme and public/protected routes, and exercise built API HTTP behavior.
- **Concurrency/race:** Two rotations of one key produce one replacement and leave no second active successor.
- **Failure injection/recovery:** Invalid/unavailable database behavior, transaction rollback on replacement conflict where practical, and existing readiness outage behavior.
- **Security:** Generic failure responses, exact scopes, no secret-bearing fixtures/output/diff, hash-at-rest inspection, and dependency audit.
- **Performance:** Record scrypt parameter and bounded verification timing only; no release performance claim.
- **Documentation/link checks:** Validate local Markdown links, OpenAPI JSON, `git diff --check`, complete diff, and status.

Commands include frozen installation, Compose health, Prisma validate/generate/deploy/status, OpenAPI generation/check, format, lint, type-check, unit tests, real integration tests, production build, HTTP authentication/readiness probes, dependency audit, link validation, `git diff --check`, and `git status`.

## Documentation impact

Update README setup/runtime/database/test commands and limitations. Add the generated OpenAPI contract and Merchant Access API/security guide. Complete this plan with model/endpoint authorization and verification evidence. Architecture, financial invariants, accepted ADRs, security policy, and the prior governance decision remain authoritative and unchanged.

## Rollback or forward-recovery strategy

Before application, code and the additive migration can be reverted together. After migration application, preserve migration history and use a forward migration for corrections. Removing empty Merchant Access tables is only safe before any credential use and is not a normal rollback. A credential exposed during verification is synthetic and disposable; revoke it and remove local test state. No financial or audit record exists to repair.

## Risks and assumptions

| Risk or assumption                                       | Impact                                             | Mitigation/validation                                                                                     | Owner/deadline                                  |
| -------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| No lifecycle HTTP endpoint is authorized                 | Operators cannot manage keys over HTTP yet         | Keep internal services tested; require operator auth/audit plan before exposure                           | SettleFlow Project / operator milestone         |
| Existing `/api/v1` becomes protected                     | Foundation consumers without a key receive 401     | Document compatibility change and verify health/docs remain public                                        | SettleFlow Project / this milestone             |
| Slow hashing consumes the Node threadpool                | Excessive auth concurrency could add latency       | Use async scrypt, explicit parameters, bounded local timing evidence, and future rate/load tests          | Security/performance reviewers / before release |
| Prisma enum-array constraints may not express every rule | Invalid scope/state could enter through direct SQL | Add reviewed migration checks and real PostgreSQL negative tests                                          | Database reviewer / this milestone              |
| Shared Prisma client could encourage boundary bypass     | Future modules could write Merchant Access tables  | Keep Prisma adapter inside Merchant Access and add path mapping/boundary review                           | Architecture reviewer / this milestone          |
| No deterministic API-key seed                            | Demo requires one-time local provisioning later    | Do not commit usable credentials; add audited local bootstrap only in an approved operator/demo milestone | SettleFlow Project / before public demo         |

## Execution checklist

- [x] Governance, full specification, architecture, ADRs, prior plans, schema, code, and tests inspected.
- [x] Design and boundaries reviewed; no specification change or new ADR required.
- [x] Implementation and migration completed.
- [x] Unit, database, integration, race, security, contract, and readiness tests pass.
- [x] Dependency, sensitive-data, and complete-diff review pass.
- [x] README, API documentation, and plan updated.
- [x] Commands/results and deviations recorded below.

## Verification record

| Command or review                                                        | Result                                                                                                                                                | Date/evidence |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Initial `git status --short --branch`                                    | Pass: clean `main...origin/main` at `de6280f`                                                                                                         | 2026-08-01    |
| Complete specification/governance/architecture/ADR/plan/workspace review | Pass: Merchant Access, two models, closed scope vocabulary, bearer authentication, and key lifecycle are authorized; lifecycle HTTP endpoints are not | 2026-08-01    |
| Official Node/Nest/package compatibility review                          | Pass: Node 24 stable `randomBytes`/scrypt/`timingSafeEqual`; Nest guards/decorators and `@nestjs/swagger` 11.4.6 support the pinned NestJS 11 line    | 2026-08-01    |
| `pnpm install --frozen-lockfile`                                         | Pass: all five workspace projects are current under Node 24.18.0 and pnpm 11.18.0                                                                     | 2026-08-01    |
| `pnpm infra:up`, `pnpm infra:ps`                                         | Pass: pinned PostgreSQL 18.4 and RabbitMQ 4.3.4 containers healthy                                                                                    | 2026-08-01    |
| `pnpm prisma:validate`, `pnpm prisma:generate`                           | Pass: Prisma 7.9.1 schema valid and client generated                                                                                                  | 2026-08-01    |
| `pnpm db:migrate:apply`, `pnpm db:migrate:status`                        | Pass: two migrations applied; database schema current                                                                                                 | 2026-08-01    |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`                       | Pass: formatting clean, zero lint warnings, and strict TypeScript clean                                                                               | 2026-08-01    |
| `pnpm test`                                                              | Pass: 7 suites / 18 tests across API, worker, and Merchant Access                                                                                     | 2026-08-01    |
| `pnpm test:integration`                                                  | Pass: 3 suites / 9 tests against disposable real PostgreSQL/RabbitMQ                                                                                  | 2026-08-01    |
| Merchant Access HTTP/database/race integration review                    | Pass: generic auth failure, valid identity, hash-at-rest, lifecycle denial, merchant denial, closed state/scope checks, and one rotation winner       | 2026-08-01    |
| `pnpm build`                                                             | Pass: infrastructure, Merchant Access, API, and worker production outputs built                                                                       | 2026-08-01    |
| `pnpm openapi:generate`, `pnpm openapi:check`                            | Pass: committed contract generated and byte-for-byte current                                                                                          | 2026-08-01    |
| Compose API runtime probes                                               | Pass: live 200, ready 200, OpenAPI 200, missing key 401, malformed key 401                                                                            | 2026-08-01    |
| `pnpm audit --audit-level high`                                          | Pass after pinning patched transitive `js-yaml` 5.2.2; no known vulnerabilities                                                                       | 2026-08-01    |
| Local documentation target check                                         | Pass: 14 referenced repository targets present                                                                                                        | 2026-08-01    |
| `git diff --check`, complete diff/security review, final Git status      | Pass: clean patch syntax; only this uncommitted milestone is present                                                                                  | 2026-08-01    |

The generated OpenAPI JSON is checked by `pnpm openapi:check` rather than Prettier so its exact deterministic generator output remains the contract. The initial dependency audit identified the newly disclosed `js-yaml` 5.2.1 advisory through Swagger; the existing pnpm override policy now selects patched 5.2.2, and the frozen install and audit were repeated successfully.

## Definition of done

- Only Merchant Access owns the two authorized models and their persistence adapter.
- Plaintext API keys are high entropy, returned only once, never persisted/recoverable/logged, and verified through a slow salted hash.
- Authentication, merchant status, key status, exact scopes, revocation, atomic rotation, and concurrent single-winner behavior are proven against real PostgreSQL and HTTP.
- Health/readiness remain compatible; OpenAPI and README accurately document public/protected surfaces and limitations.
- Migration, static, format, unit, integration, race, build, runtime, dependency, link, diff, and status gates pass.
- No user/JWT/RBAC/onboarding, financial table/behavior, business event, queue, real secret, commit, or push is introduced.
