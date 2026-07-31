# Implementation Plan: Identity and access bounded domain

- **Status:** Draft
- **Owner:** SettleFlow Project
- **Created:** 2026-08-01
- **Last updated:** 2026-08-01
- **Related issue/PR:** None
- **Related ADRs:** [ADR-0001](../adr/0001-nestjs-modular-monolith-and-two-deployables.md), [ADR-0002](../adr/0002-node-typescript-package-manager-and-version-policy.md), [ADR-0003](../adr/0003-postgresql-prisma-and-financial-data-access.md)

## Goal

Determine whether the requested user identity, password, RBAC, and JWT capability is authorized by the SettleFlow specification before introducing a bounded module, public API, production dependencies, or database models.

### Non-goals

- Merchant onboarding or an unrequested replacement implementation of Merchant Access/API-key lifecycle behavior.
- Payments, transactions, balances, ledger, settlements, webhooks, providers, queues, business events, or financial tables.
- Selecting password-hashing or JWT libraries before the owning module, actor, lifecycle, and contracts are approved.
- Application/schema implementation while the material specification conflict below remains unresolved.

## Specification traceability

- **Sections:** Stakeholders and System Actors; Domain Model and Financial Semantics; Functional Requirements; Architecture and Technical Design; Data Architecture and Integrity Controls; API and Integration Contracts; Security and Threat Model; Delivery and Repository Plan.
- **Requirement IDs:** FR-01 specifies hashed, scoped, rotatable merchant API keys. FR-14 requires actor evidence for privileged operations but does not define an operator identity store or authentication mechanism.
- **Invariant IDs:** INV-01 through INV-10 are unaffected; no financial model or transaction is proposed.
- **Acceptance/release gates:** Architecture, API contract, migration, authentication/authorization security, tenant isolation, dependency review, documentation, and clean-diff evidence.

The specification authorizes a `Merchant Access` module owning `merchant`, `api_key`, and scopes. It defines merchant bearer authentication as a merchant API key, requires operator APIs to use separate authentication, and does not define a `User`, `Role`, `Permission`, user-role join, role-permission join, password credential, refresh/session record, registration/login/current-user endpoint, or JWT contract. The architecture overview also identifies the operator authentication mechanism and role model as **To be decided**. An `Identity and Access` bounded module would therefore add or rename an architectural boundary rather than implement an existing one.

## Existing behavior

The worktree was clean on `main...origin/main` before this plan was created. The committed foundation has separate NestJS API/worker deployables, real PostgreSQL/RabbitMQ readiness, an intentionally model-free Prisma schema, one empty baseline migration, one lifecycle-managed Prisma client per process, and no authentication, authorization, user, merchant, API-key, role, permission, password, JWT, or financial behavior.

Evidence inspected includes the complete 1,486-nonempty-paragraph specification, repository governance and security policy, architecture and invariant documents, ADR-0001 through ADR-0005, README, all existing implementation plans, Prisma schema/migration/configuration, workspace scripts, API composition, environment validation, lifecycle handling, and existing unit/integration tests.

## Proposed design

Stop before application or schema implementation and obtain an authoritative decision for one of these distinct designs:

1. Implement specification FR-01 as the existing Merchant Access module with merchant-scoped, hashed, rotatable API keys and scopes. This is supported, but it is materially different from the requested user/password/JWT endpoints and must not be substituted without direction.
2. Define separate operator identity and authorization, including the owning bounded module, actor lifecycle, role/permission catalog, bootstrap/recovery policy, token/session model, endpoint exposure, audit integration, and relationship (if any) to merchants. This requires an accepted ADR and specification change/approval before implementation.
3. Add customer/merchant-console user registration and JWT authentication. This is not in v1.0 scope and requires an explicit product/specification change plus an accepted architecture/security decision.

Alternatives rejected for this draft are silently mapping users onto merchants, adding generic RBAC tables without an authorized permission catalog, exposing self-registration for privileged operators, issuing JWTs without revocation/session policy, and implementing API keys under user/password endpoint names.

### Decisions to be made

- **To be decided:** Which actor is represented by `User`: platform operator, merchant operator, merchant developer, or another actor?
- **To be decided:** Whether the implementation remains the specified Merchant Access module or introduces a new Identity and Access boundary.
- **To be decided:** Whether public registration is permitted and, if so, how it avoids becoming merchant onboarding.
- **To be decided:** The role/permission catalog, assignment authority, bootstrap administrator procedure, least-privilege defaults, and audit requirements.
- **To be decided:** Access-token lifetime, signing algorithm and key custody, issuer/audience, revocation/session/refresh policy, credential recovery, lockout/rate-limit policy, and password-hashing parameters.
- **To be decided:** Exact REST paths and schemas, because the specification's initial public API contains no registration, login, or current-user endpoint.

