# Operational Runbooks

Runbooks turn SettleFlow's failure model into safe, reviewable operator actions. Runtime-specific commands and thresholds are **To be decided** when the relevant components exist; do not invent them in advance.

## Required structure

Every runbook must include:

- purpose, trigger, severity, prerequisites, and required operator role;
- dashboards, metrics, traces, logs, database read queries, and correlation identifiers used for diagnosis;
- containment steps that preserve financial and audit evidence;
- recovery steps, retry/replay limits, idempotency expectations, and approval points;
- explicit prohibited actions, especially manual edits to posted ledger, audit, settlement, outbox/inbox, or delivery evidence;
- validation of financial invariants, backlog recovery, terminal state, and customer/operator impact;
- escalation criteria, communication owner, and incident/audit record requirements;
- rollback or controlled forward-fix instructions;
- last exercise date, evidence link, owner, and review cadence.

Use placeholders labeled **To be decided** for environment-specific accounts, contacts, URLs, thresholds, and commands. Never place credentials in a runbook.

## Minimum v1.0 runbooks

| Runbook                                                       | Trigger and safe outcome                                                                                                                                               | Status        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [Outbox backlog](outbox-backlog.md)                           | Oldest unpublished event exceeds the approved threshold; restore relay/broker health and prove catch-up without manual row edits.                                      | Implemented   |
| [Webhook endpoint foundation](webhook-endpoint-foundation.md) | Endpoint registration, URL policy, keyring, runtime permission, or lifecycle-audit failure; restore the approved boundary without secret exposure or row edits.        | Implemented   |
| [Webhook projection consumer](webhook-projection-consumer.md) | Projection queue/DLQ growth or consumer unreadiness; restore safe consumption, validate durable dedupe/catch-up, and preserve poison evidence without manual replay.   | Implemented   |
| [Webhook delivery](webhook-delivery.md)                       | Due/leased/dead-lettered HTTP deliveries or dispatcher unreadiness; restore dependency health and prove bounded retry/recovery without row edits or manual replay.     | Implemented   |
| [Ledger invariant failure](ledger-invariant-failure.md)       | Constraint violation or mismatch detector fires; stop the affected command path, preserve evidence, and use controlled code/migration correction; never patch entries. | Implemented   |
| [Payment capture/refunds](payment-capture-and-refunds.md)     | Capture/refund conflict, 5xx, or cross-record invariant concern; preserve atomic evidence and retry only the exact idempotent command or forward-fix safely.           | Implemented   |
| Settlement mismatch                                           | Batch totals differ from items/ledger; block export, record an incident, and recover only through rollback, reversal, or controlled forward fix.                       | To be created |
| Reconciliation unexplained difference                         | Difference exceeds the approved threshold; inspect mutually exclusive buckets/duplicates and record operator disposition.                                              | To be created |
| Database recovery                                             | Restore exercise or loss event; restore backup/WAL, apply migrations, validate INV-01 through INV-10 and outbox/inbox state, and report achieved RPO/RTO.              | To be created |

Additional runbooks are required when implementation introduces a new alert, external dependency, privileged recovery action, or terminal state not safely covered above.

## Exercise and review

Runbook completion requires a dry run or failure-injection exercise in the reference environment, captured commands/results, and follow-up issues for gaps. Review a runbook whenever its schema, metric, retry policy, deployment topology, authentication model, or recovery procedure changes.

See [the architecture overview](../architecture/README.md), [financial invariants](../architecture/financial-invariants.md), [security policy](../../SECURITY.md), and [code-review checklist](../review/code-review-checklist.md).
