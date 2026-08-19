# Incident Response

## Purpose and authority

This runbook governs security, financial-integrity, availability, recovery, and release-supply-chain incidents in the SettleFlow finance-grade simulation. `@Sye-1321` is the sole Security Owner, Incident Commander, disclosure authority, and release stop/go authority. There is no backup maintainer, staffed paging rotation, or 24x7 support commitment.

## Severity

- **Critical:** confirmed or credible exposure of secrets/private backups; cross-merchant access; committed Ledger/financial invariant failure; authoritative database loss; unsafe published artifact; critical dependency/image finding; or unauthorized evidence mutation.
- **High:** financial command path cannot be trusted; recovery, migration, signing, SSRF, idempotency, or tenant isolation gate fails; high unreviewed vulnerability; or sustained loss of a required dependency.
- **Medium:** bounded operational degradation with intact authoritative state and no security/tenant impact, including retry backlog or telemetry loss beyond the approved alert threshold.
- **Low:** contained documentation/tooling defect with no runtime, evidence, or release effect.

Critical and high incidents stop the affected release. Prometheus severity labels and GitHub check results are inputs; the Incident Commander may raise severity but must not lower it to bypass a gate.

## Response lifecycle

1. **Detect and open:** record UTC start/detection time, safe environment/revision identifiers, reporter, signal, suspected scope, and incident severity. Never paste secret values, dumps, raw payloads, financial amounts, or customer-like data.
2. **Contain:** stop only the affected traffic, worker, publication, or release path through an authorized deployment control. Preserve PostgreSQL and immutable evidence. Do not perform manual row/queue repair.
3. **Preserve evidence:** restrict logs/artifacts, record hashes and custody, capture exact tool/image/workflow versions, and retain only what is necessary. If a secret may be present, restrict access before sharing and rotate through the owning system.
4. **Diagnose:** reproduce on a disposable environment or isolated restore. Use correlation/public IDs and aggregate counts, not sensitive bodies. Separate root cause from downstream symptoms and record every retry/rerun.
5. **Recover:** use the applicable runbook and a reviewed forward fix, exact idempotent retry, or approved immutable reversal. Database loss uses [database recovery](database-recovery.md). A recovery action must not rewrite financial history or claim exactly-once delivery.
6. **Validate:** rerun affected financial/security/failure gates plus migrations, grants, invariants, contracts, integration, image/security, and documentation checks as applicable. Confirm backlogs converge without manual edits.
7. **Communicate and disclose:** the Incident Commander owns public/private communication and coordinates GitHub Private Vulnerability Reporting under `SECURITY.md`. Simulation response targets are not a production SLA.
8. **Close and review:** record impact, cause, timeline, evidence disposition, recovery authorization, verification, residual risk, and follow-up owner/due date. Update tests/runbooks before release resumes.

## Response commitments

For privately reported vulnerabilities, acknowledge within three business days and perform initial triage within seven business days. On confirmation, target critical fixes/advisories within seven calendar days, high within 30 days, medium within 90 days, and low in a planned release. Withdraw an affected public artifact when a confirmed critical issue makes it unsafe. These are repository-maintenance commitments for a public simulation, not continuous service support.

## Evidence and communications safety

Private incident records may reference safe request/event/public IDs, commit/image digests, check names, UTC times, aggregate counts, and hashes. They must not include API keys, authorization headers, passwords, keyring/signing material, database/RabbitMQ URLs, Webhook payloads, reconciliation CSV rows, private backup contents, or raw financial values. Public notes disclose the minimum safe facts only after the disclosure authority approves them.

## Mandatory escalation and prohibited shortcuts

Escalate immediately for a committed mismatch, suspected secret/private-backup exposure, tenant breach, absent/disabled invariant, unsafe artifact, or inability to establish authoritative state. Never lower thresholds, skip a required test, edit migration history, mutate immutable evidence, clear outbox publication state, replay RabbitMQ manually, publish a rebuilt-but-untested digest, or describe the project as production-ready.

Owner: `@Sye-1321`. Review cadence: after each incident/tabletop and before each release candidate. Before public `v1.0.0`, GitHub Private Vulnerability Reporting must be enabled and tested and one private-advisory/incident tabletop must be recorded without exposing the report.
