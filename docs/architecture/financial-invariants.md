# Financial Invariants

These rules are normative extracts from the SettleFlow specification. PostgreSQL constraints and triggers are executable parts of the design. Application checks improve error handling but do not replace database enforcement.

## Money and lifecycle rules

- Store money as `BIGINT` integer minor units according to field meaning. Never use binary floating point.
- Carry a three-letter uppercase currency code. Each payment, ledger transaction, and settlement batch has one currency; never aggregate different currencies into one amount.
- Reject arithmetic overflow, non-positive capture/refund requests, unsupported currencies, and currency mismatch before posting.
- Payment status describes the customer-facing lifecycle; settlement status describes batching/payment of the merchant obligation. Keep them separate.
- Payment projections are operational views. Posted ledger entries are the accounting record; any disagreement is an incident.

## Normative invariants

| ID     | Rule                                                                 | Primary enforcement                               | Required proof                                                                                       |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| INV-01 | Every ledger entry amount is greater than zero.                      | `CHECK` constraint.                               | Positive posting succeeds; zero/negative entries fail.                                               |
| INV-02 | Every posted ledger transaction has at least two entries.            | Deferred constraint trigger.                      | Single-entry commit fails.                                                                           |
| INV-03 | Debits equal credits for every posted ledger transaction.            | Deferred constraint trigger at commit.            | Balanced posting succeeds; imbalance fails at commit.                                                |
| INV-04 | Every entry currency equals its ledger transaction currency.         | Deferred constraint trigger.                      | Mixed-currency posting fails.                                                                        |
| INV-05 | Posted ledger transactions and entries cannot be updated or deleted. | Database trigger and restricted application role. | Update/delete and permission-negative tests fail.                                                    |
| INV-06 | A correction is a new reversal, never mutation.                      | Unique reversal reference and service rule.       | Reversal contains opposite entries, references the original once, and leaves the original unchanged. |
| INV-07 | Cumulative refunds cannot exceed captured amount.                    | Payment row lock and `CHECK` constraint.          | Concurrent refund sum never exceeds capture.                                                         |
| INV-08 | One payment can belong to at most one settlement batch at a time.    | Unique `payment_intent_id` on batch item.         | Dual-worker race creates no duplicate membership.                                                    |
| INV-09 | A settlement batch contains one merchant and one currency.           | Foreign-key ownership and batch-item validation.  | Cross-merchant/currency item insertion fails; totals equal items and postings.                       |
| INV-10 | A duplicate command cannot create a second financial side effect.    | Idempotency record and unique business keys.      | Retry storms create one domain transition, ledger transaction, and event.                            |

Do not weaken any enforcement or its negative test to accommodate application behavior. If a constraint exposes a design conflict, stop the change and resolve the requirement through review.

## Atomic transaction boundaries

For capture and refund, one explicit PostgreSQL transaction must:

1. acquire/confirm command ownership and lock the payment as required;
2. re-check merchant ownership, lifecycle, amount, currency, and cumulative projections;
3. create the ledger transaction and all balanced entries;
4. update the payment projection;
5. insert the versioned domain event into the outbox;
6. commit all changes together or roll them all back.

RabbitMQ publication and webhook delivery occur after commit and may repeat. A synchronous response must not depend on broker or merchant-endpoint availability.

Settlement selection uses `FOR UPDATE SKIP LOCKED` plus unique batch-item membership so concurrent workers claim disjoint payments. A failed batch transaction rolls back all claims. Post-settlement refunds create a future adjustment while payment state continues to represent refunded value.

For a finalized settlement, one explicit PostgreSQL transaction must create the run/batch and immutable membership snapshots, consume only fully applicable adjustments, post the balanced settlement Ledger transaction, finalize the batch, append the privileged audit and outbox event, and complete the idempotency response snapshot. The fixed posting debits `merchant_payable` by gross and credits `fee_revenue` plus `settlement_clearing`, where gross equals fee plus net.

Reconciliation is non-mutating with respect to Payments, Ledger, and Settlements. A completed import atomically persists its deterministic results and per-currency summaries plus `reconciliation.completed.v1`; a mismatch is evidence for investigation, never authorization to adjust financial rows.

## Idempotency and concurrency

- Require `Idempotency-Key` on every money-mutating POST and scope the record by merchant, method, normalized route, and key.
- Fingerprint the canonical validated body and relevant command parameters. Same key/fingerprint replays the stored response; a changed fingerprint returns the documented conflict without another effect.
- Use a proven PostgreSQL single-winner acquisition pattern that accounts for snapshot visibility. Bound waiting and recover stale/in-progress ownership according to an approved policy.
- Lock the payment row for capture/refund. Retry an entire transaction, not a partial statement sequence, after approved transient serialization or deadlock errors.
- Use unique external/business references as defense in depth; do not substitute them for idempotency response replay.

## Ledger integrity and audit evidence

- A ledger transaction has at least two positive entries, balanced debits and credits, and one currency.
- Posted transactions and entries are immutable. Corrections use a new uniquely linked reversal with opposite entries.
- Settlement fees and net amounts must balance exactly to the gross debit in the same currency.
- Authoritative account balances are derived from entries, not stored mutable balances.
- Preserve links among command/idempotency record, payment/refund/batch, ledger transaction, outbox event, request/event correlation, and privileged audit action.
- Never repair an incident through a manual posted-entry edit. Preserve evidence and use a controlled reversal or forward fix.

## Asynchronous integrity

- The outbox row commits with financial state. The relay may republish after a crash; stable event IDs make duplicates detectable.
- Every state-changing RabbitMQ consumer uses inbox uniqueness and acknowledges only after its effect commits.
- Webhook delivery is at-least-once. A unique endpoint/event record prevents duplicate initial scheduling, attempt history is immutable, and manual replay uses a new delivery ID.
- Dead-letter and replay are auditable terminal/recovery paths, not reasons to mutate the originating financial record.

## Verification gate

All INV-01 through INV-10 positive, negative, concurrency, and permission tests are release-blocking. Required race coverage includes concurrent capture with same and distinct keys, changed-payload reuse, over-refund attempts, competing outbox relays, and competing settlement workers. No financial integration test may be skipped for a release.
