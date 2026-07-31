# SettleFlow

SettleFlow is a finance-grade payment-platform simulation and engineering case study. It is not authorized to process real funds or store cardholder data. The authoritative product and architecture baseline is [the SettleFlow specification](docs/specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx).

## Local application and infrastructure foundation

The repository provides two independent NestJS processes and their local supporting services:

- `apps/api`: HTTP API with process liveness and dependency readiness.
- `apps/worker`: standalone background worker with internal lifecycle health.
- `packages/infrastructure`: shared PostgreSQL/RabbitMQ connection lifecycle and lazy Prisma adapter.
- `packages/modules/merchant-access`: bounded-domain API-key generation, lifecycle, authentication, and Prisma persistence.
- `compose.yaml`: local PostgreSQL and RabbitMQ services only.

The only application data currently authorized is Merchant Access: merchant lifecycle roots and merchant-owned scoped API keys. There is no user/password/JWT authentication, merchant self-service onboarding, seed, queue topology, publisher, consumer, payment, ledger, webhook, settlement, reconciliation, provider, or financial behavior.

### Pinned toolchain

| Tool           | Exact version | Selection note                                                     |
| -------------- | ------------- | ------------------------------------------------------------------ |
| Node.js        | 24.18.0       | Current official LTS patch when this scaffold was created          |
| pnpm           | 11.18.0       | Current stable pnpm 11; pnpm 12 is still beta                      |
| NestJS         | 11.1.28       | Current stable NestJS 11 framework line                            |
| TypeScript     | 6.0.3         | Newest stable compiler supported by the pinned lint/test toolchain |
| PostgreSQL     | 18.4          | Current supported PostgreSQL minor, pinned as a Compose image      |
| RabbitMQ       | 4.3.4         | Current fully supported RabbitMQ patch, with management UI         |
| pg             | 8.22.0        | Health-only PostgreSQL client                                      |
| amqplib        | 2.0.1         | RabbitMQ 4.1+ compatible AMQP 0-9-1 client                         |
| Testcontainers | 12.0.4        | Disposable real PostgreSQL/RabbitMQ integration environment        |
| Prisma         | 7.9.1         | Current ORM/CLI patch with the PostgreSQL driver adapter           |
| NestJS Swagger | 11.4.6        | OpenAPI support compatible with the pinned NestJS 11 line          |

The repository pins Node in `.node-version` and `package.json` engine metadata. It pins pnpm in `package.json` package-manager and engine metadata. Direct dependencies use exact versions and one root `pnpm-lock.yaml`.

### Prerequisites and install

- Git.
- Node.js 24.18.0 exactly. Version managers can read `.node-version`.
- Corepack or another official pnpm installation method.
- Docker Engine with Docker Compose for local services and integration tests.

From the repository root:

```shell
corepack enable pnpm
corepack pnpm install --frozen-lockfile
```

For the first lockfile generation only, maintainers use `corepack pnpm install`; normal fresh-clone and CI installs use `--frozen-lockfile`.

Copy the safe, synthetic development examples before starting local services or applications:

```powershell
Copy-Item .env.example .env
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/worker/.env.example apps/worker/.env
```

The copied `.env` files are ignored. The checked-in values are local-development credentials only; never reuse them outside this project or add real secrets to an example.

If a default port is already occupied, change its value in the root `.env` and update the matching application URL. For example, set `POSTGRES_PORT=55432` and use port `55432` in both application `DATABASE_URL` values.

### Start and inspect local infrastructure

Start PostgreSQL and RabbitMQ and wait for both health checks:

```shell
pnpm infra:up
```

Inspect container health, recent logs, and service-native diagnostics:

```shell
pnpm infra:ps
pnpm infra:logs
docker compose exec postgres pg_isready --username settleflow --dbname settleflow
docker compose exec rabbitmq rabbitmq-diagnostics -q ping
```

RabbitMQ management is available at `http://127.0.0.1:15672` with the synthetic values from the root `.env`. Published PostgreSQL, AMQP, and management ports bind to loopback only.

Stop containers without removing them, or remove containers while preserving named volumes:

```shell
docker compose stop
pnpm infra:down
```

Restart stopped services with `pnpm infra:up`. To inspect dependency-failure behavior, stop and restart one service explicitly:

```shell
docker compose stop rabbitmq
docker compose up --detach --wait rabbitmq
```

Resetting is destructive to local PostgreSQL and RabbitMQ state. It removes both named volumes and cannot recover their contents:

