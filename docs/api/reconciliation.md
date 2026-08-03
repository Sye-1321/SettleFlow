# Reconciliation API

Reconciliation compares a bounded mock-provider CSV with immutable platform evidence. It does not contact a provider, move funds, settle a mismatch, or expose raw staged rows.

## Routes and authorization

| Route                                        | Scope                  | Success |
| -------------------------------------------- | ---------------------- | ------- |
| `POST /v1/reconciliation-imports`            | `reconciliation:write` | 202     |
| `GET /v1/reconciliation-imports/{id}/report` | `reconciliation:read`  | 200     |

The POST is `multipart/form-data` with one `file`, `periodStart`, and `periodEnd`, plus one `Idempotency-Key`. Timestamps are exact UTC millisecond ISO-8601 values, the half-open window must be positive and no longer than 31 days, and every CSV row must fall within it. The authenticated merchant’s code must match every row; merchant identity is never accepted as a target parameter.

## CSV contract

Input is strict UTF-8 RFC-4180-style CSV with these exact headers in this order:

```text
provider_txn_id,merchant_code,provider_ref,external_ref,event_type,currency,gross_minor,fee_minor,net_minor,status,occurred_at
```

Limits are 10 MiB, 50,000 data rows, 16 KiB per logical row, and 255 Unicode scalars for bounded identifiers/references. NUL and disallowed controls are rejected. `event_type` is `capture`, `refund`, `settlement`, or `adjustment`; currency is `ETB`/`USD`; status is `succeeded`/`failed`; all amounts are exact JSON-safe non-negative integers. Capture/refund/adjustment require zero fee and net equal to gross. Settlement requires gross equal to fee plus net.

SHA-256 over the exact bytes supplies merchant-scoped content deduplication. The same idempotency key/checksum/window replays; conflicting key content or conflicting metadata for identical bytes is rejected. The worker claims staged imports and completes results, per-currency summaries, and one outbox event atomically.

## Deterministic matching

Matching first uses event-type-scoped `provider_ref`, which is the immutable `ltx_<ULID>` Ledger transaction ID. Only when no unique primary match exists may the same-event-type external reference match: Payment external reference for capture, Refund external reference for refund, or public batch/adjustment ID. Duplicate provider transaction IDs are classified before matching.

Every provider/platform record belongs to exactly one bucket: `matched_exact`, `duplicate_provider_row`, `provider_only`, `platform_only`, `currency_mismatch`, `amount_mismatch`, or `status_mismatch`. Currency mismatch precedes amount mismatch, which precedes status mismatch. Per-currency unexplained difference is provider net minus platform net.

Report `limit` defaults to 20 and is 1–100. The response returns summaries and bounded mismatch evidence only. When another mismatch page exists, pass the opaque `nextCursor` unchanged as `cursor`; it contains only a versioned ordering ordinal and no internal identifier. A staged import returns `409 reconciliation_report_not_ready`; a missing/foreign import is the same safe 404.

Use the [unexplained-difference runbook](../runbooks/reconciliation-unexplained-difference.md). There is deliberately no manual disposition/replay API or deletion job.
