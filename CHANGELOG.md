# Changelog

All notable changes to SettleFlow will be recorded here. The project follows
[Semantic Versioning](https://semver.org/) for release artifacts; the public HTTP API uses its independent `/v1` major path.

## [Unreleased]

### Added

- Merchant-scoped Payment Intent creation/read, direct full capture, and partial/full refunds with persisted idempotency replay.
- PostgreSQL-enforced immutable double-entry Ledger postings and guarded Settlement accounting.
- Transactional outbox publication, inbox-protected consumers, signed Webhook projection/delivery, and retry/dead-letter evidence.
- Settlement batching, deterministic fee snapshots, post-settlement refund adjustments, and mock-provider CSV reconciliation.
- Structured telemetry, internal probes, executable alerts, secure OCI release simulation, deterministic demo, CI/security gates, and isolated database-recovery tooling.

### Security

- Scoped and hashed merchant API keys, encrypted rotating Webhook secrets, tenant-scoped persistence predicates, SSRF protections, least-privilege runtime database grants, secret scanning, CodeQL, dependency/license review, and container scanning.

### Known limitations

- SettleFlow remains a pre-release finance-grade simulation. The complete waiver, deferral, operational-limit, and release-blocker record is maintained in the [draft v1 release notes](docs/release/v1.0.0.md).

No stable version has been released. The first release candidate and `v1.0.0` entries will be cut only through the approved [release checklist](docs/release/v1-release-checklist.md); this file must not be used to imply that an untagged commit is released.
