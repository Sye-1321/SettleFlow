# Settlement mismatch and invariant failure

## Purpose and trigger

Use this runbook when a finalized batch’s item/adjustment totals, fee snapshot, Ledger posting, outbox event, or derived Payment settlement status appears inconsistent. Treat an invariant or permission failure as high severity; no real payout occurred because this milestone has no provider/bank integration.

Prerequisites: database read access through an approved operator path, a public `str_`, `stb_`, `pi_`, `sta_`, `ltx_`, `evt_`, or request ID, and authorization to inspect that merchant’s evidence. Do not request API keys, idempotency hashes, external references, or raw amounts in an incident ticket.

## Diagnose safely

1. Confirm PostgreSQL and worker/API readiness with `pnpm infra:ps`; inspect bounded application logs using only public IDs/request ID.
2. In `pnpm db:inspect`, locate the merchant-owned run and batch. Confirm one terminal run, unique Payment membership, `paymentGross - adjustment = gross`, `gross - fee = net`, and item/adjustment counts.
3. Confirm every Payment item snapshots captured/refunded/gross and `settlement_fee_v1`; recompute `flat + floor(gross * 200 / 10000)` using integer arithmetic.
4. Locate the linked posted `ltx_` transaction. Confirm one debit to `merchant_payable` for gross, credit to `fee_revenue` for fee, credit to `settlement_clearing` for net, one currency/merchant, and equal debit/credit totals.
5. Confirm one matching `settlement.finalized.v1` outbox event and one `settlement.run_executed` audit event. An unpublished outbox row is a relay problem, not a reason to recreate the batch.

## Contain and recover

- Stop new settlement commands for the affected merchant/currency at the routing layer. Do not stop Payment capture/refund unless their own invariants fail.
- Never update/delete a batch, item, adjustment, Ledger entry, idempotency snapshot, audit row, or event. Never rerun with a new key to “repair” committed evidence.
- If the database transaction rolled back, retry the exact command with the same idempotency key after dependency recovery.
- If a batch committed correctly but publish is pending, use the existing outbox recovery path in [outbox-backlog.md](outbox-backlog.md).
- A committed accounting error requires a separately authorized exact Ledger reversal and forward-correction design. No endpoint in this slice performs it.

## Closeout

Record safe public identifiers, invariant checked, migration/application version, root cause, and whether the command rolled back or committed. Escalate any committed mismatch or unauthorized mutation attempt to the financial/platform owners before re-enabling settlement for that merchant/currency.
