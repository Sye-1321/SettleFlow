# Module Boundaries

This document extracts the modular-monolith boundaries from the SettleFlow specification. It does not authorize additional modules, cross-module persistence access, or microservice decomposition.

## Runtime call direction

`API/worker entrypoint -> module application service -> domain port -> infrastructure adapter`

Entrypoints compose modules but do not contain financial business rules. Infrastructure adapters implement ports for PostgreSQL/Prisma/raw SQL, RabbitMQ, outbound HTTP, cryptography, clocks, identifiers, and telemetry. Adapters must not reverse the dependency direction into another module's internals.

## Ownership

| Module | Owns | Permitted collaboration |
| --- | --- | --- |
| Merchant Access | `merchants`, `api_keys`, scopes | Authenticates merchant requests and supplies merchant identity/scopes to application services. Publishes lifecycle events after commit. |
| Payments | `payment_intents`, `refunds`, payment transitions | Calls Ledger and Eventing application ports in the same explicit transaction. Exposes stable queries/read ports to authorized consumers. |
| Ledger | `ledger_accounts`, `ledger_transactions`, `ledger_entries` | Accepts posting/reversal commands through its application port. Must not depend on Payments. |
| Idempotency | `idempotency_keys`, fingerprints, command ownership, response snapshots | Orchestrates single-winner acquisition and replay for money-mutating POST commands. Does not publish a public business event. |
| Eventing | `outbox_events`, `inbox_messages`, publish leases | Persists outbox rows inside producer transactions; relays committed events; deduplicates state-changing consumers. |
| Webhooks | endpoints, deliveries, attempts, signing metadata | Reacts to committed events and owns outbound delivery/replay. Must not participate in capture/refund transactions. |
| Settlements | batches, batch items, adjustments | Reacts to committed capture/refund events or uses stable read ports; claims eligible payments without writing Payments tables. |
| Reconciliation | imports, provider rows, results | Owns staging, matching, classification, and reports for untrusted provider CSV input. Reads platform records through stable ports/read models. |
| Operations | `audit_events`, health, metrics, replay commands | Records append-only privileged actions and exposes bounded operational controls; must not patch financial rows. |

## Persistence rules

- Each table has one owning module. Only that module's persistence adapter writes it.
- A module needing another module's behavior calls an application/domain port. A module needing query data uses a stable, tenant-scoped read port or read model.
- Shared PostgreSQL transactions are explicit and limited to required synchronous invariants. Payments may coordinate Ledger and Eventing so domain state, ledger postings, and the outbox event commit or roll back together.
- Cross-module foreign keys may enforce integrity, but a foreign key does not grant write ownership.
- Direct Prisma client or raw SQL imports across module boundaries are prohibited. Raw SQL is parameterized, reviewed, and confined to the owning infrastructure adapter.
- Database migrations must preserve ownership and be reviewed with every affected module. Triggers and constraints are part of the owning contract, not bypassable implementation detail.
- The worker must call module services; it must not mutate tables ad hoc.
- CI must enforce declared package/dependency boundaries once packages exist.

## Allowed communication paths

- Merchant Access supplies authenticated merchant context to API handlers; every merchant-owned database predicate includes that merchant ID.
- Payments -> Ledger and Payments -> Eventing are allowed inside the capture/refund transaction through stable ports.
- Ledger has no dependency on Payments. It receives business references without importing payment internals.
- Eventing's relay publishes committed outbox events to RabbitMQ. Publication occurs outside the short claim transaction.
- Webhooks and Settlements consume committed events through inbox-protected handlers or call stable read ports. They never join the originating capture/refund transaction.
- Reconciliation reads authorized platform records through defined ports/read models and writes only its staging/results data.
- Operations invokes explicit replay/run commands, subject to separate operator authentication, authorization, reason capture, and append-only audit.

Any proposed reverse dependency, circular dependency, direct cross-module write, new shared table, or new synchronous network dependency requires design review and normally an ADR.

## Payment and settlement separation

Payments owns the customer-facing payment lifecycle. Settlements owns batching, settlement progress, and post-settlement adjustments. A captured or refunded payment projection must not be overwritten to encode settlement progress. A post-settlement refund changes the payment's refunded projection and creates a future settlement adjustment; it does not invent a combined payment/settlement state.

## Eventing and delivery boundaries

### Transactional outbox

The producer inserts its event into `outbox_events` in the same PostgreSQL transaction as the state change. The relay claims a bounded batch in a short transaction using lease fields and `FOR UPDATE SKIP LOCKED`, commits the lease, publishes through a RabbitMQ confirm channel, then marks confirmed rows published. It never holds row locks during broker I/O. Lease expiry permits reclamation, so publication may repeat.

### Consumer inbox

Every state-changing consumer reserves/detects `(consumer_name, message_id)` through Eventing's inbox mechanism. Its domain effect and completed inbox state commit atomically. Acknowledgement occurs only after commit. Redelivery of a completed message is a no-op followed by acknowledgement.

### Webhooks

Webhooks receive committed events and create at most one endpoint/event delivery record, while each replay has a new delivery ID. Delivery is signed over exact bytes, retried according to policy, never follows redirects, and terminates as delivered or dead-lettered with immutable attempt evidence. Authorized replay records actor and reason.

## External integration boundaries

- **RabbitMQ:** durable asynchronous transport only; never the financial source of truth. Use publisher confirms, manual acknowledgements, bounded prefetch/retries, and dead-letter policies.
- **Merchant webhook endpoint:** untrusted outbound SSRF boundary. Normalize and validate at registration, re-resolve before delivery, block prohibited addresses, restrict egress/ports, disable redirects, and bound time/response handling.
- **Mock provider CSV:** untrusted file input. Enforce size, row, encoding, schema, checksum, parsing, and resource limits; preserve auditable row evidence without logging content.
- **Telemetry stack:** optional operational sink. It may fail without invalidating a financial command and must never receive secrets or become authoritative state.
- **PostgreSQL:** shared physical database but logically module-owned persistence and the only authoritative transactional source.

## Auditability

Financial commands retain stable business references, idempotency evidence, ledger transaction IDs, event IDs, and correlation IDs. Webhook attempts and privileged operator actions are append-only. Manual recovery must use documented replay, reversal, rollback, or forward-fix paths; direct edits to posted ledger, audit, settlement, or delivery evidence are prohibited.
