# Reconciliation unexplained difference

## Purpose and trigger

Use this runbook when a completed `rec_<ULID>` report has a non-zero ETB/USD unexplained difference, any mismatch bucket, a stuck staged lease, or failed classification. This system compares synthetic mock-provider input only and cannot initiate payouts or correct provider data.

Prerequisites: the public import ID/request ID, tenant-authorized report access, approved database read access if deeper diagnosis is required, and the original synthetic input retained outside SettleFlow under test-data controls. Never paste raw CSV rows, provider/external references, checksums, or amounts into logs/tickets.

## Diagnose safely

1. Read `GET /v1/reconciliation-imports/{id}/report` with `reconciliation:read`. Capture only counts, bucket names, safe public platform references, and per-currency difference.
2. Confirm the import window, row count, terminal state, and one summary for both ETB and USD. The difference is provider net minus platform net.
3. Review precedence in order: duplicate provider transaction ID, provider/platform existence, currency, amount, then status. A shared settlement Ledger reference may require the approved event-scoped public adjustment fallback.
4. Confirm one result per provider row plus one for every unmatched platform record, mutually exclusive buckets, and one `reconciliation.completed.v1` outbox row.
5. If staged, inspect lease timestamps. A transient worker/database failure rolls classification back; expiry makes it reclaimable. Do not edit the lease.

## Contain and recover

- Preserve the exact CSV and completed evidence. Do not delete/re-import altered bytes under the same logical key.
- For transient dependency failure, restore PostgreSQL/worker health and allow natural claim expiry/retry.
- For invalid input, correct the synthetic source and submit a new import/key. A checksum metadata conflict must not be bypassed by database edits.
- For a genuine mismatch, investigate the mock clearing source and platform event/Ledger evidence. This slice has no disposition, manual replay, or correction API; record resolution externally under approved operations controls.
- A missing event uses [outbox-backlog.md](outbox-backlog.md). Webhook failure uses [webhook-delivery.md](webhook-delivery.md) and does not change report success.

## Closeout

Record safe import/request IDs, bucket counts, affected currency, root cause category, recovery action, and whether evidence was unchanged. Escalate any unexplained platform accounting difference to the financial owner.
