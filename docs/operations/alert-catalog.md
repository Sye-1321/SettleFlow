# Executable Alert Catalog

These reference rules are for SettleFlow's single-environment, finance-grade simulation. They do not claim a staffed paging rotation, 24x7 support, or production service level. `@Sye-1321` is the sole alert acknowledgement and incident owner. Local Prometheus evaluates the rules; this slice deliberately adds no Alertmanager or public metrics endpoint.

Rules are checked by `promtool check config` and exercised against synthetic series by `promtool test rules`. Do not weaken a threshold or silence a rule to clear a release gate.

| Alert                                          | Severity and exact trigger                                                                                             | Runbook                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `SettleFlowLedgerInvariantFailure`             | Critical immediately on any new Ledger invariant/immutability/tenant or committed Settlement arithmetic failure signal | [Ledger invariant failure](../runbooks/ledger-invariant-failure.md)               |
| `SettleFlowPostgresqlUnavailable`              | Critical after PostgreSQL readiness is down for 1 minute                                                               | [Database recovery](../runbooks/database-recovery.md)                             |
| `SettleFlowApiNotReadyWarning`                 | Warning after API readiness is down for 2 minutes                                                                      | [Telemetry degradation](../runbooks/telemetry-degradation.md)                     |
| `SettleFlowApiNotReadyCritical`                | Critical after API readiness is down for 5 minutes                                                                     | [Telemetry degradation](../runbooks/telemetry-degradation.md)                     |
| `SettleFlowWorkerNotReadyWarning`              | Warning after worker readiness is down for 5 minutes                                                                   | [Telemetry degradation](../runbooks/telemetry-degradation.md)                     |
| `SettleFlowWorkerNotReadyCritical`             | Critical after worker readiness is down for 15 minutes                                                                 | [Telemetry degradation](../runbooks/telemetry-degradation.md)                     |
| `SettleFlowRabbitmqUnavailableWarning`         | Warning after a publisher or consumer readiness signal is down for 5 minutes                                           | [Outbox backlog](../runbooks/outbox-backlog.md)                                   |
| `SettleFlowRabbitmqUnavailableCritical`        | Critical after a publisher or consumer readiness signal is down for 15 minutes                                         | [Outbox backlog](../runbooks/outbox-backlog.md)                                   |
| `SettleFlowOutboxBacklogWarning`               | Warning when the oldest available unpublished event exceeds 30 seconds for 5 minutes                                   | [Outbox backlog](../runbooks/outbox-backlog.md)                                   |
| `SettleFlowOutboxBacklogCritical`              | Critical when the oldest available unpublished event exceeds 300 seconds for 5 minutes                                 | [Outbox backlog](../runbooks/outbox-backlog.md)                                   |
| `SettleFlowWebhookDueBacklogWarning`           | Warning when the oldest due delivery exceeds 120 seconds for 10 minutes                                                | [Webhook delivery](../runbooks/webhook-delivery.md)                               |
| `SettleFlowWebhookDueBacklogCritical`          | Critical when the oldest due delivery exceeds 900 seconds for 10 minutes                                               | [Webhook delivery](../runbooks/webhook-delivery.md)                               |
| `SettleFlowWebhookDeadLetterWarning`           | Warning when the durable dead-letter gauge increases within 5 minutes                                                  | [Webhook delivery](../runbooks/webhook-delivery.md)                               |
| `SettleFlowWebhookDeadLetterCritical`          | Critical when the durable dead-letter gauge increases by at least 10 within 15 minutes                                 | [Webhook delivery](../runbooks/webhook-delivery.md)                               |
| `SettleFlowBacklogCollectorUnavailable`        | Warning when any bounded PostgreSQL collector remains unsuccessful for 5 minutes                                       | [Telemetry degradation](../runbooks/telemetry-degradation.md)                     |
| `SettleFlowReconciliationDifference`           | Non-paging warning when any retained report has a non-zero difference or mismatch bucket                               | [Reconciliation difference](../runbooks/reconciliation-unexplained-difference.md) |
| `SettleFlowReconciliationProcessorUnavailable` | Critical when processor readiness remains down for 15 minutes                                                          | [Reconciliation difference](../runbooks/reconciliation-unexplained-difference.md) |
| `SettleFlowCommandErrorRatioWarning`           | Warning above 2% 5xx results over 10 minutes with at least 100 valid 2xx/5xx attempts; 4xx is excluded                 | [Payment capture/refunds](../runbooks/payment-capture-and-refunds.md)             |
| `SettleFlowCommandErrorRatioCritical`          | Critical above 0.5% 5xx results over 60 minutes with at least 500 valid 2xx/5xx attempts; 4xx is excluded              | [Payment capture/refunds](../runbooks/payment-capture-and-refunds.md)             |
| `SettleFlowPaymentCommandP95LatencyWarning`    | Warning when create/capture p95 exceeds 300 ms for 15 minutes with at least 100 attempts in the rolling window         | [Payment capture/refunds](../runbooks/payment-capture-and-refunds.md)             |
| `SettleFlowPaymentCommandP99LatencyWarning`    | Warning when create/capture p99 exceeds 600 ms for 15 minutes with at least 100 attempts in the rolling window         | [Payment capture/refunds](../runbooks/payment-capture-and-refunds.md)             |
| `SettleFlowTelemetryCollectorUnavailable`      | Warning when the Collector Prometheus target is down for 15 minutes                                                    | [Telemetry degradation](../runbooks/telemetry-degradation.md)                     |

## Safe operating boundary

Prometheus labels are bounded and never include merchant, request, payment, refund, Ledger, Settlement, Reconciliation, event, endpoint, or delivery identifiers. PostgreSQL backlog reads run asynchronously through each table's owning module with a statement timeout. A collector failure retains the last known values and emits an explicit failure/freshness signal; it never changes readiness, retries, acknowledgement, lease, transaction, or financial state.

Open `http://127.0.0.1:9090/alerts` only from the local host after `pnpm telemetry:up`. Use `pnpm telemetry:stop` when the simulation is complete. Never publish port 9090 or either application internal listener.

See [observability and internal probes](observability.md) and the [runbook index](../runbooks/README.md).
