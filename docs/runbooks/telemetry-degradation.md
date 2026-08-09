# Telemetry Degradation

## Purpose and trigger

Use this runbook when structured logging, metrics exposition, trace export, or an internal probe is unavailable or emits a bounded degradation signal. Telemetry collector/export failure becomes a warning after 15 minutes once executable alerts are added. Internal readiness failure follows the API/worker readiness thresholds in the approved operational plan.

This runbook restores disposable operational evidence. It does not repair or authorize financial state.

## Severity, ownership, and prerequisites

- **Owner:** `@Sye-1321`, the sole Security Owner and Incident Commander for this simulation.
- **Support model:** no backup maintainer, staffed paging rotation, or 24x7 commitment.
- **Severity:** warning for telemetry-only degradation; elevate if business readiness, security evidence, or incident diagnosis is also impaired.
- **Prerequisites:** repository read access and access to the affected local/reference runtime. Do not request or print application secrets.

## Diagnose safely

1. Confirm public application behavior separately from the internal listener. A telemetry exporter failure must not change an API result, database transaction, broker acknowledgement, lease, Webhook outcome, or readiness decision.
2. From the same host/network boundary, query `/health/live`, `/health/ready`, and `/metrics` on the configured internal port. Never expose these endpoints to public ingress to simplify diagnosis.
3. Inspect JSON stdout by stable `service`, `event`, `code`, `requestId`, `eventId`, or safe public resource ID. Do not search or export bodies, amounts, URLs, SQL, credentials, signatures, or arbitrary exception text.
4. Check configuration using `pnpm config:check`. Confirm `OTEL_TRACING_ENABLED` has a bounded HTTP(S) endpoint when true and that internal hosts remain loopback for this milestone.
5. Run the Infrastructure telemetry unit tests. If the internal listener is healthy but export is not, treat the exporter/Collector path as non-authoritative and preserve business operation.

## Containment and recovery

1. If prohibited data is visible, stop the affected export/collection path, restrict access to the telemetry store, start the security-incident process, and rotate exposed material. Preserve authoritative database and audit evidence.
2. If only OTLP export is unavailable, restore the endpoint or temporarily disable tracing through reviewed configuration. Do not restart a healthy finance command solely to reproduce a span.
3. If the internal listener cannot bind, correct only the loopback address/port conflict and restart through the normal graceful lifecycle. Do not use `0.0.0.0`, publish the port, or put a bearer secret in front of a public endpoint.
4. If metrics reject an observation, correct the adapter's closed label mapping. Never add an identifier or unbounded value as a label.
5. Re-run focused telemetry tests and verify that readiness becomes false before shutdown and true only after required dependencies recover.

## Prohibited actions

- Do not edit Ledger, Payment, Settlement, Reconciliation, Outbox, Inbox, Webhook delivery, or audit rows.
- Do not replay a command/message or resend a Webhook merely to recreate telemetry.
- Do not weaken redaction, label allowlists, trace sampling rules, or network isolation.
- Do not log raw errors, configuration objects, environment values, request bodies, URLs, SQL, credentials, or secret material.
- Do not claim telemetry proves a commit, balance, exactly-once outcome, or financial correctness.

## Validation and escalation

Validate JSON parsing and redaction, process-local metrics, bounded labels, trace selection, liveness/readiness transitions, exporter non-interference, and graceful shutdown. Then run the domain runbook for any underlying dependency or financial incident.

Escalate to the repository owner immediately for suspected secret exposure, public metrics exposure, missing authoritative evidence, or telemetry changes that affected a business outcome. Record the incident, containment decision, affected release/configuration, and follow-up without copying prohibited payload data.

## Exercise record

- **Last exercise date:** To be decided after the optional Collector/Prometheus milestone.
- **Evidence:** To be decided.
- **Review cadence:** with each telemetry dependency, schema, listener, redaction, or deployment-network change.

See [observability guidance](../operations/observability.md), [the operational-readiness plan](../plans/2026-08-03-operational-readiness-and-v1-release.md), and the [runbook index](README.md).
