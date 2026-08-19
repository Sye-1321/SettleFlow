# Versioning, Compatibility, and Support

## Artifact and API versions

SettleFlow uses [Semantic Versioning](https://semver.org/) for source and OCI releases:

- **major:** incompatible public contract, persisted-data, or supported-operation change requiring an approved compatibility plan;
- **minor:** backward-compatible capability or contract addition; and
- **patch:** backward-compatible correction, security fix, documentation, or operational hardening.

The HTTP major path is independently `/v1`. Artifact `v1.0.1` or `v1.1.0` does not change `GET /v1` to return artifact SemVer. Runtime release version/commit appear only in OCI labels, startup telemetry, and bounded internal metrics. A breaking HTTP change requires a new major path or an accepted compatibility decision.

Event types include their schema version, such as `payment.captured.v1`. A new required field or incompatible semantic change requires a new event version and a reviewed producer/relay/consumer rollout. Existing `v1` event bodies and Webhook exact bytes are not silently changed.

## Supported versions

There is no stable release yet.

| Line                                        | Status                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `main` before `v1.0.0`                      | Best-effort pre-release investigation; no compatibility or production-support promise                                 |
| Latest released `v1` minor/patch            | Supported under the public [security response targets](../../SECURITY.md#supported-versions-and-response-commitments) |
| Older, untagged, or locally modified images | Unsupported                                                                                                           |

The first stable line will support only its latest v1 minor/patch. There is no 24x7 monitoring, SLA, backup maintainer, deployment service, or support for processing real funds. `@Sye-1321` is the sole maintainer, Security Owner, Incident Commander, disclosure authority, and release stop/go authority.

## Release-candidate and publication policy

- `v1.0.0-rc.1` is a private-image clean-room candidate after all technical gates; it is not a stable compatibility promise.
- Public GHCR images are deferred until the exact candidate digests pass clean-room verification and the owner approves `v1.0.0`.
- Approved public names are `ghcr.io/sye-1321/settleflow-api:v1.0.0` and `ghcr.io/sye-1321/settleflow-worker:v1.0.0`.
- The migrator is validated as a release-simulation image but is not an approved public GHCR artifact in the first-release policy.
- Publication promotes the digest-tested image; rebuilding under the same version is prohibited.
- Release evidence includes checksums, SPDX SBOMs, verified provenance/attestation where supported, OpenAPI/event schemas, a sanitized verification summary, release notes, and known limitations.

## Compatibility commitments

- PostgreSQL migrations are forward-only, committed, ordered, and run once before API/worker readiness.
- The initial release has no prior public-version upgrade path. Beginning with `v1.0.1`, CI and release review must maintain and exercise the prior-public-version fixture.
- Shared-schema rollout must preserve API/worker compatibility; destructive changes use expand-migrate-contract.
- Posted Ledger, audit, Settlement, Webhook-attempt, and Reconciliation evidence is not rewritten for compatibility.
- Corrections use a controlled forward fix or exact Ledger reversal, never a reissued mutable artifact or direct financial row edit.

## End of support and security fixes

Support moves with the latest v1 minor/patch. A superseded version may be withdrawn when a confirmed critical issue requires it. The owner targets a critical fix/advisory within seven calendar days, high within 30 days, medium within 90 days, and low in a planned release; these are simulation-maintenance targets, not an operational SLA.

Report vulnerabilities privately through the [security policy](../../SECURITY.md). Feature requests and non-sensitive defects may use public issues after removing credentials, personal data, raw financial payloads, CSV rows, and environment details.
