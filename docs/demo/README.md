# Deterministic SettleFlow Demo

This local-only reviewer flow exercises the committed finance-grade simulation through its actual API, worker, application-service, PostgreSQL, RabbitMQ, signed Webhook, settlement, and reconciliation boundaries. It does not connect to a real provider, move funds, send a payout, or claim production readiness.

## Safety boundary

The demo refuses to run when `NODE_ENV=production`, unless `SETTLEFLOW_DEMO_MODE=true` is present, or when the runtime database is not the `settleflow_demo` database reached through loopback as `settleflow_app`. Its Compose project is exactly `settleflow-demo`; its three volume names are validated before use and cannot match development or release-simulation volumes.

Generated credentials live only under ignored `.settleflow/demo/`. The plaintext merchant API key and one-time Webhook secret remain in the parent process memory and are never printed or written. The persisted API-key record contains only the existing scrypt hash and safe prefix. Normal `pnpm demo` never invokes reset or selectively deletes financial rows.

The local receiver is a temporary hardened demo sidecar, accepts only a random run path, and is registered through the explicitly allowlisted `http://demo-webhook-receiver:18080` development origin. Its control listener is exposed only on loopback so the orchestration process can transfer the one-time signing secret directly into receiver memory after endpoint registration. The accepted production SSRF policy is unchanged outside this guarded demo configuration.

## Run

Prerequisites are the pinned Node.js/pnpm toolchain and a working Docker engine. Install from the lockfile first:

```powershell
pnpm install --frozen-lockfile
$env:SETTLEFLOW_DEMO_MODE = 'true'
pnpm demo
```

The demo performs these ten checks:

1. Validates safety and Compose configuration, builds the three application images, starts isolated PostgreSQL/RabbitMQ, provisions the runtime role, and applies all 11 migrations.
2. Idempotently provisions one synthetic merchant and the exact eight-account ETB/USD chart, then issues an in-memory key with exactly the eight approved scopes.
3. Starts API, worker, Prometheus, the OpenTelemetry Collector, and the in-process synthetic receiver sidecar, and waits for bounded readiness.
4. Registers one endpoint and proves exact-byte, recent-timestamp, delivery/event-ID, and HMAC verification with one persisted retryable failure followed by `204`.
5. Creates and replays a Payment Intent, runs a bounded same-key capture storm, and proves one transition, one balanced Ledger posting, and one outbox effect.
6. Creates a partial refund and proves cumulative projection, balanced immutable Ledger evidence, publication, projection, and delivery.
7. Settles the separately provisioned synthetic ETB capture using authoritative transaction time while the current Payment/refund flow remains isolated in USD; proves `settlement_fee_v1`, uniqueness, guarded posting, audit/outbox evidence, and a post-settlement adjustment. This is not a payout.
8. Generates one bounded CSV in memory, stages it through the authenticated API, and proves deterministic exact/provider-only buckets and ETB/USD totals without printing rows, amounts, or references.
9. Stops RabbitMQ, proves API/worker unready and a committed pending outbox row, restores RabbitMQ, and proves readiness, catch-up, deduplication, and delivery without repair.
10. Writes a schema-checked, sanitized PASS manifest.

Existing full-jitter Webhook and broker retry timing remains unchanged, so a cold run can spend up to the documented retry bounds. Business outcomes are deterministic; random identifiers, key material, and timestamps are intentionally not byte-identical.

## Evidence and repetition

The ignored manifest is `.settleflow/demo/evidence.json`. Its allowlisted fields are source commit/state, elapsed milliseconds, named checks, bounded counts, terminal states, commands, and runbook paths. Evidence validation rejects credential, signature, payload, amount, reference, CSV, destination, dependency URL, SQL, log, stack, and arbitrary error fields.

A repeated `pnpm demo` invocation detects the completed manifest and exits successfully without changing financial or infrastructure state. Reset is separate and explicit:

```powershell
$env:SETTLEFLOW_DEMO_MODE = 'true'
pnpm demo:reset -- --yes
```

Without `--yes`, a non-interactive reset refuses. Before deleting anything, reset validates the ignored configuration, rendered Compose identity, and every existing volume label/name. It removes the whole isolated demo project and its volumes; it never deletes selected rows. Development and release-simulation volumes are outside its allowlist.

Operational recovery references:

- [Outbox backlog](../runbooks/outbox-backlog.md)
- [Webhook delivery](../runbooks/webhook-delivery.md)
- [Settlement mismatch](../runbooks/settlement-mismatch.md)
- [Reconciliation unexplained difference](../runbooks/reconciliation-unexplained-difference.md)
