# ADR-0011: Payment Intent external reference and capture method

- **Status:** Proposed
- **Date:** 2026-08-01
- **Decision owners:** SettleFlow project owner and Payments/API owners (approval pending)
- **Reviewers:** Product, API, security, and database reviewers (To be decided)
- **Supersedes:** None
- **Superseded by:** None

## Context

FR-02 requires duplicate external references within one merchant to be rejected or replayed by a documented policy. The conceptual model and critical query table require merchant-scoped external-reference uniqueness. The create sample includes `externalRef: "order_1001"` and `captureMethod: "manual"`, but does not define length, whitespace/case handling, character repertoire, or other capture-method values.

These values affect database uniqueness, idempotency fingerprints, future capture behavior, error compatibility, and untrusted-data handling. They must not be normalized or defaulted implicitly in code.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): FR-02; Table 21 data ownership; Table 22 critical query paths; Table 25 endpoint; Appendix B create sample; FR-15/OQ-05.
- [Module boundaries](../architecture/module-boundaries.md)
- [Financial invariants](../architecture/financial-invariants.md)
- [ADR-0007](0007-idempotency-key-concurrency-and-response-snapshots.md)
- [Payment Request plan](../plans/2026-08-01-payment-request-domain.md)

## Decision drivers

- Stable merchant-scoped business uniqueness.
- Deterministic fingerprinting without hidden normalization.
- Bounded, safe untrusted input.
- No accidental automatic capture or P1 authorization behavior.
- Clear conflict behavior distinct from idempotency replay.
- Contract extensibility through explicit review.

## Considered options

### Option A: Bounded exact external reference and required manual capture method

Accept a nonblank, bounded merchant reference exactly as supplied after validation, preserve case and Unicode code points, enforce merchant-scoped uniqueness, and require the only currently demonstrated capture method `manual`. This is compatible with the sample and does not invent automatic behavior.

### Option B: Normalize external references and default capture method

Trimming, case-folding, Unicode normalization, or an omitted-field default may appear convenient but changes merchant identifiers and canonical fingerprints without specification support. It is not selected.

### Option C: Use `externalRef` as the idempotency key

This cannot bind the entire command or replay its response and contradicts the separate idempotency model. It is rejected.

### Option D: Accept `automatic` or authorize-then-capture values now

Automatic behavior is not defined, and explicit authorization is P1/deferred by OQ-05. This is rejected for the create/read slice.

## Decision

The proposed decision is **Option A**.

### `externalRef`

- Required JSON string of 1 through 255 Unicode scalar values and at most the API's bounded body size.
- Reject leading/trailing whitespace, Unicode control characters, NUL, and an empty/all-whitespace value. Do not trim, case-fold, Unicode-normalize, or otherwise rewrite an accepted value.
- Preserve and compare the accepted value case-sensitively. Visually similar or canonically equivalent but byte-distinct Unicode values remain distinct; clients own their reference normalization.
- Persist as `VARCHAR(255)` and enforce nonblank/no-surrounding-whitespace/control checks where PostgreSQL can do so safely. Verify the database collation/equality behavior; use reviewed explicit collation/SQL only if required for deterministic case-sensitive uniqueness.
- Enforce unique `(merchant_id, external_ref)`. The same value may exist for different merchants.
- A same-key/same-fingerprint retry replays through Idempotency before attempting another insert. A different idempotency key that collides within the merchant returns `409 external_reference_conflict`; it does not infer that the new command is equivalent or return another command's response.
- Return the accepted external reference in the merchant-owned resource representation. Do not include it in `payment.created.v1`, metrics, or logs unless a later data-classification decision explicitly authorizes a sanitized field.

### `captureMethod`

