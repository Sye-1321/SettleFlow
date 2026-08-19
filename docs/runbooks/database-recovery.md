# Database Recovery

## Purpose, trigger, and ownership

Use this runbook when PostgreSQL authoritative data is unavailable or lost, a logical backup or checksum fails, the isolated restore exercise fails, or a release gate requires recovery evidence. A confirmed committed-data loss, unexplained Ledger mismatch, or restoration into the wrong target is critical. A failed scheduled backup or failed exercise is high severity and blocks release until corrected.

`@Sye-1321` is the sole Incident Commander, recovery approver, disclosure authority, and release stop/go owner for this simulation. There is no backup maintainer, staffed paging rotation, or 24x7 commitment. Follow the [incident response runbook](incident-response.md) and preserve private evidence.

## Prohibited actions

Never:

- restore into, rename over, or attach the volume of the active source database;
- edit/delete posted Ledger, Payment, refund, Settlement, Reconciliation, audit, outbox, inbox, projection, delivery, or attempt evidence;
- disable triggers/constraints, change migration records, or use `settleflow_app` as a migration owner;
- clear `published_at`, manually move/publish RabbitMQ messages, or claim broker-message recovery;
- print or copy dumps, credentials, keyring values, connection URLs, payloads, raw reconciliation rows, amounts, or signing material into incident records; or
- declare RPO/RTO from an unmeasured target or one-off backup.

## Triage and containment

1. Record the detection time, environment, deployed commit/image digest, last known successful scheduled backup time, alert/check name, and safe correlation identifiers. Do not record sensitive row content.
2. Stop release and new financial traffic through the authorized deployment control if database correctness or availability is uncertain. Do not terminate PostgreSQL merely to simplify diagnosis.
3. Preserve database/container logs and backup manifests privately. Restrict a suspected leaked dump immediately and follow `SECURITY.md`.
4. Confirm whether the issue is source availability, storage loss, checksum failure, migration incompatibility, permission drift, invariant failure, or application readiness. Never repair the source while diagnosing from it.
5. Select the newest complete backup inside the approved cadence. Verify that its private manifest identifies the intended release and that the separately retained Webhook keyring is available.

`SettleFlowPostgresqlUnavailable` is critical after one minute. API/worker readiness and the exact alert state are diagnostic signals, not authorization to mutate data.

## Isolated recovery

Run the documented [backup and isolated recovery procedure](../operations/database-recovery.md). The normal reference command is `pnpm recovery:exercise` with explicit manifest, source commit/version, current image version, and ignored keyring environment file.

The exercise must fail closed unless all of these pass:

- SHA-256 and source-release metadata;
- a fresh `settleflow-recovery-*` project with no pre-existing containers or volumes;
- fresh owner/runtime roles and least-privilege grants;
- logical restore and all later committed migrations;
- exact migration, named constraint/index/trigger, chart, Ledger, Payment/refund/Settlement, asynchronous-evidence, and Reconciliation checks;
- API liveness/readiness and worker readiness against the restored dependencies; and
- a repeated post-start invariant check.

If a step fails, keep the active source unchanged. The tool attempts to delete only its uniquely named disposable recovery project. Inspect residual resources by exact project label before explicit cleanup:

```shell
docker ps --all --filter label=com.docker.compose.project=settleflow-recovery-<exercise-id>
docker volume ls --filter label=com.docker.compose.project=settleflow-recovery-<exercise-id>
```

Do not use a wildcard or a broad Compose/volume deletion command. Preserve the private failed manifest/log evidence long enough for root-cause analysis, then remove it under the approved sensitive-data procedure.

## Validation, RPO/RTO, and return to service

The recovery is eligible for owner approval only when the evidence status is `PASS`, restore duration is no more than 3,600 seconds, and every invariant/readiness check passes. A 900-second PostgreSQL RPO may be claimed only if the scheduled history proves successful backups no more than 15 minutes apart before the simulated loss. A one-off exercise must remain `NOT_CLAIMED_ONE_OFF_EXERCISE`.

Before any real return-to-service decision, compare the recovery cutoff to the incident time, identify the bounded lost-write window, confirm external keyring/config availability, review RabbitMQ's unsupported message-loss window, and obtain the Incident Commander's explicit stop/go record. The local exercise destroys the restored volume after verification and never promotes it.

Close only after recording cause, impact window, measured RPO/RTO, exact backup/image/tool versions, every failed/passed check, sensitive-evidence disposition, and follow-up action. Keep release blocked for an unexplained financial mismatch, missed RPO, failed RTO, missing keyring, unverified permission, or broker replay requirement.

Owner: `@Sye-1321`. Review cadence: after every schema, migration, image, backup, recovery, credential, or invariant-check change and before each release candidate. Last exercise and evidence: recorded in the approved operational-readiness plan after a successful local exercise; no public dump or secret-bearing artifact is retained.
