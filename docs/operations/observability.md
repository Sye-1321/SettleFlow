# Observability and Internal Probes

SettleFlow exposes disposable operational evidence for its finance-grade simulation. Telemetry never authorizes a state change, participates in a database transaction, changes an acknowledgement or lease decision, or substitutes for audit and financial records.

## Runtime contract

Both deployables emit one JSON object per stdout line. Infrastructure owns serialization, redaction, correlation context, metrics, tracing, and the internal diagnostic listener. Stable fields include `timestamp`, `level`, `service`, `environment`, `releaseVersion`, `releaseCommit`, `event`, optional stable `code`, request/event/resource correlation IDs, and bounded numeric fields. API request completion uses the HTTP method, route template, status class, duration, and canonical request ID; it never uses the raw URL.

The allowlist removes authorization values, API and idempotency keys, bodies, money amounts, external/provider references, reconciliation content or checksums, Webhook destinations/bytes/signatures/secrets, database and broker URLs, SQL, stack traces, and arbitrary exception text. Merchant IDs and safe public IDs may appear only as correlation fields. They are never Prometheus labels.

`AsyncLocalStorage` isolates request context. Authentication enriches the current API context only after a merchant key succeeds. Existing validated request IDs, event IDs, AMQP correlation IDs, and delivery IDs remain the cross-process correlation chain; strict event bodies are unchanged and do not acquire trace fields.

## Internal listeners

The checked-in development examples enable dedicated loopback listeners:

| Deployable | Default listener        |
| ---------- | ----------------------- |
| API        | `http://127.0.0.1:9464` |
| Worker     | `http://127.0.0.1:9465` |

Each listener provides:

- `GET /health/live`: process-only liveness;
- `GET /health/ready`: HTTP 200 only while the process is accepting work and every required dependency class is ready, otherwise HTTP 503; and
- `GET /metrics`: Prometheus text exposition from a process-local registry.

These routes are absent from the merchant OpenAPI document, require no merchant credential, and rely on a loopback/network boundary. The implementation rejects a public wildcard bind. Do not publish or proxy the listeners. The API's existing public `/health/live` and `/health/ready` contracts remain unchanged.

Worker readiness preserves separate PostgreSQL, RabbitMQ publisher, RabbitMQ consumer, Reconciliation processor, and Webhook dispatcher checks. API readiness preserves its PostgreSQL/RabbitMQ policy. A dependency outage changes readiness but not liveness. Shutdown makes readiness false before claims, consumers, and connections drain.

## Metrics and traces

Every process owns a distinct `prom-client` registry with the `settleflow_` prefix. Label schemas are closed and contain only bounded dimensions such as service, command, outcome, event type, dependency, HTTP status class, and ETB/USD currency. Identifier-shaped labels are rejected. Backlog gauges declared by the catalog are not populated by command handling; bounded background collectors are deferred with the Prometheus configuration milestone.

OpenTelemetry tracing is disabled by default. Enable it only with both:

```dotenv
OTEL_TRACING_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
```

The release policy records all spans in-process so final errors can always be selected, then exports 10% of successful traces deterministically and 100% of error or explicit demo spans. The batch queue is bounded. Attribute allowlists exclude event bodies, amounts, destinations, SQL, credentials, and raw exceptions. Export failure, queue overflow, serialization failure, or a metrics error drops telemetry and increments bounded self-observation where possible; it never changes business behavior.

The Collector, Prometheus scrape configuration, executable alerts, and optional Compose profile are intentionally deferred to implementation-order step 4. No dashboard or trace-storage backend is planned for v1.

## Configuration

Both deployables validate the following settings before accepting work:

| Setting                              | API default | Worker default | Rule                                     |
| ------------------------------------ | ----------- | -------------- | ---------------------------------------- |
| `INTERNAL_TELEMETRY_ENABLED`         | environment | environment    | examples set `true`; tests default false |
| `INTERNAL_TELEMETRY_HOST`            | `127.0.0.1` | `127.0.0.1`    | loopback only in this milestone          |
| `INTERNAL_TELEMETRY_PORT`            | `9464`      | `9465`         | 1-65535                                  |
| `RELEASE_VERSION`                    | `0.0.0-dev` | `0.0.0-dev`    | bounded build identity                   |
| `RELEASE_COMMIT`                     | `local`     | `local`        | `local` or 7-64 hexadecimal characters   |
| `OTEL_TRACING_ENABLED`               | `false`     | `false`        | exact boolean text                       |
| `OTEL_TRACE_SAMPLE_RATIO`            | `0.1`       | `0.1`          | fixed approved successful sampling ratio |
| `OTEL_TRACE_EXPORT_TIMEOUT_MS`       | `5000`      | `5000`         | bounded 100-10000 milliseconds           |
| `OTEL_DEMO_TRACE_MODE`               | `false`     | `false`        | exports every explicitly simulated trace |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset       | unset          | required HTTP(S) URL only when enabled   |

Release identity appears only in startup telemetry, traces, metrics, and future image metadata. It does not change `GET /v1`.

## Local verification

```shell
pnpm config:check
pnpm test:infrastructure
pnpm test:api
pnpm test:worker
```

With an application running, inspect only through loopback:

```powershell
Invoke-RestMethod http://127.0.0.1:9464/health/ready
Invoke-WebRequest http://127.0.0.1:9464/metrics
Invoke-RestMethod http://127.0.0.1:9465/health/ready
Invoke-WebRequest http://127.0.0.1:9465/metrics
```

Use the [telemetry degradation runbook](../runbooks/telemetry-degradation.md) for exporter or diagnostic-path failure. Financial diagnosis still requires authoritative PostgreSQL evidence and the domain-specific runbook.
