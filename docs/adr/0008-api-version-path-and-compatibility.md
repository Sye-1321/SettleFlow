# ADR-0008: API version path and compatibility

- **Status:** Proposed
- **Date:** 2026-08-01
- **Decision owners:** SettleFlow project owner and API owner (approval pending)
- **Reviewers:** Architecture and API contract reviewers (To be decided)
- **Supersedes:** None
- **Superseded by:** None

## Context

The specification defines `/v1` as the base path and lists Payment Intent routes at `/v1/payment-intents`. It requires a new major path or documented compatibility policy for breaking changes. The committed runnable foundation instead exposes one authenticated version probe at `GET /api/v1`; no payment endpoint or published public release exists.

Implementing payment routes without deciding this difference could create two route families, put examples and OpenAPI on the wrong path, or silently change an earlier repository contract. This ADR proposes alignment with the authoritative specification and records the compatibility consequence.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): Table 24 HTTP conventions; Table 25 Initial public API; Appendix B contract samples.
- [Architecture overview](../architecture/README.md)
- [Merchant Access API](../api/merchant-access.md)
- [Payment Request plan](../plans/2026-08-01-payment-request-domain.md)

## Decision drivers

- Match the authoritative public contract.
- Maintain one unambiguous versioning convention.
- Avoid permanent aliases before the first public release.
- Make breaking-change and deprecation policy explicit.
- Preserve unversioned operational endpoints where specified.

## Considered options

### Option A: Correct the pre-release API to `/v1`

Use `/v1` for all v1 business API routes, replace the scaffold-only `/api/v1` probe with `/v1`, and create no `/api/v1/payment-intents` alias. This aligns directly with the specification and avoids two permanent route families. It is a compatibility break for any undisclosed consumer of the current probe.

### Option B: Make `/v1` canonical and retain `/api/v1` temporarily

Add canonical `/v1` routes and keep only the existing version probe, or a complete route alias, under `/api/v1` for a documented deprecation window. This minimizes immediate breakage but doubles contract/testing/security surface and may establish an unintended long-term alias.

### Option C: Keep `/api/v1` canonical

This follows the current scaffold but contradicts the specification. It requires specification change control and is not selected.

## Decision

The proposed decision is **Option A**.

- `/v1` is the only canonical base path for v1 business endpoints.
- Payment Intent routes are exactly `POST /v1/payment-intents` and `GET /v1/payment-intents/{id}`.
- Health endpoints remain `/health/live` and `/health/ready`; documentation remains `/docs` and `/docs/openapi.json`. They are not placed under the business API version path.
- The scaffold-only `GET /api/v1` route is corrected to `GET /v1` in the later implementation milestone. No payment route is added below `/api/v1`.
- No compatibility alias is proposed because the repository is pre-release, the route has no payment behavior, and no external consumer is documented. Before acceptance, the project owner must confirm that no consumer requires `/api/v1`. If one exists, revise this ADR to Option B with an owner, removal date, complete OpenAPI treatment, and equivalent authentication/rate/security controls.
- Compatible additions remain under `/v1`. A breaking public contract requires `/v2` or an explicitly documented compatibility policy and a new ADR/plan where material.
- OpenAPI, examples, integration tests, generated clients, logs, metrics, and idempotency normalized routes use the canonical template, never an internal controller prefix.

This aligns the repository with the specification and does not require a specification version change. It remains Proposed until the compatibility assertion is approved.

## Consequences

### Positive

- The implementation, OpenAPI, examples, and idempotency scope share one path convention.
- No duplicate aliases or ambiguous metrics are created before release.
- The existing specification can remain unchanged.

### Negative

- Any unreported local client using `/api/v1` must update.
- Existing Merchant Access documentation and foundation tests will need a focused compatibility change during implementation.

### Risks and mitigations

- **Hidden consumer:** Require owner confirmation and repository/example search before acceptance.
- **Partial path migration:** Contract tests must assert the exact route inventory and absence of `/api/v1/payment-intents`.
- **Idempotency split by alias:** Use only `/v1/payment-intents` as the normalized route; do not expose an alias.

## Implementation notes

- Change paths only in the later approved implementation; this ADR creates no endpoint.
- Do not use a global `/api` prefix that transforms the documented contract implicitly.
- Treat reverse-proxy deployment prefixes as infrastructure routing, not part of the application API contract.
- Any temporary alias must be explicit in OpenAPI and telemetry and must not bypass the global Merchant Access guard.

## Affected requirements and invariants

- **Requirements:** FR-02 and all routes in Table 25; FR-05 depends on a stable normalized route; FR-13 depends on stable route/correlation telemetry.
- **Invariants:** INV-10 depends on canonical path scoping; other financial invariants are unchanged.
- **Acceptance:** Runtime/OpenAPI route parity and compatibility documentation are release gates.

## Impact assessment

- **Affected modules and dependency direction:** API adapter and documentation only; no domain ownership change.
- **Financial invariants and money representation:** No change.
- **Database schema, migration, locking, and transaction boundaries:** No change; normalized route values in future idempotency records use `/v1`.
- **Idempotency, outbox/inbox, retries, and partial failure:** Prevents equivalent commands being split across path aliases.
- **API, event, webhook, or CSV compatibility:** Defines the REST major-version convention and a pre-release correction.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Existing bearer authentication applies identically under `/v1`.
- **Observability, alerting, and runbooks:** Route templates and dashboards must use `/v1`.
- **Production dependencies and supply-chain impact:** None.

## Verification

- Search source, OpenAPI, tests, README, and examples for `/api/v1` before implementation.
- Assert exact runtime routes and committed OpenAPI paths.
- Prove health/docs remain at their unversioned locations.
- Prove no `/api/v1/payment-intents` route exists and authentication/scopes remain enforced.
- Run OpenAPI drift, integration, Markdown-link, and compatibility checks.

## Rollout and recovery

Before a public release, make the correction atomically with documentation and contract tests. If an actual consumer is discovered before acceptance, revise to Option B rather than shipping an undocumented alias. After a public release, path removal requires the documented major-version/deprecation process.

## Documentation and traceability

If accepted, update the [ADR index](README.md), Payment Request plan, Merchant Access API document, root README, committed OpenAPI, examples, and route tests. Record the owner's no-consumer confirmation.
