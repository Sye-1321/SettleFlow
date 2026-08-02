# Webhook Delivery Runbook

## Purpose and trigger

Use this runbook when the Webhook dispatcher is not ready, due delivery age or retry volume grows unexpectedly, active leases remain expired, or database `dead_lettered` deliveries increase. This runbook covers only the PostgreSQL-to-HTTP dispatcher; RabbitMQ poison messages are handled by the [Webhook projection consumer runbook](webhook-projection-consumer.md).

- **Severity:** To be decided from merchant impact, oldest due age, and failure volume.
- **Required operator role:** Read-only application database, worker telemetry, and deployment visibility. Privileged restart or configuration changes require the environment's approved incident/change role.
- **Owner and escalation contacts:** To be decided.
- **Prerequisites:** Identify the environment, deployment revision, incident/correlation reference, and affected merchant/endpoint/event/delivery IDs. Never collect a plaintext secret, signature, body, destination URL, resolved address, or response content.

## Safety model

Delivery is at least once. A remote endpoint can accept a request before the worker loses its response or final database write. The worker therefore preserves the same `whd_<ULID>` across automatic attempts, records every durably started attempt, and uses an `unknown` outcome when an active lease expires.

Do not:

- update, delete, truncate, reopen, reschedule, or insert delivery/attempt rows by hand;
- resend with `curl`, an operator shell, a queue move, or an ad hoc script;
- reveal/decrypt signing material or log a signature, payload, URL, address, header, or response body;
- purge or move the RabbitMQ projection queue/DLQ as a delivery recovery step;
- run the worker with migration-owner credentials or weaken URL/TLS/keyring policy;
- interpret database `dead_lettered` as a RabbitMQ DLQ entry.

Manual replay is not implemented. A terminal delivery remains terminal until a separately approved, authenticated, reasoned, and audited replay design exists.

## Signals and bounded metrics

Inspect worker readiness component `webhookDelivery` and structured events beginning `webhook.delivery.`. Safe batch counters include `claimed`, `delivered`, `retrying`, `deadLettered`, `ownershipLost`, and `recoveredUnknown`. Per-delivery signals may include stable IDs, attempt number, state, HTTP status, bounded duration, next retry time, and a stable error code.

Environment-specific dashboards, alert thresholds, routes, and owners are **To be decided**. Prometheus export is not part of this milestone; structured signals and the read-only queries below are the operational source.

## Read-only diagnosis

Run with a read-only support credential, never the application or migration owner. Capture aggregate results in the incident record without secret-bearing joins.

```sql
SELECT status, count(*) AS deliveries,
       min(next_attempt_at) AS oldest_due_at
FROM webhook_deliveries
GROUP BY status
ORDER BY status;

SELECT count(*) AS due_count, min(next_attempt_at) AS oldest_due_at
FROM webhook_deliveries
WHERE status IN ('pending', 'retrying')
  AND next_attempt_at <= clock_timestamp()
  AND claim_token IS NULL;

SELECT count(*) FILTER (WHERE lease_expires_at > clock_timestamp()) AS active_leases,
       count(*) FILTER (WHERE lease_expires_at <= clock_timestamp()) AS expired_leases
FROM webhook_deliveries
WHERE claim_token IS NOT NULL;

SELECT outcome, error_code, http_status, count(*) AS attempts,
       max(completed_at) AS latest_at
FROM webhook_delivery_attempts
GROUP BY outcome, error_code, http_status
ORDER BY latest_at DESC;

SELECT count(*) AS unknown_attempts, max(completed_at) AS latest_unknown_at
FROM webhook_delivery_attempts
WHERE outcome = 'unknown';

SELECT count(*) AS terminal_count, min(dead_lettered_at) AS oldest_terminal_at,
       max(dead_lettered_at) AS newest_terminal_at
FROM webhook_deliveries
WHERE status = 'dead_lettered';
```

Use query plans and narrower time/merchant filters before running large investigations in production. Do not select `payload_bytes`, encrypted secret columns, or endpoint URLs into tickets or chat.

## Triage and containment

1. Confirm whether overall worker readiness failed because PostgreSQL, RabbitMQ publisher/topology, projection consumer, or `webhookDelivery` is down. An individual endpoint DNS/HTTP failure must not make the whole worker non-ready.
2. Compare due age, active/expired leases, and recent outcome/error-code groups. Check the deployment revision and whether all worker instances share compatible migration and keyring configuration.
3. For keyring, schema, grant, or database errors, stop rollout of the affected revision and preserve logs/evidence. Do not allow new delivery claims until compatible configuration is restored.
4. For widespread DNS/TLS/prohibited-destination failures, confirm outbound DNS/egress and certificate infrastructure. Do not bypass re-resolution, HTTPS/443, certificate validation, or special-address blocking.
5. For endpoint-specific `4xx`, redirects, inactive status, or prohibited destinations, record the affected stable IDs and merchant impact. These are terminal by design and are not automatically retried.
6. For `408`, `429`, `5xx`, timeout/reset/refusal, or transient DNS errors, verify that attempts 1-6 are `retrying` and scheduled within the approved full-jitter ceilings. Attempt 7 is terminal.

## Recovery and validation

1. Correct only the failed dependency or reviewed deployment/configuration problem. Production must not use the local keyring provider. Development HTTP must remain limited to explicitly injected exact origins.
2. Restart or roll forward the worker through the approved deployment procedure. Its startup recovery clears expired pre-start leases and records an immutable `unknown` attempt for expired active attempts.
3. Confirm `webhookDelivery` becomes ready and due count/age decreases. Zero-jitter retries can be immediately due but must not overlap an active lease.
4. Confirm each delivery has at most one attempt row per attempt number, `attempt_count` matches durable attempt evidence, terminal rows have no next attempt or claim, and no attempt exceeds seven.
5. Confirm endpoint-specific failures remain isolated, no terminal row reopened, and no unexpected secret/payload/destination data appeared in logs.
6. If a remote endpoint may have accepted an `unknown` attempt, instruct the merchant to deduplicate by `SettleFlow-Webhook-Id`; never promise exactly-once transport.

Escalate immediately if claims overlap, evidence is mutable/missing, a prohibited address was contacted, a plaintext secret/signature/body was logged, a terminal row reopens, attempts exceed seven, or tenant ownership is uncertain. Preserve the deployment revision, structured signals, bounded query output, and incident timeline for security/architecture review.

## Forward recovery and review

Schema/constraint/grant defects require a reviewed additive forward migration; application defects require a reviewed roll-forward or deployment rollback that remains compatible with the applied schema. Do not reverse the migration by dropping attempt evidence or restoring the one-state delivery enum.

- **Last exercised:** 2026-08-02, automated real-PostgreSQL controlled-HTTP integration scenarios.
- **Evidence:** `test/integration/webhook-delivery.int-spec.ts`; environment-specific incident evidence is To be decided.
- **Review cadence:** Every dispatcher schema, retry, signing, URL-policy, keyring, readiness, shutdown, or operational-threshold change, and at least before production release.

See [ADR-0018](../adr/0018-signed-webhook-delivery-contract.md), [ADR-0019](../adr/0019-webhook-delivery-reliability-and-lifecycle.md), the [signed delivery implementation plan](../plans/2026-08-02-signed-webhook-delivery-and-retries.md), [security policy](../../SECURITY.md), and [event contract](../events/README.md).
