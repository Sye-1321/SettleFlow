# Settlement API

This API finalizes one bounded, simulated merchant settlement. It records immutable database and Ledger evidence; it never sends a payout or contacts a bank/provider.

## Routes and authorization

| Route                             | Scope               | Success |
| --------------------------------- | ------------------- | ------- |
| `POST /v1/settlement-runs`        | `settlements:write` | 201     |
| `GET /v1/settlement-batches/{id}` | `settlements:read`  | 200     |

Scopes are independent. Every predicate uses the merchant from the bearer API key, so a missing or foreign `stb_<ULID>` is the same safe 404. The POST requires one `Idempotency-Key`; a replay returns the stored logical response and creates no second batch, Ledger transaction, event, or audit record.

## Run contract

The body contains exactly:

```json
{ "currency": "ETB", "cutoffDate": "2026-08-01" }
```

The cutoff is midnight after `cutoffDate` in `Africa/Addis_Ababa`. The date must be closed at request time. Candidates are captured, have positive captured-minus-refunded value, are available before the cutoff, are not already in a batch, and belong to the authenticated merchant/currency. Ordering is `availableAt`, then internal Payment ID, with at most 500 Payment items per run.

The immutable `settlement_fee_v1` policy is:

| Currency | Flat minor units | Basis points |
| -------- | ---------------- | ------------ |
| ETB      | 600              | 200          |
| USD      | 25               | 200          |

Each item fee is `flat + floor(gross * basisPoints / 10000)`. The command fails closed when a fee is greater than or equal to item gross. Pending post-settlement refund adjustments are applied all-or-nothing only when the new batch remains positive. A run with no eligible positive obligation returns terminal `NO_ELIGIBLE_ITEMS` and no batch/Ledger/outbox record.

A successful batch is terminal `SETTLED` in this simulation. It debits `merchant_payable` by gross, credits `fee_revenue` by fee, and credits `settlement_clearing` by net in one balanced transaction. This means only internal clearing finalization—not external payout confirmation.

## Read and composed status

The batch read returns public IDs, cutoff, currency, payment/adjustment/gross/fee/net totals, immutable Ledger transaction ID, item/adjustment counts, and one combined bounded page. Payment snapshots precede adjustment snapshots; each group retains its approved deterministic order. `limit` defaults to 20 and is 1–100. When more evidence exists, `nextCursor` is an opaque batch-scoped SHA-256 continuation token that contains no internal UUID; pass it unchanged as `cursor`.

Payment Intent reads compose a Settlement-owned status without a Payment column: `NOT_ELIGIBLE`, `ELIGIBLE`, `BATCHED`, `SETTLED`, or `ADJUSTMENT_PENDING`. Payment and Refund rows are never mutated by Settlements.

## Errors and recovery

Errors are RFC 9457 `application/problem+json`. Stable domain codes include `invalid_settlement_request`, `settlement_cutoff_not_closed`, `settlement_batch_not_found`, `settlement_fee_policy_invalid`, `settlement_no_positive_net`, `settlement_run_conflict`, and `settlement_invariant_violation`, plus shared authentication, scope, idempotency, dependency, and internal errors. Problems do not echo amounts, references, SQL, or credentials.

Use the [settlement mismatch runbook](../runbooks/settlement-mismatch.md) for diagnosis. Never repair a batch, item, adjustment, or Ledger row directly.
