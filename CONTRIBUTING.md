# Contributing to SettleFlow

SettleFlow is a finance-grade simulation and engineering case study. It is not authorized to process real funds or store cardholder data. Contributions must preserve the authoritative specification and the controls in [AGENTS.md](AGENTS.md).

## Before starting

1. Read the complete specification at `docs/specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx`.
2. Inspect the affected modules, migrations, tests, architecture documents, and ADRs.
3. Open or update an implementation plan when [PLANS.md](PLANS.md) requires one.
4. Confirm that the proposed work belongs to P0/P1 scope or clearly identify it as a deferred extension.

## Branches and commits

Do not commit directly to `main` as the normal workflow. Create a short-lived branch using one of these forms:

- `feature/<issue-or-short-name>`
- `fix/<issue-or-short-name>`
- `security/<issue-or-short-name>`
- `docs/<issue-or-short-name>`
- `chore/<issue-or-short-name>`

Keep commits small, focused, and reviewable. Separate behavioral changes from unrelated refactoring or formatting. Use Conventional Commit-style subjects where practical, for example `feat(payments): make capture idempotent` or `docs(architecture): clarify ledger ownership`. Describe the reason and risk in the commit body when the diff alone is insufficient.

Never commit generated secrets, real credentials, production data, local service state, or personal data. Do not rewrite shared branch history without coordinating with affected contributors.

## Pull requests

Use [the pull request template](.github/pull_request_template.md). A pull request must:

- state the goal, scope, non-goals, and linked issue or plan;
- cite specification requirement and invariant IDs;
- identify affected modules, transaction boundaries, contracts, migrations, security controls, and failure/recovery behavior;
- contain one coherent change with no unrelated cleanup;
- include commands and results for every relevant verification gate;
- disclose skipped checks, assumptions, follow-up work, and rollback or forward-recovery steps;
- update OpenAPI, event schemas, architecture, runbooks, examples, and plans when behavior changes.

Draft pull requests are encouraged for early design feedback. A pull request is not ready for merge while required checks fail, a financial/security ambiguity remains, or the diff weakens a database constraint or test without an approved requirement change.

## Tests and evidence

Run the repository-provided commands applicable to the change. Evidence may include:

- format, lint, type-check, and module-boundary results;
- unit and database constraint tests;
- integration tests using real PostgreSQL, RabbitMQ, and HTTP behavior where applicable;
- contract tests for OpenAPI, events, webhooks, and CSV formats;
- concurrency and duplicate-delivery tests for money-changing or asynchronous paths;
- failure-injection and recovery tests;
- tenant-isolation, webhook signature/replay, SSRF, input-limit, and secret-scan results;
- migration-from-empty and prior-version-upgrade results;
- measured performance results with the environment documented.

Do not replace database-backed verification with an in-memory database when PostgreSQL semantics are part of the requirement. Do not skip financial integration tests for release work.

## Migration discipline

- Commit every schema change as a migration reviewed with the application change.
- Preserve the complete migration history; do not edit an applied migration to hide a correction.
- Include constraints, indexes, triggers, and restricted-role behavior needed by the invariant.
- Prove a clean install and upgrade from the maintained prior-version fixture.
- Use expand-migrate-contract sequencing for destructive or rolling-deployment changes.
- Document lock/runtime impact, data backfill behavior, compatibility between API and worker versions, and rollback or forward-fix strategy.
- Never weaken a constraint merely to make a migration or test pass.

## Review requirements

At least one qualified reviewer must approve each change. Require focused financial/domain review for Payments, Ledger, Settlements, Reconciliation, idempotency, or money calculations; security review for authentication, authorization, secrets, webhooks, SSRF, sensitive data, or operator actions; database review for migrations and critical SQL; and architecture review for module/dependency changes or new production dependencies. Material decisions also require an ADR.

Reviewers should use [the SettleFlow code-review checklist](docs/review/code-review-checklist.md). Resolve blocking findings before merge; document accepted residual risk and its owner.

## Documentation

Make observable behavior and operational recovery discoverable. Update relative links, examples, requirement traceability, architecture boundaries, financial invariants, ADRs, implementation plans, runbooks, and contract artifacts in the same pull request as the relevant change.
