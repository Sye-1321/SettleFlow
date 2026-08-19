# Configuration Reference

SettleFlow validates API and worker configuration before normal startup. This reference documents the committed environment contract; the executable validators in `apps/api/src/config/environment.ts` and `apps/worker/src/config/environment.ts` are definitive for types, bounds, defaults, and cross-field rules.

Use only the safe placeholders in [root](../../.env.example), [API](../../apps/api/.env.example), and [worker](../../apps/worker/.env.example) examples. Copy them to ignored `.env` files and replace credentials/key material locally. Never commit, paste into issue output, or attach generated `.settleflow/` configuration.

## Configuration precedence and modes

- `NODE_ENV` is `development`, `test`, or `production`; default is `development`.
- `SETTLEFLOW_DEPLOYMENT_MODE` is `host` or `release-simulation`; default is `host`.
- Host mode requires the internal telemetry listener on loopback. Release-simulation mode requires `NODE_ENV=development` and listener address `0.0.0.0` **inside** the private container network.
- `NODE_ENV=production` requires the production Webhook URL policy, an empty development-origin allowlist, and a non-local keyring. Because only the local keyring adapter exists, the repository's Compose topology is deliberately named release-simulation and must not be described as production.
- Generated demo/release/recovery credentials are random, ignored, short-lived files. Application processes receive the runtime-role URL; only provisioner/migrator tools receive owner credentials.

## Shared API and worker variables

| Variable                              | Required/default                                      | Contract                                                                              |
| ------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                        | Required                                              | `postgres://` or `postgresql://`; normal processes use non-owner `settleflow_app`     |
| `RABBITMQ_URL`                        | Required                                              | `amqp://` or `amqps://`; no credential may appear in logs                             |
| `NODE_ENV`                            | `development`                                         | Closed environment enum and production cross-checks above                             |
| `SETTLEFLOW_DEPLOYMENT_MODE`          | `host`                                                | Host/release-simulation listener policy                                               |
| `DEPENDENCY_READINESS_TIMEOUT_MS`     | `2000`                                                | Integer 100–10,000 ms for bounded dependency checks                                   |
| `RELEASE_VERSION`                     | `0.0.0-dev`                                           | Safe artifact label, 1–64 characters; does not change the `/v1` API response          |
| `RELEASE_COMMIT`                      | `local`                                               | `local` or 7–64 hexadecimal commit characters                                         |
| `INTERNAL_TELEMETRY_ENABLED`          | Enabled outside tests                                 | Exact `true`/`false`; never turns telemetry into a business dependency                |
| `INTERNAL_TELEMETRY_HOST`             | `127.0.0.1`                                           | `127.0.0.1`, `::1`, `localhost`, or the release-simulation-only internal `0.0.0.0`    |
| `INTERNAL_TELEMETRY_PORT`             | API `9464`; worker `9465`                             | Integer TCP port 1–65,535; must not be publicly exposed                               |
| `OTEL_TRACING_ENABLED`                | `false`                                               | Exact boolean; requires an exporter endpoint when true                                |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | Conditional                                           | HTTP(S) OTLP/HTTP traces endpoint; required only when tracing is enabled              |
| `OTEL_TRACE_SAMPLE_RATIO`             | `0.1`                                                 | Fixed approved successful-trace sample ratio of 10%                                   |
| `OTEL_TRACE_EXPORT_TIMEOUT_MS`        | `5000`                                                | Integer 100–10,000 ms; exporter failure is non-interfering                            |
| `OTEL_DEMO_TRACE_MODE`                | `false`                                               | Exact boolean; the isolated demo records all approved demo/error traces               |
| `WEBHOOK_URL_POLICY_MODE`             | `production` in validator; examples use `development` | Production enforces HTTPS/443/global addresses; development requires explicit origins |
| `WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS` | `[]`                                                  | JSON array of canonical origins; forbidden in production                              |
| `WEBHOOK_KEYRING_PROVIDER`            | `local`                                               | Only implemented adapter; forbidden when `NODE_ENV=production`                        |
| `WEBHOOK_LOCAL_ACTIVE_KEY_ID`         | Required                                              | 1–64-character key identifier, not key material                                       |
| `WEBHOOK_LOCAL_KEYS_JSON`             | Required                                              | JSON key-ID-to-32-byte-base64url-key map, maximum 4 KiB; secret and never logged      |