The SettleFlow Project owner must resolve these items through specification change control and an accepted ADR before coding.

## Affected modules and files

| Module/file area                                              | Ownership or change                                     | Boundary impact                                           |
| ------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `docs/plans/2026-08-01-identity-and-access-bounded-domain.md` | Records evidence, alternatives, and the governance stop | Documentation only                                        |
| Application, Prisma, dependencies, environment, contracts     | No change while decisions are open                      | Prevents an unauthorized module/public API/security model |

No new dependency direction, cross-module read, or table owner is approved by this draft.

## API and integration impact

None in this draft. The existing `GET /health/live`, `GET /health/ready`, and `GET /api/v1` routes remain unchanged. No registration, login, current-user, JWT bearer scheme, OpenAPI contract, merchant API-key endpoint, event, RabbitMQ message, webhook, or CSV behavior is introduced.

## Database and migration impact

None. The Prisma schema remains intentionally model-free and the committed empty baseline migration remains unchanged. No user, credential, role, permission, join, merchant, API-key, audit, session, token, or financial table is authorized or created.

The first approved application-schema migration must be reviewed against an empty database and the committed baseline, preserve API/worker compatibility, and define table ownership, uniqueness, foreign keys, deletion policy, timestamps, sensitive-column handling, and forward recovery.

## Transaction boundaries and concurrency

None in this draft. A future approved identity design must define atomic registration/provisioning, role assignment, credential update, revocation, and token/session invalidation behavior, including uniqueness and concurrent-update handling. No network call may occur inside a future database transaction.

## Security and privacy

No credential, password, password hash, JWT, signing key, personal data, authorization header, or usable secret is added. Implementing the requested design prematurely could create public self-registration for privileged actors, an unaudited role-assignment path, tokens with no revocation model, or a tenant identity model that conflicts with merchant API keys. Security review is mandatory once the actor and boundary are approved.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario                     | Expected safe state                           | Retry/recovery                                                  | Evidence                                |
| ------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| Requested design lacks specification authority    | No application/schema change                  | Approve specification/ADR decision, then revise this plan       | Cross-document traceability review      |
| Duplicate or concurrent registration/provisioning | Not applicable yet                            | Define uniqueness and single-winner behavior in approved design | Future database/integration tests       |
| Password verification or token issuance failure   | Not applicable yet                            | Fail closed without credential/token disclosure                 | Future security tests                   |
| Role assignment/revocation race                   | Not applicable yet                            | Define transactional authorization state and stale-token policy | Future concurrency/integration tests    |
| PostgreSQL or RabbitMQ unavailable                | Existing readiness behavior remains unchanged | Use existing dependency recovery paths                          | Existing unit/integration/runtime gates |

## Observability and operations

No new signal is introduced. A future design must define redacted authentication success/failure metrics, actor/correlation identifiers, rate-limit/lockout signals, privileged role-change audit evidence, signing-key rotation/recovery, and runbooks without logging credentials, raw tokens, password hashes, or authorization headers.

## Test strategy

- **Unit:** No new behavior to test in this draft.
- **Database constraints/migrations:** Confirm the current migration history still applies and no unauthorized table exists.
- **Integration with real dependencies:** Run the existing PostgreSQL/RabbitMQ readiness and Prisma foundation suite.
- **Contract:** Exercise only the existing foundation routes; proposed identity routes are not authorized.
- **Concurrency/race:** Deferred until actor, data model, and token semantics are approved.
- **Failure injection/recovery:** Retain existing dependency-unavailable behavior.
- **Security:** Inspect the diff for secrets and confirm no credential/token implementation or dependency was added.
- **Performance:** Not applicable.
- **Documentation/link checks:** Validate relative Markdown links, run `git diff --check`, and inspect complete status.

## Documentation impact

This draft plan is the only intended repository change. README, architecture, ADR index, OpenAPI, security policy, and runbooks must be updated only after the governing product and architecture decisions are approved.

## Rollback or forward-recovery strategy

The plan-only change is safely removable before approval and has no runtime or data effect. After an authorized implementation begins, schema corrections must use forward migrations; credential and signing-key changes require explicit rotation and recovery procedures rather than data mutation shortcuts.

## Risks and assumptions

