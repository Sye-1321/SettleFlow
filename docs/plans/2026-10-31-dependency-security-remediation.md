# Implementation Plan: Dependency security remediation

- **Status:** In progress
- **Owner:** SettleFlow Project
- **Created:** 2026-10-31
- **Last updated:** 2026-10-31
- **Related issue/PR:** October 26, 2026 security workflow run 40298573836
- **Related ADRs:** ADR-0002

## Goal

Remediate the high-severity `zod`, `body-parser`, and `multer` advisories reported by the October 26 security workflow, retain existing API and worker behavior, and correct documentation that still describes the dependency and image gates as passing.

### Non-goals

- No feature, API, schema, financial-flow, demo, performance, release-preparation, or unrelated dependency change.

## Specification traceability

- **Sections:** Technology baseline; Security and Threat Model; Verification and Quality Strategy; CI/CD pipeline.
- **Requirement IDs:** Supports FR-01 through FR-14 without changing their behavior.
- **Invariant IDs:** INV-01 through INV-10 are unaffected and must remain green.
- **Acceptance/release gates:** Security, reproducibility, and documentation.

## Existing behavior

Security workflow run 40298573836 failed the production dependency audit on `GHSA-mrhx-c7xc-m3w5`, `GHSA-27r3-jxmh-p828`, and `GHSA-q7qp-rjg7-q26m`. The same packages produced three high findings in each API and worker image. The workspace currently resolves `zod` 4.4.3, `body-parser` 2.3.0, and `multer` 2.3.0, all below the advisory fixes. No security exception is active.

## Proposed design

Pin direct `zod` consumers to the minimum compatible patched release and use bounded workspace overrides for the transitive Express/Nest packages. Regenerate only the pnpm lockfile and update the three requested security-status documents with dated, evidence-based wording.

## Affected modules and files

| Module/file area | Ownership or change | Boundary impact |
| --- | --- | --- |
| API and worker manifests | Patch direct `zod` version | None |
| Workspace/lockfile | Bound vulnerable transitive versions to patched releases | None |
| Security evidence documentation | Replace stale pass claims and record remediation | None |

No dependency direction or cross-module write changes.

## API and integration impact

None. REST/OpenAPI, events, RabbitMQ, webhooks, CSV, pagination, errors, idempotency, and compatibility contracts remain unchanged.

## Database and migration impact

None. No schema, migration, SQL, data, or runtime-role change.

## Transaction boundaries and concurrency

None. Financial transactions, locks, isolation, idempotency, outbox/inbox, and retry behavior are unchanged.

## Security and privacy

The patch removes three known denial-of-service findings without exceptions or suppressions. Existing validation, request limits, authentication, tenant isolation, logging, secret handling, webhook, CSV, and least-privilege controls remain unchanged.

## Failure, retry, and recovery behavior

| Failure or duplicate scenario | Expected safe state | Retry/recovery | Evidence |
| --- | --- | --- | --- |
| Frozen install or compatibility failure | No deployable change | Revert or forward-fix dependency pins | Install, type, build, and test gates |
| Advisory remains in a runtime image | Security gate blocks | Forward-fix the dependency graph | Audit and Trivy image scans |

## Observability and operations

No telemetry, probe, alert, audit-event, or runbook behavior changes.

## Test strategy

- **Unit/integration/contracts:** Run existing affected repository gates; no test weakening.
- **Security:** Frozen install, dependency audit/policy, and API/worker/migrator image scans.
- **Documentation/link checks:** Run formatting, documentation checks, and diff validation.
- **Performance:** Not affected; no workload or threshold change.

## Documentation impact

Update `CHANGELOG.md`, the requirements evidence matrix, and CI documentation only where they make stale security-status claims or duplicate obsolete advisory wording.

## Rollback or forward-recovery strategy

The manifest, override, lockfile, and prose changes are reversible. If compatibility fails, forward-fix to another patched compatible release or revert before merge. No persisted financial or audit data is involved.

## Risks and assumptions

| Risk or assumption | Impact | Mitigation/validation | Owner/deadline |
| --- | --- | --- | --- |
| Patched transitive versions remain compatible with Express/Nest ranges | Runtime regression | Frozen install, build, unit/integration, and image gates | SettleFlow Project / before handoff |
| Advisory data may change after verification | A later scan may fail | Keep dated evidence and rerun scheduled gates | SettleFlow Project / ongoing |

## Execution checklist

- [x] Design and boundaries reviewed.
- [x] Required ADR/specification change reviewed; none required.
- [x] Dependency patch completed.
- [ ] Tests and security gates pass; GitHub image gate pending.
- [x] Documentation updated.
- [ ] Commands/results and deviations recorded below.

## Verification record

| Command or review | Result | Date/evidence |
| --- | --- | --- |
| October 26 security workflow investigation | Failed on the three named high advisories in audit and images | 2026-10-31 / run 40298573836 |
| `corepack pnpm install --frozen-lockfile` | Passed | 2026-10-31 |
| `pnpm security:policy` | Passed; zero active exceptions and no critical or unreviewed high audit findings | 2026-10-31 |
| `pnpm docs:check` | Passed | 2026-10-31 |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | Passed sequentially | 2026-10-31 |
| `pnpm test` | Passed; 72 suites and 493 tests | 2026-10-31 |
| `pnpm format:check` | Baseline failure in 395 files, including untouched files and the unmodified `HEAD` content | 2026-10-31 |
| Local `pnpm images:build` | Incomplete: Docker registry/scanner downloads repeatedly stalled; use GitHub security workflow | 2026-10-31 |
| GitHub security workflow | Not run: push rejected because the configured account has read-only repository access | 2026-10-31 |

## Definition of done

The locked production graph contains patched `zod`, `body-parser`, and `multer` versions; the production audit and image security policy report no unreviewed high or critical findings; affected compatibility and documentation gates pass; the three specified documents contain current, concise evidence; and the diff has no unrelated changes or suppressions.
