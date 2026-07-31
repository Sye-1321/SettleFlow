# ADR-NNNN: Decision title

- **Status:** Proposed
- **Date:** YYYY-MM-DD
- **Decision owners:** To be decided
- **Reviewers:** To be decided
- **Supersedes:** None
- **Superseded by:** None

## Context

Describe the current behavior, problem, constraints, and why a durable decision is needed. Cite the authoritative specification section and requirement/invariant IDs. State whether a specification version change is required.

## Decision drivers

- Financial correctness and invariant impact
- Security and tenant-isolation impact
- Reliability, retry, duplicate-delivery, and recovery behavior
- Module ownership and dependency direction
- Compatibility and migration risk
- Operational complexity and reviewability

Remove, add, or refine drivers to fit the decision.

## Considered options

### Option A: Name

Describe the design, transaction boundaries, data ownership, failure behavior, and trade-offs.

### Option B: Name

Describe the design, transaction boundaries, data ownership, failure behavior, and trade-offs.

Include retaining the current design when it is a viable option.

## Decision

State the selected option precisely. Mark any unresolved implementation detail **To be decided** and identify its deadline/owner.

## Consequences

### Positive

- Observable benefit.

### Negative

- Cost, limitation, or operational burden.

### Risks and mitigations

- Risk, trigger, mitigation, and owner.

## Impact assessment

- **Affected modules and dependency direction:**
- **Financial invariants and money representation:**
- **Database schema, migration, locking, and transaction boundaries:**
- **Idempotency, outbox/inbox, retries, and partial failure:**
- **API, event, webhook, or CSV compatibility:**
- **Authentication, authorization, secrets, SSRF, and sensitive data:**
- **Observability, alerting, and runbooks:**
- **Production dependencies and supply-chain impact:**

## Verification

List required unit, database, integration, contract, concurrency, failure-injection, security, migration, and performance evidence. Give executable commands when repository scripts exist.

## Rollout and recovery

Describe sequencing, compatibility window, feature controls if any, rollback limits, forward-fix strategy, and how financial/audit evidence remains intact.

## Documentation and traceability

List specification changes, implementation plans, architecture documents, contracts, runbooks, and follow-up issues that must be updated.
