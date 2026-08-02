# Webhook Endpoint Foundation Failures

## Purpose and trigger

Use this runbook when endpoint registration, lifecycle changes, secret rotation, URL resolution, encryption, lifecycle audit, or the `settleflow_app` database permission boundary fails. This foundation does not deliver webhooks; delivery attempts, HTTP failures, RabbitMQ consumption, and dead letters belong to later runbooks.

- **Severity:** To be decided from merchant impact and duration.
- **Prerequisites:** Read-only application logs, read-only database access, deployment/configuration visibility, and incident tracking.
- **Required operator role:** To be decided. Database owner, key-management, or environment changes require separately approved privileged access.
- **Owner:** SettleFlow Project.
- **Review cadence:** On any endpoint schema, URL policy, keyring, database-role, or audit change, and at least before each release.
- **Last exercised / evidence:** To be decided after the first controlled failure-injection exercise.

Never place API keys, webhook plaintext secrets, encryption keys, ciphertext, nonces, authentication tags, authorization headers, or full request bodies in an incident record or terminal transcript.

## Safe diagnosis

Confirm infrastructure and migration state without printing credentials:

```shell
pnpm infra:ps
docker compose exec postgres pg_isready --username settleflow --dbname settleflow
pnpm db:migrate:status
```

Confirm that the runtime role exists and has the expected connect/schema/table boundary. Run this only through the approved owner provisioning workflow; do not paste a password into a command:

```shell
pnpm db:provision-runtime-role
```

Use sanitized request ID, merchant ID, endpoint public ID, audit event ID, status code, error code, route template, and duration to correlate failures. Do not log or query secret columns during routine diagnosis.

With approved read-only database access, inspect bounded metadata and audit counts only:

```sql
SELECT status, count(*)
FROM webhook_endpoints
GROUP BY status;

SELECT action, count(*), min(occurred_at), max(occurred_at)
FROM audit_events
WHERE target_type = 'webhook_endpoint'
GROUP BY action;
```

Confirm permission shape without modifying data:

```sql
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'settleflow_app'
  AND table_schema = 'public'
  AND table_name IN (
    'webhook_endpoints',
    'webhook_endpoint_subscriptions',
    'webhook_endpoint_secrets',
    'audit_events'
  )
ORDER BY table_name, privilege_type;
```

Expected: endpoint-owned tables allow the runtime operations required by the API; `audit_events` allows `SELECT` and `INSERT` only. PostgreSQL triggers independently reject audit update, delete, and truncate.

## Failure classes and containment

### Runtime-role or migration failure

1. Stop deployment progression; do not switch applications to the owner credential.
2. Confirm Compose PostgreSQL is healthy and the root ignored `.env` contains the distinct owner `MIGRATION_DATABASE_URL` and runtime `DATABASE_URL` values.
3. Re-run idempotent role provisioning, then the reviewed migration history.
4. Re-run migration status and the permission integration tests before restoring traffic.

### Keyring or decryption failure

1. Preserve the affected endpoint ID, key ID, request ID, and sanitized error code; never copy key material or encrypted fields into logs.
2. Confirm that the active key ID exists in the injected key map and every still-referenced historical key remains available.
3. Do not replace or delete a referenced key. Restore the approved secret-store/configuration version and restart through normal deployment controls.
4. If a merchant lost a one-time secret response, instruct it to rotate using the current ETag. Never recover or redisplay plaintext from storage.

### URL-policy or DNS failure

1. Preserve only the normalized origin/hostname and sanitized validation code. Do not expose resolver internals in the public response.
2. Confirm the two-second DNS bound, 16-answer limit, IANA registry version, production HTTPS/443 policy, and exact development-origin allowlist configuration.
3. Do not bypass reserved-address checks or add a broad CIDR/origin exception. A policy change requires security review and an ADR update where material.
4. Ask the merchant to correct DNS or register a permitted immutable URL. URL mutation is not a recovery mechanism.

### Audit failure

1. Treat a failed audit append as a failed endpoint mutation; the transaction must roll back.
2. Preserve application/database errors and correlation IDs without editing endpoint or audit rows.
3. Verify storage availability, grants, triggers, and schema state. Apply only a reviewed migration or controlled forward fix.
4. Escalate any apparent successful mutation without matching audit evidence as a security incident.

## Recovery validation

Before declaring recovery:

1. Run focused unit and PostgreSQL integration tests for URL policy, cryptography, ETags, ownership, audit atomicity, and runtime permissions.
2. Prove a create response reveals its secret once, later reads omit it, and a rotation maintains current plus previous encrypted records with a 24-hour expiry.
3. Prove stale and missing preconditions do not mutate endpoint state or audit.
4. Prove cross-merchant reads and mutations return the same result as a missing endpoint.
5. Run existing Payment Intent, readiness, and outbox-relay regressions under `settleflow_app`.
6. Record the final request/error counts, impact interval, configuration or migration version, corrective change, and evidence in the incident record.

No financial invariant should change because this foundation owns no financial state. Confirm there was no new RabbitMQ consumer, external HTTP delivery, payment transition, ledger write, settlement activity, or manual data edit during recovery.

## Prohibited actions

- Do not update, delete, truncate, disable triggers on, or manually recreate lifecycle audit records.
- Do not manually edit endpoint, subscription, secret, Payment Intent, idempotency, outbox, ledger, balance, or settlement rows.
- Do not run applications as the database owner or grant the runtime role ownership, schema creation, audit mutation, or superuser privileges.
- Do not log, export, decrypt for inspection, or redisplay signing secrets or keyring material.
- Do not disable SSRF checks, permit wildcard development origins, or treat development HTTP policy as production-safe.
- Do not invent a delivery, replay, retention deletion, or secret-cleanup procedure before those milestones are approved.

Escalation contacts, communication owner, environment dashboards, thresholds, and production KMS recovery are **To be decided** before production readiness.
