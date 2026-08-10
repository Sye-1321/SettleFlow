# CI and Security Gate Failure

## Purpose and trigger

Use this runbook when a required local or GitHub CI, security, migration, contract, concurrency, image, or supply-chain gate fails. Treat a financial invariant, tenant-isolation, secret, critical/high vulnerability, image, or migration failure as release-blocking. The repository Security Owner owns security triage and is the release stop/go authority; there is no 24x7 support commitment.

## Safe triage

1. Identify the exact workflow, job, command, commit, runner image, run attempt, and pinned tool/action revision. Do not rerun merely to obtain green status.
2. If a log or artifact might contain a secret, stop sharing it, restrict access, rotate the material, and follow `SECURITY.md`. Do not paste the finding value into an issue or pull request.
3. Reproduce the repository command from [the CI operations guide](../operations/continuous-integration.md) on a clean checkout with the locked toolchain. For integration failures, require real disposable PostgreSQL/RabbitMQ/HTTP dependencies.
4. For migration failures, preserve the database/container logs privately, then inspect migration history, runtime grants, and financial invariants. Never edit a migration already relied upon, posted Ledger evidence, lifecycle audit, inbox/outbox, Settlement, Reconciliation, or Webhook-delivery evidence to pass a check.
5. For race/failure evidence, rerun only as diagnosis and record every result. Any intermittent failure remains blocking until its cause is removed; do not add a Jest retry or increase a timeout without evidence.
6. For dependency, CodeQL, Gitleaks, or Trivy findings, prefer a compatible patched dependency or code/configuration correction. Critical findings cannot be excepted. A high exception requires the checked schema, explicit owner approval, compensating controls, and expiry within 30 days.
7. For the known coverage failure, add behavior-focused tests. Do not lower thresholds, exclude modules/files, mark the job non-blocking, or treat passing test counts as coverage compliance.

## Validation and closure

Run the failed command, its focused tests, the full affected suite, `pnpm security:policy`, `pnpm docs:check`, and `git diff --check`. A GitHub-only failure closes only after the pinned workflow succeeds on the intended pull-request or `main` trigger. Record the cause, corrective change, commands/results, artifact retention or deletion decision, and any follow-up risk without copying secret values or sensitive request/data content.

Escalate immediately to the Security Owner for suspected disclosure, an unexplained financial/tenant invariant failure, a critical finding, or evidence that a published artifact is unsafe. Release remains stopped until the owner records the disposition.

Last exercise: not yet exercised on GitHub. Owner: repository Security Owner. Review cadence: after every workflow/policy/tool change and before `v1.0.0-rc.1`.