| Risk or assumption                                        | Impact                                            | Mitigation/validation                                                     | Owner/deadline                               |
| --------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| `User` actor is undefined                                 | Wrong tenant/privilege model and unsafe endpoints | Define actor and trust boundary in specification/ADR                      | SettleFlow Project / before implementation   |
| Generic RBAC is implemented without an approved catalog   | Privilege escalation or unusable authorization    | Approve permissions, assignment authority, defaults, and audit rules      | Security/architecture owners / before schema |
| JWT is treated as a complete session policy               | Revocation, compromise, and recovery gaps         | Decide token/key/session lifecycle and prove failure cases                | Security owner / before dependency selection |
| Self-registration overlaps prohibited merchant onboarding | Scope violation                                   | State who may provision whom and separate any future onboarding milestone | Product owner / before API contract          |
| Merchant API keys and operator identities are conflated   | Contradicts the specified trust boundaries        | Preserve separate authentication mechanisms and ownership                 | Architecture owner / before implementation   |

## Execution checklist

- [x] Governance, specification, architecture, ADRs, current schema, plans, and code inspected.
- [x] Material contradiction documented before coding.
- [ ] Specification change/clarification and required ADR approved.
- [x] Existing design and boundaries reviewed; proposed design remains unapproved.
- [ ] Implementation and migrations completed.
- [ ] Tests and failure scenarios pass for approved behavior.
- [x] Security and sensitive-data review pass for this plan-only change.
- [ ] API/security documentation and runbooks updated.
- [x] Commands/results and deviations recorded below.

## Verification record

| Command or review                                                                         | Result                                                                                                                                                                   | Date/evidence |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Initial `git status --short --branch`                                                     | Pass: clean `main...origin/main`                                                                                                                                         | 2026-08-01    |
| Complete specification/governance/ADR/workspace review                                    | Material conflict: requested user/password/JWT/RBAC model and endpoints are not authorized by v1.0                                                                       | 2026-08-01    |
| `node --version`, `pnpm --version`, Docker/Compose versions                               | Pass: Node.js 24.18.0, pnpm 11.18.0, Docker Engine 29.4.3, Docker Compose 5.1.3                                                                                          | 2026-08-01    |
| `docker compose config --quiet`, `docker compose up --detach --wait`, `docker compose ps` | Pass: PostgreSQL 18.4 and RabbitMQ 4.3.4 healthy                                                                                                                         | 2026-08-01    |
| `pnpm install --frozen-lockfile`                                                          | Pass: all four workspace projects already up to date                                                                                                                     | 2026-08-01    |
| `pnpm prisma:validate`, `pnpm prisma:generate`                                            | Pass: schema valid; Prisma Client 7.9.1 generated                                                                                                                        | 2026-08-01    |
| `pnpm db:migrate:apply`, `pnpm db:migrate:status`                                         | Initial safe failure without an ignored root `.env`; pass when rerun with the checked-in synthetic URL supplied command-locally: no pending migration and schema current | 2026-08-01    |
| Database object/history inspection                                                        | Pass: `_prisma_migrations` remains the only public table and contains one completed baseline migration                                                                   | 2026-08-01    |
| `pnpm format:check` and plan-specific Prettier check                                      | Pass after formatting the new plan; the initial plan-specific check identified Markdown style differences and the rerun passed                                           | 2026-08-01    |
| `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`                                  | Pass: zero lint/type errors, 4 unit suites/6 tests, and both production deployables built                                                                                | 2026-08-01    |
| `pnpm test:integration`                                                                   | First run hit the disposable RabbitMQ 30-second startup-log timeout; unchanged retry passed 2 suites/4 tests                                                             | 2026-08-01    |
| Built API runtime probe                                                                   | Pass: `/health/live`, `/health/ready`, and `/api/v1` returned HTTP 200; unapproved `/api/v1/auth/me` returned HTTP 404; stderr empty                                     | 2026-08-01    |
| Markdown local-link validation                                                            | Pass: 89 local links resolved; an initial validator path bug for root files was corrected before the passing run                                                         | 2026-08-01    |
| `git diff --check`, untracked-file whitespace check, complete diff/status review          | Pass: only this draft plan is untracked and nothing is staged                                                                                                            | 2026-08-01    |

## Definition of done

This plan may move to **In progress** only after an authoritative actor/module/API/security model is approved and any required specification update and ADR are accepted. The implementation milestone is done only when the approved bounded module, migration, secure credential/token lifecycle, authorization enforcement, focused tests, API documentation, runtime proof, and all repository gates pass without introducing merchant onboarding, financial behavior, business messages, real secrets, or unrelated scope.