```shell
pnpm infra:reset
pnpm infra:up
```

### Prisma and local database workflow

The root `.env` supplies `DATABASE_URL` to Prisma commands. The schema contains exactly two non-financial models authorized by FR-01: `Merchant` and its owned `ApiKey` records. There is no seed command because a committed deterministic API-key secret would violate the one-time-secret requirement, and merchant onboarding is not yet authorized as a public workflow.

Validate the schema and generate the ignored Prisma Client output:

```shell
pnpm prisma:validate
pnpm prisma:generate
```

Apply the reviewed migration history and inspect its status:

```shell
pnpm db:migrate:apply
pnpm db:migrate:status
```

The baseline migration is intentionally empty. The additive Merchant Access migration creates only `merchants` and `api_keys`, their two status enums, indexes, ownership foreign key, and reviewed integrity checks. It creates no financial table or column.

When a later approved domain milestone authorizes a schema change, create but do not immediately apply its migration, inspect the generated SQL, and then apply the committed history:

```shell
pnpm db:migrate:create --name descriptive_name
pnpm db:migrate:apply
```

Open Prisma Studio for local inspection:

```shell
pnpm db:inspect
```

Reset only the local PostgreSQL schema and reapply committed migrations with the interactive command below. This is destructive to all data in the configured database and is never production guidance:

```shell
pnpm db:reset
```

Use `pnpm infra:reset` instead when both local service volumes must be removed. Every migration must be reviewed before application; `prisma db push` is not part of the governed workflow.

### Run the API

```shell
pnpm dev:api
```

The default listener is `http://127.0.0.1:3000` and exposes:

- `GET /health/live` - process liveness.
- `GET /health/ready` - bounded PostgreSQL and RabbitMQ connectivity; HTTP 200 only when both are up, otherwise HTTP 503.
- `GET /api/v1` - API version entrypoint protected by a merchant bearer API key.
- `GET /docs` - public Swagger UI.
- `GET /docs/openapi.json` - public runtime OpenAPI document.

Liveness never performs a dependency check. Readiness returns stable `up`/`down` states and does not expose connection URLs, credentials, or raw errors.

Merchant credentials use `Authorization: Bearer <merchant_api_key>`. The plaintext is returned once by the internal issue or rotation application-service call, while PostgreSQL stores only its safe `sf_test_...` prefix and a salted scrypt hash. Never put a usable key in a shell history, source file, log, screenshot, or documentation. For example, with a disposable locally issued key held only in a process variable:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3000/api/v1 -Headers @{ Authorization = "Bearer $env:SETTLEFLOW_TEST_API_KEY" }
```

No HTTP/CLI key-provisioning command is exposed in this milestone: the specification does not authorize public merchant onboarding or a lifecycle endpoint, and operator authentication/auditing is deferred. Integration tests provision synthetic merchants and one-time keys directly through the bounded-domain application service. See [Merchant Access API and security](docs/api/merchant-access.md).

Generate or verify the committed OpenAPI artifact:

```shell
pnpm openapi:generate
pnpm openapi:check
```

### Run the worker

```shell
pnpm dev:worker
```

The worker is a standalone Nest application context, not an HTTP server. It checks PostgreSQL and RabbitMQ during bootstrap and on each heartbeat, logs internal readiness, remains running but not ready during a dependency outage, becomes unready during shutdown, and closes both dependency clients on `SIGINT`/`SIGTERM`.

### Quality and production commands

```shell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:merchant-access
pnpm test:integration
pnpm build
pnpm start:api
pnpm start:worker
```

`pnpm test` runs Docker-independent API, worker, and Merchant Access unit tests. `pnpm test:integration` starts disposable real PostgreSQL and RabbitMQ containers and requires a working Docker runtime. `pnpm build` creates the shared infrastructure and Merchant Access packages plus independent production entrypoints under `apps/api/dist` and `apps/worker/dist`. Run the two `start` commands in separate terminals after a successful build and with their required environment variables loaded.

Runtime readiness remains health-only: PostgreSQL receives `SELECT 1`, while RabbitMQ receives connection/channel handshakes. No queue, exchange, event, user identity, financial table, or financial behavior is created.

## Governance

Read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), the [architecture overview](docs/architecture/README.md), and the [ADR index](docs/adr/README.md) before extending the scaffold. Implementation plans are governed by [PLANS.md](PLANS.md).
