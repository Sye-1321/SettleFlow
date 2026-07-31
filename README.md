# SettleFlow

SettleFlow is a finance-grade payment-platform simulation and engineering case study. It is not authorized to process real funds or store cardholder data. The authoritative product and architecture baseline is [the SettleFlow specification](docs/specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx).

## Runnable application foundation

The current milestone provides two independent NestJS processes from one pnpm workspace:

- `apps/api`: HTTP API foundation.
- `apps/worker`: standalone background-worker foundation with internal lifecycle health.
- `packages`: reserved for shared code only when a real cross-entrypoint need exists.

No payment, ledger, database, broker, authentication, webhook, settlement, reconciliation, provider, or Docker behavior exists yet.

### Pinned toolchain

| Tool       | Exact version | Selection note                                                     |
| ---------- | ------------- | ------------------------------------------------------------------ |
| Node.js    | 24.18.0       | Current official LTS patch when this scaffold was created          |
| pnpm       | 11.18.0       | Current stable pnpm 11; pnpm 12 is still beta                      |
| NestJS     | 11.1.28       | Current stable NestJS 11 framework line                            |
| TypeScript | 6.0.3         | Newest stable compiler supported by the pinned lint/test toolchain |

The repository pins Node in `.node-version` and `package.json` engine metadata. It pins pnpm in `package.json` package-manager and engine metadata. Direct dependencies use exact versions and one root `pnpm-lock.yaml`.

### Prerequisites and install

- Git.
- Node.js 24.18.0 exactly. Version managers can read `.node-version`.
- Corepack or another official pnpm installation method.

From the repository root:

```shell
corepack enable pnpm
corepack pnpm install --frozen-lockfile
```

For the first lockfile generation only, maintainers use `corepack pnpm install`; normal fresh-clone and CI installs use `--frozen-lockfile`.

Both applications have safe, non-secret examples. Defaults work without local files; copy an example only to override them:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/worker/.env.example apps/worker/.env
```

The copied `.env` files are ignored. Never add real secrets or credentials to an example.

### Run the API

```shell
pnpm dev:api
```

The default listener is `http://127.0.0.1:3000` and exposes:

- `GET /health/live` - process liveness.
- `GET /health/ready` - foundation configuration/bootstrap readiness.
- `GET /api/v1` - API version entrypoint.

The readiness response explicitly lists PostgreSQL as deferred. It is not a claim of final FR-13 dependency readiness; the database milestone must add a real bounded PostgreSQL check.

### Run the worker

```shell
pnpm dev:worker
```

The worker is a standalone Nest application context, not an HTTP server. It logs `worker.ready` after configuration and bootstrap succeed, keeps the process alive, reports internal live/ready state, becomes unready during shutdown, and handles `SIGINT`/`SIGTERM` through Nest shutdown hooks. PostgreSQL and RabbitMQ checks are explicitly deferred until those integrations exist.

### Quality and production commands

```shell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm start:api
pnpm start:worker
```

`pnpm build` creates independent production entrypoints under `apps/api/dist` and `apps/worker/dist`. Run the two `start` commands in separate terminals after a successful build.

## Governance

Read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), the [architecture overview](docs/architecture/README.md), and the [ADR index](docs/adr/README.md) before extending the scaffold. Implementation plans are governed by [PLANS.md](PLANS.md).
