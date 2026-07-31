# ADR-0002: Node.js, TypeScript, package manager, and version policy

- **Status:** Accepted
- **Date:** 2026-07-31
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through the architecture-decision milestone
- **Supersedes:** None
- **Superseded by:** None

## Context

The specification selects a supported Node.js LTS runtime and NestJS but intentionally avoids exact dependency versions. Before scaffolding, the repository needs one language/toolchain direction, one package manager, one lockfile policy, and a repeatable rule for selecting and upgrading exact versions.

The exact "current Node.js LTS" changes over time. Pinning a remembered version in this ADR would become stale and could conflict with NestJS, Prisma, Testcontainers, or container support. Exact versions must therefore be verified together immediately before manifests and runtime files are created.

The specification does not select a package manager. The project owner has selected pnpm. This is a compatible refinement and does not require a specification change.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): Technology baseline; Dependency policy; Delivery and Repository Plan.
- [Architecture overview](../architecture/README.md)
- [Security policy](../../SECURITY.md)

## Decision drivers

- Reproducible installs and one committed lockfile.
- Workspace support for API, worker, and shared packages.
- A supported stable Node.js runtime compatible with all selected tooling.
- Explicit version and upgrade evidence rather than floating tags or implicit developer defaults.
- Minimal package-manager ambiguity in local development and CI.
- Supply-chain review and deterministic release artifacts.

## Considered options

### Option A: Node.js LTS, TypeScript, and pnpm workspaces

Use the current verified Node.js LTS at scaffolding time, TypeScript for application code, and pnpm as the only package manager. Commit one `pnpm-lock.yaml` and pin the package-manager/runtime versions consistently.

Selected for workspace ergonomics, deterministic installs, and explicit dependency sharing.

### Option B: npm workspaces

npm is distributed with Node.js and would reduce one tool bootstrap step. It is capable of workspaces and lockfile-based installs.

Rejected because the project owner selected pnpm and consistency is more valuable than supporting multiple equivalent package managers.

### Option C: Yarn workspaces

Yarn provides capable workspace and constraint features but introduces another version/runtime mode decision and lockfile format.

Rejected to avoid parallel package-manager policy.

### Option D: A non-LTS Node.js release or alternate JavaScript runtime

Current/non-LTS Node.js, Bun, or Deno could provide newer runtime features but would reduce the supported stability window or increase framework/tool compatibility risk.

Rejected for the baseline. Experimental tooling requires separate justification and cannot replace the supported Node.js LTS runtime without a superseding ADR.

## Decision

- Application and tooling code will use **TypeScript** on **Node.js LTS**.
- The baseline runtime at scaffolding will be the Node.js release officially designated LTS and verified as supported by the selected NestJS, Prisma, Testcontainers, TypeScript, test, and build versions at that time.
- **pnpm** is the only supported package manager for the repository.
- The repository will use a pnpm workspace and one committed `pnpm-lock.yaml`. npm and Yarn lockfiles are not permitted.
- Scaffolding must pin the exact Node.js and pnpm versions after verification. It must also pin exact direct dependency versions through the manifest/lockfile and pin image/workflow references according to repository security policy.
- CI and documented local commands must use frozen-lockfile installation and fail on lockfile drift.
- Version upgrades occur through focused pull requests with compatibility, migration, test, security, and release-note evidence. A major upgrade that changes architecture, contracts, financial behavior, or operational semantics requires a plan and, when material, an ADR.

This ADR selects policy, not numbers. Exact Node.js, pnpm, TypeScript, NestJS, Prisma, RabbitMQ client, Testcontainers, and test-tool versions are **To be decided and verified during scaffolding**.

## Consequences

### Positive

- One package manager and lockfile eliminate ambiguous install paths.
- pnpm workspaces support shared packages while preserving the two entrypoints.
- Verified LTS selection avoids stale version choices in governance documents.
- Exact pins and frozen installs make CI and local dependency graphs reviewable.

### Negative

- Contributors must install or activate the pinned pnpm version.
- Scaffolding cannot begin by blindly generating manifests; compatibility and support must be checked first.
- pnpm's dependency isolation can expose packages that relied on undeclared transitive dependencies.
- Upgrade pull requests carry deliberate verification overhead.

### Risks and mitigations

- **"Current" becomes stale:** Treat the exact runtime file and CI configuration, not this prose, as the selected version; update through review.
- **Toolchain incompatibility:** Verify the version matrix before first pin and every major upgrade.
- **Lockfile bypass:** Use frozen-lockfile CI and reject additional lockfiles.
- **Floating images/actions:** Pin digests or immutable references where supported and review automated updates.

## Implementation notes

- During scaffolding, record the verified Node.js version in one repository runtime-version mechanism and mirror it in manifest engine policy, CI, and container builds.
- Record the exact pnpm version in the package-manager metadata and use the same version locally and in CI.
- Generate and commit `pnpm-lock.yaml`; do not ignore it.
- Configure strict TypeScript checking for new code. Any compiler relaxation requires a documented reason and must not weaken money or authorization types.
- Use explicit workspace dependency declarations. Do not depend on undeclared transitive packages.
- Do not create manifests, runtime files, or lockfiles in this ADR milestone.

## Affected requirements and invariants

- **Requirements:** The tooling policy supports implementation and verification of FR-01 through FR-14 and the reproducibility release gate; it does not change their semantics.
- **Invariants:** No invariant is redefined. TypeScript types are defense in depth and do not replace PostgreSQL enforcement of INV-01 through INV-10.
- **Acceptance:** Fresh-clone setup and documented commands must be reproducible with the pinned versions.

## Impact assessment

- **Affected modules and dependency direction:** All future packages share one toolchain; no module dependency is authorized by this ADR.
- **Financial invariants and money representation:** TypeScript must model integer minor units/currency explicitly, but database constraints remain authoritative.
- **Database schema, migration, locking, and transaction boundaries:** No change.
- **Idempotency, outbox/inbox, retries, and partial failure:** No behavior change; future libraries must be checked for required semantics.
- **API, event, webhook, or CSV compatibility:** No contract change.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Dependency and secret scanning remain required.
- **Observability, alerting, and runbooks:** Tool versions must be included in reproducibility/diagnostic evidence where useful.
- **Production dependencies and supply-chain impact:** Establishes pinning, lockfile, review, and upgrade rules for all dependencies.

## Verification

Before scaffolding pins versions:

1. Verify the official Node.js LTS status and support window.
2. Verify compatibility among Node.js, NestJS, TypeScript, Prisma, Testcontainers, and build/test tools.
3. Confirm all selected releases are supported and stable.
4. Pin exact versions and immutable image/workflow references where applicable.
5. Run frozen-lockfile install, build, type-check, unit, integration, and security gates once those scripts exist.

## Rollout and recovery

This ADR creates no runtime artifacts. If a pinned toolchain later proves incompatible, revert the focused scaffolding/upgrade change or forward-fix to a verified supported set without changing financial data. A package-manager replacement requires a superseding ADR and coordinated lockfile/CI/documentation migration.

## Documentation and traceability

Index this ADR in [the ADR register](README.md). Scaffolding documentation must record verification sources, exact pins, supported platforms, upgrade procedure, and frozen install commands.
