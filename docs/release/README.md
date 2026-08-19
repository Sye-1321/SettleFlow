# Release Documentation

SettleFlow has no stable public release. This directory defines the controlled path from the current pre-release finance-grade simulation to `v1.0.0`; it is not evidence that a tag or artifact already exists.

| Document                                            | Purpose                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [v1 release checklist](v1-release-checklist.md)     | Blocking technical, security, clean-room, waiver, and owner-approval gates             |
| [Draft v1.0.0 release notes](v1.0.0.md)             | Intended capabilities, changes, waivers, limitations, and artifact contract            |
| [Versioning and support](versioning-and-support.md) | SemVer/API-major policy, supported versions, maintenance and publication rules         |
| [Upgrade and migrations](upgrade-and-migrations.md) | Initial install, database migration, compatibility, failure, and future upgrade policy |

Related evidence:

- [requirements/invariants evidence matrix](../review/requirements-evidence-matrix.md)
- [engineering evidence summary](../review/engineering-evidence.md)
- [OCI release simulation](../operations/release-simulation.md)
- [database recovery](../operations/database-recovery.md)
- [performance workload and evidence](../../perf/README.md)
- [security policy](../../SECURITY.md)
- [incident-response runbook](../runbooks/incident-response.md)

## Controlled release sequence

1. Keep changes on protected `main`; all required CI, security, reliability, migration, contract, documentation, recovery, and performance gates must pass.
2. Build API, worker, and migrator once from the candidate commit and record exact manifest/image digests, SBOMs, provenance, source revision, configuration contract, and scan summary.
3. Create `v1.0.0-rc.1` only after technical gates pass. Do not publish candidate images to public GHCR.
4. Run the clean-room setup/demo/recovery/performance process against those exact local candidate digests and obtain second-person or independent clean-room sign-off.
5. Confirm every P0 waiver, P1 deferral, operational limitation, legal/provenance obligation, and security-control prerequisite; resolve any correctness, tenant, secret, SSRF, migration, recovery, or high/critical security blocker.
6. The repository owner makes the explicit stop/go decision. Only then tag `v1.0.0` and promote the exact digest-tested API/worker images—never rebuild or retag a different digest.

Workspace packages remain private and are never published to npm. Release automation must not mutate application behavior or bypass owner approval.
