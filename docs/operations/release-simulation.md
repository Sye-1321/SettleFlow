# OCI Images and Release Simulation

SettleFlow's release simulation builds and runs the API and worker as pinned, non-root OCI images behind a production-shaped local boundary. It is a finance-grade simulation, not a production deployment: it deliberately uses the development-only local Webhook keyring because a production KMS adapter is deferred. Configuration validation rejects attempts to run this topology with `NODE_ENV=production`.

## Security and topology

The multi-stage root `Dockerfile` uses the exact Node.js 24.18.0 Trixie-slim digest for the toolchain, pnpm 11.18.0, and exact OpenSSL build packages. Final stages use the exact distroless Node.js 24 Debian 13 digest and contain production dependencies and compiled JavaScript only; they have no npm, Corepack, Yarn, shell, or package manager. They run as fixed UID/GID `10001:10001`, use the absolute exec-form distroless Node entrypoint, accept `SIGTERM`, have read-only root filesystems and bounded `/tmp` filesystems, drop all Linux capabilities, and prohibit privilege escalation. OCI source, revision, version, and created labels are set from the generated configuration. The controlled `images:build` command invokes Bake with explicit maximal-provenance and SBOM attestations and loads the three images for inspection. Keeping these BuildKit-only options outside the Compose model preserves validation on the GitHub runner's supported Compose schema. The local Docker image store must support attested manifest lists; CI pins Docker Engine 28.0.4 with its containerd image store enabled, and other hosts fail closed if they cannot retain the requested attestations.

The separate `compose.release.yaml` project is always named `settleflow-release-simulation`. PostgreSQL and RabbitMQ have persistent named volumes and only an internal backend network. Neither service publishes a host port. The worker publishes no port. API port 3000 is the only default business ingress and binds to `127.0.0.1`. API/worker diagnostic ports 9464/9465 remain inside the telemetry network.

An optional `telemetry` profile starts the already-pinned Collector and Prometheus images. OTLP and application metric listeners remain internal. Only the Prometheus UI is loopback-bound, on port 9091 by default. The release profile adds no dashboard or Alertmanager.

## Create configuration

Generate high-entropy, per-service ignored configuration once:

```shell
pnpm release:config:create
pnpm release:config:check
pnpm release:compose:check
```

The files are placed under ignored `.settleflow/release-simulation/`. The generator refuses incomplete, placeholder, or partially modified existing configuration; it never silently rotates credentials and never prints their values. On POSIX hosts it creates the directory as mode `0700` and files as `0600`. Keep that directory local and restricted.

Owner database credentials are confined to `postgres.env`, `role-provisioner.env`, and `migrator.env`. API and worker receive only the non-owner `settleflow_app` database identity and the synthetic RabbitMQ identity. Do not run `docker compose ... config` without `--quiet` in logs because Compose's rendered model includes environment values; use `pnpm release:compose:check`, which inspects the model without emitting it.

## Build and validate images

Docker BuildKit and Compose v2 are required. Build from the repository root; `.dockerignore` excludes Git metadata, local environments, caches, test output, documentation, and generated host artifacts from the context:

```shell
pnpm clean
pnpm images:build
pnpm images:validate
```

The validation checks image user/entrypoint/health metadata and OCI labels, asserts that no secret-bearing environment is baked into any image, and runs all three images under the same read-only/non-root/capability restrictions. API/worker inspection rejects source, test, map, TypeScript build, Prisma CLI, and development-dependency artifacts; migrator inspection requires only its locked Prisma migration runtime, schema, committed migrations, and verifier.

The images are tagged `settleflow-api:0.0.0-sim`, `settleflow-worker:0.0.0-sim`, and `settleflow-migrator:0.0.0-sim`; no `latest` tag is used. Public registry publication is outside this slice.

## Start, inspect, and stop

Start the base release simulation and wait for health:

```shell
pnpm release:up
pnpm release:ps
```

Startup is ordered and fail-closed:

1. PostgreSQL and RabbitMQ must be healthy.
2. `role-provisioner` creates/updates only the guarded `settleflow_app` role and exits successfully.
3. The one-shot `migrator` applies committed Prisma migrations as the database owner, then verifies exact migration history, runtime grants, and financial invariants before exiting successfully.
4. API and worker may start only after that successful migration job and healthy dependencies. Both must pass their existing readiness contracts.

No application process receives the migration-owner URL. Provisioning/migration jobs use `restart: "no"`; a failed job blocks startup rather than looping or allowing partially initialized applications. Prisma migrations remain idempotent, but one orchestration has one named migrator service rather than per-process migration hooks.

Smoke the loopback API and inspect container health:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready
pnpm release:ps
```

The business `GET /v1` route remains merchant-authenticated and therefore returns `401` until a separately provisioned synthetic merchant API key is supplied. The release configuration generator never creates business data or credentials. The separate, explicitly guarded [deterministic demo](../demo/README.md) provisions its synthetic identity only inside the isolated `settleflow-demo` environment.

After the base simulation is healthy, start only the optional internal telemetry services when required:

```shell
pnpm release:up:telemetry
```

The targeted command uses `--no-deps` so it cannot restart role provisioning, migrations, API, worker, PostgreSQL, or RabbitMQ. It fails unless the base topology and networks already exist. Prometheus is then available only at `http://127.0.0.1:9091`. Stop cleanly while preserving PostgreSQL, RabbitMQ, and Prometheus named volumes:

```shell
pnpm release:down
```

`release:down` sends the existing graceful shutdown path and does not delete volumes or generated secrets. Inspect bounded logs with `pnpm release:logs`; structured application logging redacts credentials and sensitive payloads, but configuration files themselves must never be copied into support output.

## Reset and recovery boundaries

Deleting volumes destroys all local release-simulation data. Only after confirming the exact project name, reset explicitly with:

```shell
docker compose --env-file .settleflow/release-simulation/compose.env -f compose.release.yaml down --volumes --remove-orphans
```

Remove `.settleflow/release-simulation/` separately only when deliberate credential rotation is required, then rerun `pnpm release:config:create`. That directory is not a backup. Backup/restore exercises, production KMS, registry publication, CI release automation, real providers/payouts, and production support remain deferred by the approved release plan.
