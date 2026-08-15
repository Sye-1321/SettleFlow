# Local Development

This guide contains the detailed setup and command reference for developing SettleFlow locally. SettleFlow remains a finance-grade simulation: use only synthetic credentials, merchants, payments, statements, and Webhook destinations.

## Workspace and toolchain

The pnpm workspace builds two independent NestJS processes:

- `apps/api`: merchant HTTP API, public liveness/readiness, and an internal diagnostic listener;
- `apps/worker`: outbox relay, RabbitMQ consumers, Webhook delivery, Settlement projections, and Reconciliation processing;
- `packages/infrastructure`: shared PostgreSQL, RabbitMQ, Prisma, identifier, and telemetry adapters; and
- `packages/modules/*`: bounded Merchant Access, Payments, Idempotency, Ledger, Eventing, Webhooks, Settlements, Reconciliation, and Operations modules.

Persistence ownership and permitted dependencies are defined in [Module Boundaries](../architecture/module-boundaries.md).

| Tool           | Exact version |
| -------------- | ------------- |
| Node.js        | 24.18.0       |
| pnpm           | 11.18.0       |
| NestJS         | 11.1.28       |
| TypeScript     | 6.0.3         |
| PostgreSQL     | 18.4          |
| RabbitMQ       | 4.3.4         |
| Prisma         | 7.9.1         |
| Testcontainers | 12.0.4        |

Exact direct dependency versions live in `package.json`; external service images are version-and-digest pinned in Compose. Node is pinned in `.node-version` and `package.json`, pnpm is pinned in `package.json`, and the repository has one root `pnpm-lock.yaml`.

## Prerequisites and installation

Install Git, the exact Node.js version, pnpm through Corepack or another official installation method, and Docker Engine with Docker Compose. From the repository root:

```shell
corepack enable pnpm
pnpm install --frozen-lockfile
```

Normal local and CI installation uses the committed lockfile. Only a deliberate dependency-change workflow may regenerate it.

Copy the safe development examples into ignored files.

PowerShell:

```powershell
Copy-Item .env.example .env
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/worker/.env.example apps/worker/.env
```

POSIX shell:

```sh
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
```

Generate a synthetic 32-byte local Webhook-encryption key:

```shell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Replace the placeholder value in `WEBHOOK_LOCAL_KEYS_JSON` in both ignored application environments with that same key. The checked-in credentials and URLs are development-only. Never place real secrets in an example, source file, command output, log, screenshot, or shell history.

The local keyring and development URL policy are rejected under `NODE_ENV=production`; a production KMS adapter remains deferred. If a default port is occupied, change the root `.env` value and every matching application dependency URL together.

## Local PostgreSQL and RabbitMQ

Start both supporting services and provision the non-owner application role:

```shell
pnpm infra:up
pnpm db:provision-runtime-role
```

Role provisioning is idempotent. Migrations and provisioning use the owner URL; API and worker connections use the separate `settleflow_app` role.

Inspect health and bounded recent logs:

```shell
pnpm infra:ps
pnpm infra:logs
docker compose exec postgres pg_isready --username settleflow --dbname settleflow
docker compose exec rabbitmq rabbitmq-diagnostics -q ping
```

Published development service ports bind to loopback. RabbitMQ management is available at `http://127.0.0.1:15672` with the synthetic root environment values.

Stop containers while retaining their named volumes:

```shell
docker compose stop
pnpm infra:down
```

To inspect dependency degradation, stop and restore one service explicitly:

```shell
docker compose stop rabbitmq
docker compose up --detach --wait rabbitmq
```

`pnpm infra:reset` is destructive: it removes the local PostgreSQL and RabbitMQ volumes and their contents. After an intentional reset, start the services and provision the runtime role again.

## Prisma and migrations

The root `MIGRATION_DATABASE_URL` is owner-only; application `DATABASE_URL` values use `settleflow_app`. Validate the schema and generate the ignored Prisma Client:

```shell
pnpm prisma:validate
pnpm prisma:generate
```

Apply and inspect the committed migration history:

```shell
pnpm db:migrate:apply
pnpm db:migrate:status
```

For a separately approved schema milestone, create a migration without immediately applying it, review the generated SQL, and then apply the committed history:

```shell
pnpm db:migrate:create --name descriptive_name
pnpm db:migrate:apply
```

Open Prisma Studio with `pnpm db:inspect`. `pnpm db:reset` destroys all data in the configured local PostgreSQL schema and reapplies migrations; it is not production guidance. `prisma db push` is outside the governed workflow.

The schema deliberately has no mutable stored balance or Settlement-status column. The migration history contains no real provider, payout, or synthetic financial posting data. Financial schema and posting details are documented in [Financial Invariants](../architecture/financial-invariants.md) and the [Immutable Ledger Foundation](../architecture/ledger-foundation.md).

## Run the applications

Start the API and worker in separate terminals:

```shell
pnpm dev:api
```

```shell
pnpm dev:worker
```

The API defaults to `http://127.0.0.1:3000`:

- `GET /health/live` reports process liveness;
- `GET /health/ready` checks PostgreSQL and RabbitMQ and returns 503 when either is unavailable;
- `GET /docs` serves Swagger UI; and
- `GET /docs/openapi.json` serves the runtime OpenAPI contract.

Merchant routes use `Authorization: Bearer <merchant_api_key>` and explicit scopes. There is no public merchant-onboarding or API-key provisioning endpoint; integration and demo tooling provision synthetic identities through the bounded application service. Route definitions, examples, scopes, idempotency, and errors are documented by the committed [OpenAPI contract](../api/openapi.json) and the guides under `docs/api/`.

The worker has no public business listener. Its loopback diagnostic listener exposes internal liveness, readiness, and metrics. Readiness requires its database, publisher, consumer, Reconciliation, Webhook, and keyring dependencies; shutdown stops new claims, drains bounded active work, and closes dependency resources. Exact worker configuration defaults are documented in `apps/worker/.env.example`, while event topology and recovery behavior live in [Events and Webhook Signing](../events/README.md) and the [runbooks](../runbooks/README.md).

Generate or verify the committed OpenAPI artifact with:

```shell
pnpm openapi:generate
pnpm openapi:check
```

## Demo and release simulation

The deterministic demo has a separate Compose identity, disposable volumes, generated credentials, and a mandatory safety sentinel:

```powershell
$env:SETTLEFLOW_DEMO_MODE = 'true'
pnpm demo
```

Read the [Deterministic Demo](../demo/README.md) before running its separately guarded destructive reset.

The production-shaped local simulation builds non-root runtime images, provisions the least-privilege role, and runs migrations once before API/worker startup:

```shell
pnpm release:config:create
pnpm release:compose:check
pnpm images:build
pnpm images:validate
pnpm release:up
pnpm release:ps
```

Only API port 3000 is loopback-published by default. PostgreSQL, RabbitMQ, worker, OTLP, and application metrics remain internal. This topology is not production: follow [OCI Images and Release Simulation](release-simulation.md) for its security boundary, optional telemetry profile, shutdown, and reset behavior.

## Verification

Common source gates:

```shell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm boundaries:check
pnpm docs:check
pnpm contracts:check
pnpm config:check
pnpm security:policy
pnpm test
pnpm test:coverage
pnpm test:integration
pnpm build
```

Database-specific gates require the checked local Compose target:

```shell
pnpm db:migrate:verify
pnpm db:permissions:check
pnpm db:invariants:check
pnpm db:schema:drift
```

Concurrency and dependency-failure evidence is available through `pnpm test:concurrency` and `pnpm test:failure`. Docker is required for integration, database, telemetry, image, and release-simulation verification. The complete gate contract and focused commands are maintained in [Continuous Integration and Supply-Chain Evidence](continuous-integration.md).

## Operational references

- [Observability and internal probes](observability.md)
- [Executable alert catalog](alert-catalog.md)
- [Operational runbooks](../runbooks/README.md)
- [Merchant Access API](../api/merchant-access.md)
- [Payment Intent API](../api/payment-intents.md)
- [Webhook Endpoint API](../api/webhook-endpoints.md)
- [Settlement API](../api/settlements.md)
- [Reconciliation API](../api/reconciliation.md)

Never run API or worker with the migration-owner credential, manually edit posted Ledger/audit/outbox/inbox/Webhook evidence, or weaken a verification gate to make a local run pass.
