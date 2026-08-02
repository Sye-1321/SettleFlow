# Payment capture/refund invariant and command recovery

## Purpose and trigger

Use this runbook for unexpected capture/refund 5xx responses, a Ledger or named Payment/Refund constraint rejection, sustained command conflicts above the approved threshold, or evidence that Payment, Refund, Ledger, idempotency, and outbox records may not describe one atomic outcome. Environment severity thresholds, paging destination, incident system, and communication owner are **To be decided**.

Required role: read-only diagnostic access. Disabling a command deployment, applying a forward migration, rotating credentials, or invoking a future reversal requires the environment's authorized operator and change/incident record. Ordinary API operators must never mutate financial evidence.

## Safety rules

PostgreSQL is authoritative. One successful command must have a completed idempotency snapshot, one allowed Payment transition, exactly one balanced posted Ledger transaction, and one exact pending/published outbox event. A successful refund additionally has one immutable Refund row. RabbitMQ and Webhook state are downstream evidence, not part of the financial commit.

Never:

- update/delete/truncate Refund, Ledger transaction/entry, idempotency, outbox, inbox, Webhook projection/delivery, or Operations audit evidence;
- reset a Payment status/version/captured/refunded projection or alter its amount, currency, tenant, or timestamps;
- retry a changed command with the same key, manufacture a new key to bypass an uncertain outcome, or replay/purge a broker message manually;
- create compensating entries directly; corrections require the accepted exact reversal command and separate authorization;
- log raw bodies, amounts, external references, API/idempotency keys or hashes, response snapshots, event payloads, SQL, secrets, or account entries.

## Diagnose

Record environment, revision, command route, current request ID, merchant ID, and public payment/refund/ledger/event IDs already present in safe logs. Inspect service and dependency health:

```shell
pnpm infra:ps
pnpm infra:logs
pnpm db:migrate:status
```

Use the approved read-only query interface. The following local examples deliberately select identifiers, state, and timing only:

```shell
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT public_id, payment_status, version, captured_at, available_at, updated_at FROM payment_intents WHERE public_id = 'pi_REPLACE_WITH_APPROVED_IDENTIFIER';"
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT public_id, payment_intent_id, currency, created_at FROM refunds WHERE public_id = 'rf_REPLACE_WITH_APPROVED_IDENTIFIER';"
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT public_id, business_type, business_reference, currency, occurred_at, posted_at, reversal_of_id FROM ledger_transactions WHERE public_id = 'ltx_REPLACE_WITH_APPROVED_IDENTIFIER';"
docker compose exec postgres psql --username settleflow --dbname settleflow --command "SELECT event_id, event_type, aggregate_id, request_id, created_at, available_at, attempt_count, published_at FROM outbox_events WHERE aggregate_id = 'pi_REPLACE_WITH_APPROVED_IDENTIFIER' ORDER BY occurred_at;"
```

Do not select an idempotency hash/body or event payload. Authorized database owners may run a reviewed invariant query that groups Ledger entries by transaction/currency and compares debit/credit totals; preserve its output as restricted incident evidence.

Interpretation:

- `created` with zero projections and no capture Ledger/event: capture did not commit; retry the exact body with the same key.
- `captured` with one capture Ledger transaction/event and completed snapshot: capture committed even if the caller lost the response; replay the exact request/key.
- `partially_refunded` or `refunded`: Refund amounts and refund Ledger transactions/events must equal the cumulative projection; replay an uncertain request with its exact key.
- a durable 409 snapshot: the command was rejected without a financial effect and will replay as the same logical problem.
- unpublished outbox evidence with a valid financial commit: leave it intact and follow [outbox backlog recovery](outbox-backlog.md).
- projection queue/DLQ mismatch: preserve financial state and follow [Webhook projection recovery](webhook-projection-consumer.md).

## Contain and recover

1. If any Payment/Refund/Ledger invariant is uncertain, stop only the affected capture/refund command surface. Keep reads and unaffected asynchronous evidence available when safe.
2. Preserve identifiers, timestamps, named constraint, deployed revision, dependency state, and bounded `payment.command`/`ledger.post`/outbox signals. Do not include protected payload data.
3. Restore PostgreSQL health or runtime-role permissions through the approved platform/provisioning workflow. Never run the API as the migration owner.
4. For an expected conflict, instruct the caller to keep the original idempotency key/body. Do not override the result.
5. For a code/schema defect, prepare a reviewed forward fix and prove it against an empty database, the committed migration history, and the mandatory race suite. Never roll back by dropping financial rows or constraints after a posting exists.
6. If a correction is financially required, escalate to the authorized reversal workflow. Capture/refund manual replay and arbitrary correction APIs do not exist.

## Validate and close

Before re-enabling commands, prove:

- Payment lifecycle/projection/timestamp constraints hold and no captured/refunded projection exceeds the original amount;
- every posted Ledger transaction has at least two positive same-currency entries with debit total equal to credit total;
- Refund and posted Ledger evidence remain immutable under `settleflow_app`;
- every successful command has its completed snapshot and exact outbox event, with no duplicate business posting;
- `pnpm test:payments`, the focused PostgreSQL race tests, migration status, OpenAPI drift, and the full regression suite pass;
- asynchronous backlog recovery progresses without deleting/reforging evidence.

Escalate immediately for any unbalanced/unposted transaction, missing financial link, tenant mismatch, over-capture/over-refund, direct row edit, duplicate business posting, or unknown external side effect. Record impact, root cause, evidence identifiers, authorized containment/recovery, and follow-up controls.

Owner: SettleFlow Payments/Ledger/Operations maintainers. Review cadence: after every Payment/Ledger schema, command, provider, idempotency, event, permission, or recovery change and at least quarterly. Last exercised: 2026-08-02 through disposable PostgreSQL atomicity, permission, replay, 50-way capture, and concurrent-refund integration tests; environment evidence link is **To be decided**.
