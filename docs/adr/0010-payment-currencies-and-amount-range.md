# ADR-0010: Payment currencies and amount range

- **Status:** Accepted
- **Date:** 2026-08-01
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through payment-request ADR acceptance review
- **Supersedes:** None
- **Superseded by:** None

## Context

FR-02 requires Payment Intents in integer minor units and supported currencies. The specification requires PostgreSQL `BIGINT`, an uppercase three-letter currency per payment, overflow rejection, no decimal amount field, and no currency mixing. OQ-01 asks which currencies demo fixtures enable before M1 and provides ETB and USD with no conversion as the default if unanswered.

PostgreSQL signed `BIGINT` can represent values above JavaScript's exact integer range. Exposing that entire range as a JSON number would allow silent rounding before validation or serialization. A public range and an allow-list must be fixed before the schema and OpenAPI are created.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): Assumptions and constraints; Money representation; FR-02; Tables 21 and 24; OQ-01; Appendix B.
- [ADR-0003](0003-postgresql-prisma-and-financial-data-access.md)
- [Financial invariants](../architecture/financial-invariants.md)
- [Payment Request plan](../plans/2026-08-01-payment-request-domain.md)

## Decision drivers

- Exact round trips through JSON, TypeScript, Prisma, and PostgreSQL.
- Database enforcement of positive bounded values and allowed currencies.
- No binary floating-point arithmetic or major-unit decimal input.
- Deterministic idempotency fingerprints and event payloads.
- A finite v1 demo scope with no FX behavior.

## Considered options

### Option A: JSON-safe integer range with ETB/USD allow-list

Accept positive JSON integers through `Number.MAX_SAFE_INTEGER`, store as `BIGINT`, and allow only ETB and USD. Enforce both the range and allow-list in application validation and database constraints. This follows OQ-01's default and preserves exact JSON-number behavior.

### Option B: Full PostgreSQL `BIGINT` exposed as a decimal string

This preserves the database range but changes the specification's `amountMinor: integer` contract to a string. It requires specification change control and is not selected.

### Option C: Decimal major-unit amount

This contradicts the no-decimal-field and integer-minor-unit rules and is rejected.

### Option D: Any three-letter currency accepted dynamically

Syntax alone would not establish “supported currencies” and could admit currencies the demo cannot process consistently. It is rejected for v1.

## Decision

The decision is **Option A**.

- The v1 Payment Intent currency allow-list is exactly `ETB` and `USD`, applying OQ-01's documented default. No conversion, exchange rate, cross-currency aggregation, or dynamic currency administration exists.
- Request `amountMinor` is a JSON number that must decode to an integer in the inclusive range `1..9,007,199,254,740,991` (`Number.MAX_SAFE_INTEGER`). Reject zero, negatives, fractions, non-finite runtime values, strings, booleans, null, and values outside the safe range before persistence.
- Persist Payment Intent `amount_minor` and its captured/refunded projections as PostgreSQL signed `BIGINT` with field-specific positive/non-negative and upper-bound checks. Application code converts a validated safe integer to `bigint` explicitly and proves the value remains in range before converting back for JSON. Later domains must preserve the global `BIGINT` minor-unit rules and separately document any narrower public range they expose.
- Persist currency as an uppercase three-character value. Enforce both `^[A-Z]{3}$` and `currency IN ('ETB', 'USD')` in the Payment Intent table; application validation provides the earlier problem response.
- Reject lowercase or surrounding whitespace rather than normalizing. The accepted representation is part of the canonical idempotency fingerprint.
- Each Payment Intent has one immutable requested currency. Later ledger transactions, events, refunds, and settlement records must carry and match it according to their invariants.
- API and event contracts describe amounts as integer minor units. No code infers a decimal exponent, formats major units, rounds, or performs FX.

Project-owner approval resolves OQ-01 to its documented fallback: ETB and USD with no conversion. A different currency set or amount representation requires a superseding ADR and public-contract compatibility review.

## Consequences

### Positive

- Every accepted API amount round-trips exactly through JavaScript JSON.
- PostgreSQL remains authoritative and independently rejects invalid money rows.
- ETB/USD fixtures are deterministic and require no conversion engine.
- Canonical fingerprints cannot vary through case or numeric rounding.

### Negative

- The public range is smaller than PostgreSQL `BIGINT`.
- Adding a currency requires a reviewed validation/constraint migration and contract update.
- Very large but valid PostgreSQL amounts cannot enter through v1 JSON.

### Risks and mitigations

- **JSON parser rounds before validation:** Require `Number.isSafeInteger` and upper/lower checks immediately after parsing; test boundary tokens.
- **Unsafe `bigint` serialization:** Map through an explicit checked domain/API converter; never pass Prisma `bigint` directly to `JSON.stringify`.
- **Allow-list drift:** Define one domain constant and mirror it in named database checks and OpenAPI enum tests.
- **Currency mixing later:** Keep currency on every financial record and preserve database/transaction checks.

## Implementation notes

- The exact PostgreSQL column may use `BIGINT`/Prisma `BigInt`; `amount_minor > 0` and `amount_minor <= 9007199254740991` are named checks.
- Captured/refunded projections initialize to zero and have non-negative/upper-bound checks; they are not mutated in the create/read slice.
- Unsupported currency is a semantic problem response defined by ADR-0013; malformed amount/type is an invalid request.
- Test fixtures include both currencies separately and never sum them together.

## Affected requirements and invariants

- **Requirements:** FR-02 directly; FR-03, FR-04, FR-06, FR-11, and FR-12 later inherit the representation.
- **Invariants:** INV-01, INV-03, INV-04, INV-07, and INV-09 rely on exact amounts/currency; no invariant is weakened.
- **Acceptance:** Boundary, overflow, database-check, currency-mismatch, serialization, and cross-currency negative tests are required.

## Impact assessment

- **Affected modules and dependency direction:** Payments owns validation; later modules consume typed amount/currency values through ports.
- **Financial invariants and money representation:** Defines the v1 API range and OQ-01 allow-list while preserving `BIGINT` minor units.
- **Database schema, migration, locking, and transaction boundaries:** Requires named range/currency checks; no transaction change.
- **Idempotency, outbox/inbox, retries, and partial failure:** Canonical fingerprints and events use the exact accepted integer/currency.
- **API, event, webhook, or CSV compatibility:** Defines OpenAPI integer maximum and currency enum; later contracts must match.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** No change; raw financial bodies remain prohibited from logs.
- **Observability, alerting, and runbooks:** Metrics must not use raw amount as a label or expose bodies.
- **Production dependencies and supply-chain impact:** None.

## Verification

- Test `1`, both safe-range edges, zero, negative, fraction, unsafe integer, string, and malformed JSON cases.
- Prove Prisma/PostgreSQL round trips exactly and JSON serialization never receives an unchecked `bigint`.
- Test ETB/USD acceptance plus lowercase, whitespace, unsupported, malformed, and direct-SQL constraint failures.
- Test idempotency fingerprints for numeric/currency boundary inputs.
- Run migration-from-empty/prior and inspect named checks with real PostgreSQL.

## Rollout and recovery

Apply the constraints before exposing Payment Intent creation. Invalid preexisting payment data cannot exist in the current repository. After public release, widening the allow-list/range is additive only after contract and downstream review; changing the representation requires a new major path or approved compatibility policy.

## Documentation and traceability

The [ADR index](README.md) records acceptance and explicit OQ-01 owner approval. Update the Payment Request plan, Prisma/migration notes, OpenAPI schemas/examples, fixture documentation, and money test vectors during implementation.
