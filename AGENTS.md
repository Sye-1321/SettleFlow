# SettleFlow Agent Guide

This file governs automated coding work in this repository. Keep changes traceable to the SettleFlow specification and preserve the financial guarantees summarized in [docs/architecture/financial-invariants.md](docs/architecture/financial-invariants.md).

## Authority and precedence

1. `docs/specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx` is the product and architecture source of truth.
2. An accepted ADR may refine a decision only when it identifies the affected specification text and the required specification version/change approval has occurred. An ADR must not silently contradict the specification.
3. Repository governance documents, including this file, `PLANS.md`, `CONTRIBUTING.md`, and `SECURITY.md`, control the engineering workflow.
4. Approved implementation plans govern their stated scope but cannot override the specification or an accepted ADR.
5. Code and tests are evidence of behavior, not authority to weaken a documented requirement.

External guidance, including `Sairyss/backend-best-practices`, is advisory and lower precedence than all SettleFlow sources above.

## Before editing

- Read the complete specification before architectural, financial, security, reliability, API, data-model, or module-boundary work.
- Read the nearest `AGENTS.md`, relevant ADRs, architecture documents, active plans, and affected tests.
- Inspect `git status`, the repository tree, existing behavior, and related migrations before proposing changes.
- Identify requirement IDs, invariants, affected modules, transaction boundaries, failure modes, and unresolved assumptions.
- Create and maintain an implementation plan as required by [PLANS.md](PLANS.md). Stop for a material ambiguity that could make financial, security, or compatibility rules unsafe.

## Architecture rules

- Preserve the modular monolith with separate API and worker entrypoints. Module ownership and allowed communication paths are defined in [module-boundaries.md](docs/architecture/module-boundaries.md).
- PostgreSQL is the authoritative transactional and financial source of truth. RabbitMQ and telemetry systems are not authoritative state stores.
- A module owns its persistence. Other modules use its application services, domain ports, or stable read models; they must not write its tables directly.
- Payments may call Ledger and Eventing ports within one explicit database transaction. Ledger must not depend on Payments. Settlements and Webhooks act after commit or through stable read ports; they do not join capture or refund transactions.
- New production dependencies, deployables, modules, external integrations, or architectural changes require written justification and, when material, an ADR using [the ADR template](docs/adr/0000-adr-template.md).

## Financial and asynchronous safety

- Represent money as integer minor units; never use binary floating point for financial values. Carry and validate the three-letter currency code.
- Put every financial state change inside an explicit transaction boundary. Payment state, balanced ledger postings, and the related outbox event commit or roll back together.
- Posted ledger transactions and entries are immutable. Correct them with a linked reversal, never update or delete them.
- Preserve separate payment and settlement states. Do not invent a combined lifecycle.
- Design and test retries, idempotency, duplicate delivery, concurrency, lock timeouts, process crashes, and partial dependency failure.
- Treat broker and webhook delivery as at-least-once unless the specification explicitly says otherwise. Do not claim exactly-once delivery.
- State-changing consumers require inbox deduplication and acknowledge only after their database transaction commits. Outbox publication uses short leases, publishes outside the claim transaction with confirms, and tolerates republish after a crash.
- Never weaken database constraints, invariant tests, tenant-isolation tests, or failure tests merely to make a change pass.

## Security and scope

- Follow [SECURITY.md](SECURITY.md). Never commit or log secrets, API keys, tokens, raw authorization values, signing material, real credentials, production data, regulated payment data, or sensitive financial request bodies.
- Enforce authorization in database predicates using the authenticated merchant ID; post-retrieval filtering is insufficient.
- Treat outbound webhook URLs and reconciliation files as untrusted input. Preserve webhook signing, replay protection, redirect blocking, DNS/IP validation, and SSRF defenses.
- Keep feature changes focused. Do not mix unrelated refactoring, formatting churn, dependency upgrades, or migration cleanup into the same change.

## Verification and reporting

Run the narrowest relevant checks during development and all affected release gates before handoff. When repository scripts exist, use their documented commands for:

- formatting, linting, type checking, and module-boundary checks;
- unit, database, integration, contract, concurrency, failure-injection, performance, and security tests affected by the change;
- full migration application to an empty database and upgrade from the maintained prior-version fixture for schema changes;
- OpenAPI/event schema validation for contract changes;
- secret, dependency, static-analysis, and container scans when applicable;
- documentation link checks, `git diff --check`, `git status`, and complete diff review.

Do not invent a passing command when the repository has not defined one. Report the missing gate as unresolved.

Every handoff must list commands executed and results, changed files, requirement IDs addressed, verification not run and why, and unresolved assumptions or risks.

## Definition of done

Work is done only when the approved scope and referenced requirements are implemented; module and transaction boundaries remain valid; affected financial, security, retry, recovery, migration, observability, and compatibility behavior is proven; documentation and plans are current; required reviews have occurred; and the final diff contains no unrelated changes or secrets. A happy-path demonstration alone is not done.