## API variables

| Variable                                | Default     | Contract                                                                          |
| --------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `API_HOST`                              | `127.0.0.1` | Public HTTP bind address; release Compose publishes the API on host loopback only |
| `API_PORT`                              | `3000`      | Integer 1–65,535                                                                  |
| `IDEMPOTENCY_LEASE_MS`                  | `30000`     | Integer 1,000–300,000 ms                                                          |
| `IDEMPOTENCY_LOCK_TIMEOUT_MS`           | `5000`      | Integer 100–30,000 ms and no greater than statement timeout                       |
| `IDEMPOTENCY_STATEMENT_TIMEOUT_MS`      | `10000`     | Integer 1,000–120,000 ms and shorter than owner lease                             |
| `IDEMPOTENCY_REPLAY_TTL_HOURS`          | `168`       | Integer 24–8,760 hours; no destructive purge job is implemented                   |
| `WEBHOOK_ENDPOINT_LOCK_TIMEOUT_MS`      | `5000`      | Integer 100–30,000 ms and no greater than endpoint statement timeout              |
| `WEBHOOK_ENDPOINT_STATEMENT_TIMEOUT_MS` | `10000`     | Integer 1,000–120,000 ms                                                          |

The public API serves merchant routes on `API_HOST:API_PORT`. API internal `GET /health/live`, `GET /health/ready`, and `GET /metrics` are served separately on the internal telemetry listener; the public `/health/*` compatibility routes remain documented in OpenAPI, while internal metrics never are.

## Worker relay and consumer variables

| Variable                                  | Default | Contract                                                |
| ----------------------------------------- | ------- | ------------------------------------------------------- |
| `WORKER_HEARTBEAT_INTERVAL_MS`            | `30000` | Integer 1,000–300,000 ms                                |
| `OUTBOX_RELAY_BATCH_SIZE`                 | `50`    | Integer 1–50                                            |
| `OUTBOX_RELAY_POLL_INTERVAL_MS`           | `500`   | Integer 50–60,000 ms                                    |
| `OUTBOX_RELAY_LEASE_MS`                   | `30000` | Integer 1,000–300,000 ms                                |
| `OUTBOX_RELAY_CONFIRM_TIMEOUT_MS`         | `5000`  | Integer 100–30,000 ms and shorter than relay lease      |
| `OUTBOX_RELAY_RETRY_BASE_MS`              | `1000`  | Integer 100–60,000 ms and no greater than retry maximum |
| `OUTBOX_RELAY_RETRY_MAX_MS`               | `60000` | Integer 1,000–300,000 ms                                |
| `OUTBOX_RELAY_SHUTDOWN_TIMEOUT_MS`        | `10000` | Integer 1,000–60,000 ms                                 |
| `SETTLEMENT_CONSUMER_BODY_LIMIT_BYTES`    | `16384` | Fixed 16 KiB                                            |
| `SETTLEMENT_CONSUMER_PREFETCH`            | `2`     | Fixed at 2                                              |
| `SETTLEMENT_CONSUMER_RECONNECT_BASE_MS`   | `1000`  | Fixed 1-second base                                     |
| `SETTLEMENT_CONSUMER_RECONNECT_MAX_MS`    | `60000` | Fixed 60-second maximum                                 |
| `SETTLEMENT_CONSUMER_SHUTDOWN_TIMEOUT_MS` | `10000` | Fixed 10-second drain                                   |
| `RECONCILIATION_POLL_INTERVAL_MS`         | `500`   | Integer 100–60,000 ms                                   |

## Worker Webhook projection and delivery variables

