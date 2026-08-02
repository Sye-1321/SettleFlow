# Immutable Ledger Foundation

This note records the implemented internal Ledger boundary authorized by [ADR-0020](../adr/0020-immutable-double-entry-ledger-foundation.md). The [v1.0 specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx), [financial invariants](financial-invariants.md), and [module boundaries](module-boundaries.md) remain authoritative.

## Ownership and composition

`@settleflow/ledger` owns `ledger_accounts`, `ledger_transactions`, and `ledger_entries`. It depends only on Infrastructure and exposes a transaction-aware application port. It does not depend on Payments, start a transaction, commit independently, perform network I/O, expose HTTP routes, or publish events.

Future authorized capture/refund orchestration may call the Ledger port with its existing `PrismaTransactionClient`. The payment projection, Ledger posting, outbox event, and idempotency completion must then commit or roll back together. This foundation does not enable those commands.

## Closed chart and records

Each merchant has exactly these migration/internal-provisioned accounts:

| Currency | Account code      | Normal side |
| -------- | ----------------- | ----------- |
| ETB      | provider_clearing | debit       |
| ETB      | merchant_payable  | credit      |
| USD      | provider_clearing | debit       |
| USD      | merchant_payable  | credit      |

Accounts and entries use internal UUIDs. Ledger transactions use internal UUIDs plus public `ltx_<ULID>` identifiers. Business types are closed to `capture`, `refund`, and `reversal`; ordinary callers cannot supply arbitrary entry arrays or account IDs. Amounts are positive `BIGINT` minor units capped at `9007199254740991`, and each transaction uses exactly one ETB or USD currency.

There is no stored balance, account-management API, Ledger read API, settlement state, fee account, suspense account, or durable draft state. Balances are derived from immutable entries when a separately authorized read model is implemented.

## Commit-time controls

A posting uses one caller-owned PostgreSQL transaction:

1. insert a `ledger_transactions` row with `posted_at = NULL`;
2. insert the fixed, positive entries in sequence order;
3. update only `posted_at` to PostgreSQL `transaction_timestamp()`;
4. allow the caller to write its other authorized records; and
5. commit, when deferred constraint triggers validate the complete posting.

Named checks, restrictive composite foreign keys, and `DEFERRABLE INITIALLY DEFERRED` triggers enforce merchant/currency agreement, at least two entries, equal debit and credit totals using `NUMERIC` aggregation, finalization, and exact reversal shape. Immediate mutation triggers reject late entry insertion and every account/entry update or delete. A transaction trigger permits only its single finalization update. Truncate is rejected for all three tables.

An exact reversal is a new transaction whose entries retain the original sequence, account, amount, and currency while swapping debit/credit sides. `reversal_of_id` is unique, targets the same merchant/currency, cannot target another reversal, and leaves the original unchanged.

## Tenant isolation, permissions, and retry ownership

Merchant predicates protect Ledger reads that select a business record. Composite foreign keys prevent an entry from combining another merchant's or currency's transaction/account even if an application predicate is defective.

The non-owner `settleflow_app` role has:

- `SELECT, INSERT` on `ledger_accounts` and `ledger_entries`;
- `SELECT, INSERT, UPDATE` on `ledger_transactions`, with the update trigger limiting use to finalization; and
- no update/delete/truncate permission outside that guarded transition.

Uniqueness on public ID, `(merchant_id, business_type, business_reference)`, account key, entry sequence, and reversal target provides concurrency defense in depth. A collision, duplicate business effect, deadlock, or serialization failure must roll back the whole caller transaction. The future command coordinator owns at most three whole-transaction retries; Ledger never retries a partial write or treats a duplicate business reference as an idempotent replay.

## Operations

Ledger emits only a bounded optional `ledger.post` observation with `staged` or `rejected` outcome. `staged` means the Ledger statements completed inside the supplied transaction, not that the caller committed. Business references, amounts, entry bodies, internal account IDs, and raw database errors must not enter logs or metric labels.

Use the [Ledger invariant-failure runbook](../runbooks/ledger-invariant-failure.md) for diagnosis and containment. No operator may repair, delete, resequence, or rewrite Ledger evidence. Retention is indefinite until a superseding approved policy exists.
