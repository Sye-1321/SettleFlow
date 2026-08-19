# SettleFlow v1 Release Checklist

**Status: pre-release; not approved.** Complete this checklist against one candidate commit and one exact set of locally built image digests. A checked repository artifact is not a substitute for current command output or owner approval.

## Candidate identity and scope

- [ ] Candidate commit is protected `main`, clean, reviewed, and records no secret/proprietary/confidential source.
- [ ] `CHANGELOG.md`, draft release notes, OpenAPI, event schemas, ADR index, architecture, examples, runbooks, threat model, configuration, support policy, and evidence matrix match the candidate.
- [ ] Every P0 requirement is `PASS` or has the exact owner-approved waiver; every P1/P2 deferral and operational limitation is visible.
- [ ] The project is described only as a finance-grade simulation; no production, compliance, certification, real-provider, payout, or exactly-once claim appears.

## Source, financial, and contract gates

- [ ] Frozen install, format, lint, type-check, build, module boundaries, configuration, documentation links, and deterministic tool tests pass.
- [ ] Unit and approved global/critical-module coverage floors pass without exclusion/threshold changes.
- [ ] Real PostgreSQL/RabbitMQ/HTTP integration, required repeated concurrency, and failure-injection suites pass with no skipped financial case.
- [ ] Empty database and maintained applicable prior fixture migrations, drift, runtime grants, named constraints/triggers, and INV-01–INV-10 pass.
- [ ] Committed OpenAPI and all five event schemas/examples match runtime/source contracts; public problem, Webhook signature, AMQP metadata, and CSV contracts pass.

## Security and supply chain

- [ ] Repository/history secret scan, dependency audit/review, license review, workflow policy, CodeQL, and Dockerfile policy pass.
- [ ] API, worker, and migrator are rebuilt once from the candidate; non-root/read-only/capability/port/config inspection passes.
- [ ] Trivy reports zero critical and zero unreviewed high package/filesystem-secret findings for every candidate image.
- [ ] SPDX SBOMs, checksums, image IDs/digests, OCI labels, source revision, and verified provenance/attestation evidence are retained without secret configuration.
- [ ] Apache-2.0 source/contribution provenance and every third-party license/NOTICE/attribution obligation are reviewed for source and image distributions.
- [ ] GitHub Private Vulnerability Reporting and Security-alert email notification are enabled and tested; one private-advisory/incident tabletop is recorded.

## Operations, recovery, and performance

- [ ] Release-simulation Compose starts from empty volumes, provisions the role, applies migrations once, becomes healthy, exposes only loopback API/optional telemetry, and drains/stops cleanly.
- [ ] Structured logs, request/event/delivery correlation, internal probes, protected low-cardinality metrics, 22 executable alerts, and alert-to-runbook links pass.
- [ ] Database backup/isolated restore verifies migration history, permissions, financial/asynchronous evidence, API/worker readiness, and measured RTO.
- [ ] RPO is either proven by an exercised at-most-15-minute cadence or remains explicitly unclaimed in release notes; no one-off backup is presented as RPO proof.
- [ ] All five Table 37 performance scenarios pass executable thresholds in the documented environment; raw secret/data output is absent and the summary is committed/attached.
- [ ] Catastrophic RabbitMQ-volume loss and no controlled replay remain explicit limitations; no queue/`published_at` manual repair was used.

## Reproducibility and clean-room review

- [ ] Fresh clone with documented prerequisites reaches a completed deterministic demo in at most 15 minutes using synthetic data.
- [ ] Demo proves replay equivalence, one capture/Ledger/outbox effect, refund, signed retry/delivery, Settlement, Reconciliation mismatch, broker outage/readiness, catch-up, and dedupe.
- [ ] An independent second-person or clean-room operator records commands, exact versions/digests, elapsed times, failures, skipped checks, environment resources, and findings.
- [ ] Every blocking finding is resolved; accepted residual risks link to owner, rationale, follow-up milestone, and next-minor review.

## Release sequence and owner approval

- [ ] Create `v1.0.0-rc.1` only after technical gates pass; keep its API/worker images private and use exact candidate digests for clean-room verification.
- [ ] Confirm workspace packages remain private and no npm publication occurs.
- [ ] Repository owner `@Sye-1321` records explicit security, waiver, and release stop/go approval.
- [ ] Tag `v1.0.0` only after clean-room approval; never move or recreate the tag.
- [ ] Promote exactly the digest-tested API/worker images to approved GHCR names without rebuilding; verify registry digests match.
- [ ] Attach checksums, SBOMs, provenance/attestation, OpenAPI/events, sanitized verification summary, release notes, limitations, and upgrade guidance.

## Current blockers

- The current production dependency audit reports high-severity `GHSA-ggr8-5vv4-36mx` in transitive `deepmerge-ts` 7.1.5 through Prisma 7.9.1 configuration tooling; there is no exception, and a compatibility-verified update is required.
- Reference performance scenarios have source definitions but no final candidate environment result yet.
- A sustained backup cadence has not proven the 15-minute RPO; only isolated restorability/RTO is evidenced.
- Private Vulnerability Reporting/notifications and the private-advisory tabletop require repository-owner GitHub actions.
- Clean-room review, `v1.0.0-rc.1`, final owner approval, immutable tag, and exact-digest GHCR promotion are Step 10 work.

Any correctness, tenant-isolation, secret-exposure, Webhook-SSRF, migration, recovery, critical/high security, or financial-invariant blocker keeps the project pre-release regardless of demo appearance.
