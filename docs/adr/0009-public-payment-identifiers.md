# ADR-0009: Public Payment Intent identifiers

- **Status:** Accepted
- **Date:** 2026-08-01
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through the payment-request ADR acceptance review
- **Supersedes:** None
- **Superseded by:** None

## Context

The specification requires stable identifiers and illustrates Payment Intent IDs as `pi_01K...`. It does not explicitly declare the encoding. The current Merchant Access schema uses UUID primary keys, but those identifiers are not a precedent for a public payment resource. Choosing an identifier after exposing the endpoint would create an irreversible API and foreign-key migration.

The identifier must be opaque to merchants, safe in URLs/log fields, collision-resistant, immutable, and always used with an authenticated merchant predicate. It is not an authorization secret.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): mandatory delivery identifiers; Initial public API; event catalog; Appendix B samples and glossary.
- [Module boundaries](../architecture/module-boundaries.md)
- [Financial invariants](../architecture/financial-invariants.md)
- [Payment Request plan](../plans/2026-08-01-payment-request-domain.md)

## Decision drivers

- Match the documented `pi_...` public shape.
- Keep public and relational persistence concerns separate.
- Provide enough entropy for untrusted URL input.
- Preserve tenant isolation even if an ID is disclosed.
- Avoid sequential database IDs and ambiguous resource types.
- Make generation and collision recovery testable.

## Considered options

### Option A: Internal UUID plus public `pi_`-prefixed ULID

Use a UUID primary key for internal relations and an immutable unique `pi_<ULID>` public ID. Expose only the public ID in merchant APIs/events. This matches the sample and keeps database relations independent of a public encoding, at the cost of an additional unique column and generator policy.

### Option B: Expose the UUID primary key

This reuses the existing persistence convention and needs one identifier. It does not match the illustrated resource prefix and couples the public contract to internal keys.

### Option C: Sequential integer or encoded sequence

This is compact but leaks ordering/volume, is easy to enumerate, and is not represented in the specification. It is rejected.

### Option D: Treat IDs as secrets and omit merchant predicates

Opaque IDs are not authorization. This violates tenant-isolation requirements and is rejected.

## Decision

The decision is **Option A**.

- `payment_intents.id` is an internal UUID primary key used by PostgreSQL foreign keys and never accepted from or exposed to merchant API clients.
- `payment_intents.public_id` is immutable, non-null, globally unique `VARCHAR(29)` in the exact form `pi_` plus a 26-character uppercase Crockford Base32 ULID: `^pi_[0-9A-HJKMNP-TV-Z]{26}$`.
- The API field named `id`, route parameter `{id}`, events, problem targets, and operator-safe references use `public_id`.
- Generate the ULID application-side from the current UTC millisecond and cryptographically secure randomness. The exact generator implementation or dependency is **To be decided before code** and must pass monotonicity/entropy/clock and supply-chain review; no dependency is authorized by this ADR alone.
- The unique constraint is the final collision guard. A collision may trigger a small bounded ID-generation retry before any domain effect; exhaustion fails the command and creates no payment.
- Every merchant lookup/mutation predicates on both authenticated `merchant_id` and `public_id`. A foreign merchant and a nonexistent ID return the same not-found result.
- IDs are case-sensitive canonical uppercase. Input with lowercase, whitespace, wrong prefix, or invalid Crockford characters is rejected rather than normalized.
- IDs are not credentials and may appear only in approved structured log/correlation fields. Rate/resource controls and merchant authorization remain mandatory.

This decision treats the appendix shape as intentional, as approved by the project owner. A later change to the public identifier format requires a superseding ADR and compatibility/migration plan rather than support for two implicit formats.

## Consequences

### Positive

- Public IDs match the documented resource style and are recognizable by type.
- Internal foreign keys remain UUIDs and can evolve independently of URL syntax.
- Randomness and tenant predicates reduce enumeration impact.
- Future migrations can preserve public IDs even if internal storage changes.

### Negative

- Every payment row carries two identifiers and a unique index.
- Generation requires a carefully reviewed ULID implementation.
- ULID timestamp bits disclose approximate creation time; the value must not be treated as secret.

### Risks and mitigations

- **Clock regression or same-millisecond bursts:** Use a tested generator and unique constraint; test fixed/regressing clocks and concurrency.
- **ID enumeration:** Always include merchant ID in the database predicate and apply request controls.
- **Prefix/normalization drift:** Centralize parsing/formatting and publish contract vectors.
- **Dependency risk:** Prefer a reviewed minimal implementation or exact-pinned maintained package under ADR-0002 policy.

## Implementation notes

- Prisma maps `id` as UUID and `publicId` to `public_id`; API DTOs never expose the internal UUID.
- A unique `(merchant_id, public_id)` index is unnecessary if global `public_id` uniqueness and the primary query plan suffice; all SQL still includes merchant ID. Add indexes only from explain-plan evidence.
- Event IDs, request IDs, ledger IDs, and other prefixes require their own owning contract; this ADR does not standardize every resource.
- Do not seed deterministic production-like payment IDs outside controlled tests.

## Affected requirements and invariants

- **Requirements:** FR-02 and event/correlation identifier requirements.
- **Invariants:** INV-10 uses stable payment references; other financial invariants are unchanged.
- **Acceptance:** Format, uniqueness, collision, tenant-isolation, and API/event contract tests are required.

## Impact assessment

- **Affected modules and dependency direction:** Payments generates/owns IDs; API and Eventing consume the stable public value through ports/contracts.
- **Financial invariants and money representation:** No change.
- **Database schema, migration, locking, and transaction boundaries:** Adds an immutable unique public-ID column; generation occurs before the insert transaction.
- **Idempotency, outbox/inbox, retries, and partial failure:** A replay returns the original public ID; event payload uses the same ID.
- **API, event, webhook, or CSV compatibility:** Defines `{id}` and Payment Intent/event ID shape.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** ID is non-secret; tenant predicates remain the authorization control.
- **Observability, alerting, and runbooks:** Approved structured logs may include public payment ID without using it as a metric label.
- **Production dependencies and supply-chain impact:** Generator choice may add a dependency only after separate review and exact pinning.

## Verification

- Test exact accepted/rejected identifier vectors and no normalization.
- Generate high-volume/concurrent IDs under same, advancing, and regressing clocks; prove uniqueness.
- Force the collision path and prove bounded retry/no partial effect.
- Prove APIs/events never expose internal UUIDs.
- Prove every repository query includes merchant ID and cross-tenant probes return the same 404 as missing.
- Review migration indexes and query plans with real PostgreSQL.

## Rollout and recovery

Decide and migrate before the first Payment Intent exists. After public IDs are exposed, never regenerate them or switch formats in place; introduce a new major contract or a separately migrated alias through a superseding ADR. Failed generation creates no row or event.

## Documentation and traceability

Update the [ADR index](README.md), Payment Request plan, Prisma design, OpenAPI schemas/examples, event schema, logging classification, and identifier test vectors during implementation. This Accepted status records the project owner's interpretation of the appendix format.