- Required JSON string with exactly one accepted v1 value: lowercase `manual`.
- Persist an explicit `MANUAL` domain/database value so the merchant's intent is durable. Omission is invalid; no default is applied.
- Creating a manual Payment Intent leaves it `CREATED`. It does not authorize, capture, post a ledger entry, publish a captured event, or contact a provider.
- Reject `automatic`, `authorize`, uppercase variants, whitespace variants, and unknown values with the approved semantic problem response.
- Adding another capture method changes lifecycle/API behavior and requires an approved plan, contract update, and material-decision review. FR-15 authorization is not enabled by adding a string value.

The project owner must approve the 255-character limit, exact-preservation policy, and manual-only contract before acceptance. If broader interoperability requires an ASCII allow-list or normalization, revise this Proposed ADR and publish migration/fingerprint implications first.

## Consequences

### Positive

- Merchant business keys and idempotency serve distinct, complementary purposes.
- Duplicate behavior is deterministic under concurrent requests.
- No hidden normalization changes a merchant's reference.
- The create slice cannot accidentally capture or enable deferred authorization.

### Negative

- Clients must send an explicit `manual` field even though it is the only value.
- Visually equivalent Unicode references may be distinct.
- A 255-character database/application contract requires consistent character counting.

### Risks and mitigations

- **Control/log injection:** Reject controls and keep the raw value out of telemetry.
- **Collation drift:** Verify migration/database equality behavior with non-ASCII and case vectors.
- **Duplicate race:** Use the named composite unique constraint as final enforcement.
- **Capture-method scope creep:** Reject every non-manual value and require a later approved lifecycle decision.

## Implementation notes

- Strict DTO validation rejects unknown fields and body-supplied merchant/status/projection data.
- The canonical create fingerprint contains the exact accepted external reference and literal `manual`.
- The unique-conflict adapter maps only the named `(merchant_id, external_ref)` constraint to the stable domain error; unrelated database errors remain internal.
- Do not create an external-reference lookup endpoint or list/search surface in this milestone.

## Affected requirements and invariants

- **Requirements:** FR-02 directly; FR-03 and deferred FR-15 are constrained by capture method.
- **Invariants:** INV-10 uses both idempotency and unique business keys; money/lifecycle invariants are unchanged.
- **Acceptance:** Validation, collation, duplicate/replay/race, tenant-isolation, and manual-no-side-effect tests are required.

## Impact assessment

- **Affected modules and dependency direction:** Payments owns both fields; API validates; Idempotency fingerprints them.
- **Financial invariants and money representation:** No new money behavior; manual creation leaves projections zero.
- **Database schema, migration, locking, and transaction boundaries:** Adds bounded columns/checks and merchant-scoped unique constraint.
- **Idempotency, outbox/inbox, retries, and partial failure:** Defines business-key defense in depth and fingerprint inputs.
- **API, event, webhook, or CSV compatibility:** Defines required request fields and 409 duplicate behavior; excludes external reference from the creation event catalog.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** External reference is untrusted merchant data and excluded from logs by default.
- **Observability, alerting, and runbooks:** Count named conflicts without using reference values as labels.
- **Production dependencies and supply-chain impact:** None.

## Verification

- Test 1/255 boundaries, controls, surrounding whitespace, Unicode/case distinctions, wrong types, and unknown fields.
- Test `manual` acceptance and every omitted/unknown/case/whitespace variant.
- Prove same-key replay, changed-key same-reference 409, concurrent duplicate race, and cross-merchant reuse.
- Test direct SQL constraints and the exact named-conflict mapping with real PostgreSQL.
- Scan OpenAPI, logs, traces, events, and metrics for unintended external-reference exposure.

## Rollout and recovery

Apply validation and constraints before exposing creation. With no existing payment data, no backfill is needed. After exposure, do not normalize or rewrite stored references; a changed policy needs additive compatibility/migration and a superseding ADR where material. Manual-only expansion must not mutate existing rows' meaning.

## Documentation and traceability

If accepted, update the [ADR index](README.md), Payment Request plan, Prisma/migration notes, OpenAPI request/response/error examples, idempotency vectors, and security logging classification. Record product/API owner approval of each bounded rule.