| Variable                                 | Default | Contract                                 |
| ---------------------------------------- | ------- | ---------------------------------------- |
| `WEBHOOK_PROJECTION_BODY_LIMIT_BYTES`    | `16384` | Fixed 16 KiB validated body limit        |
| `WEBHOOK_PROJECTION_PREFETCH`            | `2`     | Fixed consumer prefetch/concurrency      |
| `WEBHOOK_PROJECTION_RECONNECT_BASE_MS`   | `1000`  | Fixed 1-second base                      |
| `WEBHOOK_PROJECTION_RECONNECT_MAX_MS`    | `60000` | Fixed 60-second maximum                  |
| `WEBHOOK_PROJECTION_SHUTDOWN_TIMEOUT_MS` | `10000` | Fixed 10-second drain                    |
| `WEBHOOK_PROJECTION_TRANSACTION_RETRIES` | `3`     | Fixed serialization/deadlock retry count |
| `WEBHOOK_DELIVERY_BATCH_SIZE`            | `4`     | Fixed claim batch                        |
| `WEBHOOK_DELIVERY_CONCURRENCY`           | `4`     | Fixed dispatcher concurrency             |
| `WEBHOOK_DELIVERY_POLL_INTERVAL_MS`      | `500`   | Fixed 500 ms                             |
| `WEBHOOK_DELIVERY_LEASE_MS`              | `30000` | Fixed 30-second lease                    |
| `WEBHOOK_DELIVERY_ATTEMPT_TIMEOUT_MS`    | `8000`  | Fixed 8 seconds and shorter than lease   |
| `WEBHOOK_DELIVERY_RESPONSE_LIMIT_BYTES`  | `65536` | Fixed 64 KiB response cap                |
| `WEBHOOK_DELIVERY_SHUTDOWN_TIMEOUT_MS`   | `10000` | Fixed 10-second drain                    |
| `WEBHOOK_DELIVERY_TRANSACTION_RETRIES`   | `3`     | Fixed transaction retry count            |

## Operational metric collection

| Variable                               | Default | Contract                                             |
| -------------------------------------- | ------- | ---------------------------------------------------- |
| `OPERATIONAL_METRICS_POLL_INTERVAL_MS` | `15000` | Integer 5,000–300,000 ms                             |
| `OPERATIONAL_METRICS_QUERY_TIMEOUT_MS` | `2000`  | Integer 100–10,000 ms and shorter than poll interval |

Collector failure retains the last safe bounded values and emits failure/freshness signals; it never changes readiness, message acknowledgement, retry, lease, or financial state. Labels cannot contain merchant, request, payment, Ledger, event, endpoint, delivery, Settlement, or Reconciliation identifiers.

## Supporting-service and migration variables

The root example configures local Compose interpolation:

| Group              | Variables                                                                                                               | Exposure rule                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| PostgreSQL owner   | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`, `MIGRATION_DATABASE_URL`                          | Owner credentials are migration/provisioning-only; local port is loopback/dev only              |
| PostgreSQL runtime | `POSTGRES_APP_USER`, `POSTGRES_APP_PASSWORD`, `DATABASE_URL`                                                            | Exact role name is `settleflow_app`; normal API/worker URL only                                 |
| RabbitMQ           | `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS`, `RABBITMQ_DEFAULT_VHOST`, `RABBITMQ_PORT`, `RABBITMQ_MANAGEMENT_PORT` | Supporting-service ports are local-development only; release-simulation broker has no host port |
| Optional telemetry | `OTEL_GRPC_PORT`, `OTEL_HTTP_PORT`, `PROMETHEUS_PORT`                                                                   | Loopback-only in local profiles; application metric listeners remain internal                   |

`pnpm release:config:create`, `pnpm demo`, and recovery tooling generate their own ignored random credentials rather than consuming committed defaults. Do not manually copy those values into documentation or artifacts.

## Validation and safe diagnosis

Run:

```shell
pnpm config:check
pnpm release:config:create
pnpm release:config:check
pnpm release:compose:check
pnpm telemetry:check
```

On startup validation failure, correct the ignored environment source and restart. Do not relax a range/cross-field rule, print the parsed environment, or place credentials on the command line to obtain a passing result. See [local development](local-development.md), [release simulation](release-simulation.md), [observability](observability.md), and the [telemetry degradation runbook](../runbooks/telemetry-degradation.md).
