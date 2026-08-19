# PostgreSQL Backup and Isolated Recovery

SettleFlow backs up PostgreSQL because it is the authoritative transactional and financial store. RabbitMQ and telemetry are not backup authorities. This procedure is a local recovery exercise for a finance-grade simulation; it is not a managed backup service or a production disaster-recovery claim.

## Safety boundary

The backup is a PostgreSQL custom-format logical dump created by the same digest-pinned PostgreSQL 18.4 image used by the release simulation. `pg_dump` runs with `--no-owner` and `--no-acl`. The tool writes `database.dump` and a closed-schema SHA-256 `manifest.json` to an operator-selected directory.

The dump contains financial evidence, API-key hashes, encrypted Webhook secrets, and other sensitive persisted data. Therefore:

- use synthetic data only for the public repository exercise;
- select an access-restricted directory on encrypted local storage or an approved encrypted external volume;
- pass `--acknowledge-sensitive-storage` only after verifying that storage property;
- keep the directory ignored by Git when it is inside the repository;
- never attach a dump or its private manifest to CI, an issue, a release, or a public artifact; and
- manage the Webhook keyring separately from the database backup. The restore tool reads an ignored keyring environment file but never adds key material to the backup.

The repository-local reference directory `.settleflow/recovery/` is ignored. On Windows, the tool cannot prove BitLocker or filesystem ACL policy; that remains the operator's responsibility. On POSIX systems the tool also applies directory mode `0700` and file mode `0600`.

## Create a backup

The source PostgreSQL service must be running and healthy. The release-simulation path is:

```shell
pnpm release:config:check
pnpm release:up
pnpm recovery:backup -- --source release-simulation --output-dir .settleflow/recovery/backups --acknowledge-sensitive-storage
```

The deterministic demo is a stronger synthetic-data exercise. After running `pnpm demo`, start only its existing PostgreSQL volume and create the backup:

```shell
docker compose --project-name settleflow-demo --env-file .settleflow/demo/compose.env --file compose.demo.yaml up --detach --wait postgres
pnpm recovery:backup -- --source demo --output-dir .settleflow/recovery/backups --acknowledge-sensitive-storage
```

The command does not print credentials, connection strings, dump bytes, financial amounts, or payloads. A failed dump is removed before a manifest can be marked `COMPLETE`. Retain the generated backup directory name privately.

## Exercise an isolated restore

Build the API, worker, and migrator images from the current checkout before the exercise. The restore refuses an image whose OCI revision label differs from the current commit and refuses `latest`.

Read the private manifest to obtain the expected source commit and source release version. Supply those values explicitly so the tool cannot silently restore the wrong release:

```powershell
$manifestPath = '.settleflow/recovery/backups/<backup-id>/manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath | ConvertFrom-Json
pnpm recovery:exercise -- --manifest $manifestPath --expected-source-commit $manifest.source.sourceCommit --expected-source-version $manifest.source.releaseVersion --image-version 0.0.0-sim --keyring-env-file .settleflow/release-simulation/api.env
```

For a demo backup, use `--image-version 0.0.0-demo` and `.settleflow/demo/api.env`. The exercise:

1. verifies the closed manifest, dump size, SHA-256, and exact expected source metadata;
2. creates a randomly named `settleflow-recovery-*` Compose project with fresh PostgreSQL and RabbitMQ volumes;
3. provisions a new owner/runtime credential boundary without restoring database-role password hashes;
4. restores with `pg_restore --exit-on-error --no-owner --no-acl --single-transaction`;
5. reapplies the reviewed current least-privilege table grants that `--no-acl` deliberately omits, then applies any later committed migrations through the migrator image;
6. verifies exact migration history, named constraints/indexes/triggers, deferred enforcement, runtime grants, the closed eight-account chart, Ledger balance/finalization/ownership, Payment/refund/Settlement totals, reconciliation summaries, and asynchronous evidence relationships;
7. starts the API and worker, checks API liveness/readiness and worker readiness, then repeats the read-only database verification; and
8. writes ignored, sanitized timing/evidence JSON before removing its disposable containers, networks, volumes, and successfully used ephemeral recovery credentials.

PostgreSQL, RabbitMQ, and the worker publish no host ports. The temporary API binds only to `127.0.0.1:14000` by default; use `--api-port` to select another loopback port. The tool never targets the source project or source volumes for cleanup.

## Interpret recovery evidence

The evidence records backup age, a simulated data-cutoff interval, restore duration, exact tool versions, and named pass checks. The reference targets are PostgreSQL RPO at most 15 minutes and RTO at most 60 minutes.

A one-off dump and restore proves restorability and may prove the measured RTO. It does **not** prove the RPO. SettleFlow may claim the 15-minute RPO only after an external approved scheduler has produced successful backups no more than 15 minutes apart and a restore from that cadence has passed. The current tool deliberately records `NOT_CLAIMED_ONE_OFF_EXERCISE` otherwise. Missed/failed schedules restart the evidence window; do not average them away.

## RabbitMQ limitation

The recovery project recreates RabbitMQ topology when the worker starts, but it does not back up or restore broker messages. Catastrophic broker-volume loss can lose an event that was marked published in PostgreSQL but was not yet durably consumed. Never clear `outbox_events.published_at`, move queues, or publish stored payloads manually. Controlled replay requires a separately approved authenticated and audited design. The evidence therefore states `TOPOLOGY_ONLY_NO_MESSAGE_BACKUP` and makes no full asynchronous RPO claim.

For loss events or a failed exercise, follow the [database recovery runbook](../runbooks/database-recovery.md) and [incident response runbook](../runbooks/incident-response.md). Image construction and topology are documented in [release simulation](release-simulation.md).
