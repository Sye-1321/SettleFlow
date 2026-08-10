# Continuous Integration and Supply-Chain Evidence

SettleFlow uses three GitHub Actions workflows as executable release evidence for a public finance-grade simulation. They do not deploy, publish images or packages, create tags, or receive production credentials. Repository settings, required-check selection, Private Vulnerability Reporting, and branch protection remain owner-controlled GitHub configuration and are not changed by these files.

## Workflow contract

| Workflow                    | Triggers                                               | Purpose                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI`                        | pull request, push to `main`, manual                   | Frozen installation; repository policy; formatting; lint; type-check; build; unit, coverage, integration, migration, configuration, boundary, OpenAPI, event/API contract, and docs gates |
| `Security and supply chain` | pull request, push to `main`, Monday 03:41 UTC, manual | Dependency review, CodeQL, secret/history scan, dependency audit, license evidence, workflow policy, OCI build/inspection/scanning, SPDX SBOMs, and bounded release evidence              |
| `Reliability evidence`      | push to `main`, daily 02:17 UTC, manual                | Three independent financial/asynchronous race runs plus dependency, lease, poison-message, and Webhook failure evidence; a failure is not retried to green                                |

Superseded pull-request CI/security runs are canceled. Scheduled reliability runs serialize without canceling an active run. Job timeouts range from 15 to 120 minutes. No workflow uses `pull_request_target`, imports repository secrets, persists checkout credentials, suppresses failed commands, or grants a workflow-wide write permission.

The default token is `contents: read`. Only the CodeQL job adds `security-events: write` (and read-only package access). Only the `main` provenance job adds `id-token: write` and `attestations: write`. Pull-request image builds therefore run on an ephemeral hosted runner without release credentials or a writable repository token.

All GitHub actions are full-commit pinned with their exact release in an adjacent comment:

| Action                             | Release | Commit                                     |
| ---------------------------------- | ------- | ------------------------------------------ |
| `actions/checkout`                 | 7.0.1   | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node`               | 7.0.0   | `820762786026740c76f36085b0efc47a31fe5020` |
| `actions/upload-artifact`          | 7.0.1   | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `actions/download-artifact`        | 8.0.1   | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |
| `actions/dependency-review-action` | 5.0.0   | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` |
| `github/codeql-action`             | 4.37.6  | `5595ccaf912efad79be6eef63a5619ff05969be3` |
| `actions/attest`                   | 4.2.2   | `1e69f48acb82d1966a394da916b4c1698aa569d6` |

Dependabot proposes weekly pnpm, GitHub Actions, and Docker updates. Only compatible development-tool minor/patch updates are grouped; nothing auto-merges.

## Local source of truth

Run the same repository commands before opening a pull request:

```shell
corepack pnpm install --frozen-lockfile
pnpm security:policy
pnpm security:secrets
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration
pnpm test:coverage
pnpm boundaries:check
pnpm contracts:check
pnpm openapi:check
pnpm config:check
pnpm telemetry:check
pnpm docs:check
```

The Docker-backed security path additionally requires the ignored release-simulation configuration and locally built Step 5 images:

```shell
pnpm release:config:create
pnpm release:compose:check
pnpm clean
pnpm images:build
pnpm images:validate
pnpm security:dockerfile
pnpm images:scan
pnpm images:sbom
pnpm release:evidence
```

Gitleaks 8.30.1, Hadolint 2.15.1, Trivy 0.73.0, and Syft 1.50.0 run from version-and-digest-pinned containers declared in `tools/security/tool-images.json`. Gitleaks redacts findings. Trivy blocks critical and unreviewed high package or filesystem-secret findings across API, worker, and migrator images. The dependency audit applies the same severity policy; critical findings cannot be excepted. Final runtime stages use the digest-pinned distroless Node.js 24 Debian 13 image, which contains no npm, Corepack, Yarn, shell, or package manager; build tooling remains confined to the separate pinned toolchain stage.

Gitleaks ignores are exact historical fingerprints, never path/rule wildcards. Every ignored fingerprint must have a matching bounded false-positive classification in `security/gitleaks-reviews.json`; repository policy fails if either side changes. The current two entries cover a synthetic integration-test idempotency value and security-prohibition prose, not usable credentials.

`security/exceptions.json` is the sole high-finding exception registry. Every future entry must identify the tool, finding, artifact, rationale, compensating controls, owner, approver, approval time, and an expiry no more than 30 days later. Expired, malformed, duplicate, critical, or unapproved exceptions fail locally and in CI. `security/license-reviews.json` records only evidence-backed license conclusions; it is not a vulnerability waiver.

## Artifacts and attestations

Coverage diagnostics are retained for 7 days. Image evidence is retained for 14 days and contains only three SPDX JSON SBOMs plus a bounded manifest of image IDs, OCI labels, runtime identity/command/health metadata, source revision, exact scanner images, and SBOM hashes. Image archives, generated configuration, environment values, scanner caches, raw logs, and database/broker data are never uploaded.

On a push to `main`, GitHub signs provenance for the downloaded evidence files through its short-lived OIDC identity and attestation service. The job does not push the application images or attest to a registry reference. Public GHCR publication remains gated on the later clean-room `v1.0.0` release simulation.

## GitHub prerequisites and local gate status

No repository secrets or Actions variables are required. GitHub-hosted Ubuntu 24.04 runners need Docker, outbound package/advisory/scanner-database access, dependency graph support for Dependency Review, code-scanning upload support for CodeQL, and artifact-attestation support for the main-branch provenance job. These GitHub services cannot be proven locally; the first remote workflow run must validate them before required-check configuration.

The approved coverage floors remain unchanged. The Step 7 run records 91.46% statements, 84.71% branches, 91.80% functions, and 92.13% lines globally against the 85/80/80/85 floors. Eventing, Idempotency, Ledger, Payments, Reconciliation, Settlements, and Webhooks each also clear their 90% statements/lines and 85% branches/functions floors. Coverage is assembled from one unit shard and isolated real-dependency integration shards using compatible raw Istanbul maps; every shard must pass before the merged report is accepted.

The runtime image gate now passes without an exception or suppression. Trivy 0.73.0 reports zero critical and zero high package findings and zero filesystem-secret findings for each rebuilt API, worker, and migrator image. The build stage remains the exact Node.js 24.18.0 Trixie-slim digest with pinned OpenSSL packages; only the minimal final runtime changed to the exact distroless Node.js 24 Debian 13 digest.

Use the [CI and security gate failure runbook](../runbooks/ci-security-gate-failure.md) for safe triage. OCI runtime details remain in [OCI Images and Release Simulation](release-simulation.md).
