# Reference Performance Workload

SettleFlow's performance suite implements the five synthetic scenarios in specification Table 37. Thresholds are executable k6 pass/fail criteria, but a source definition or `k6 inspect` result is **not** a performance result. No final candidate measurement has been published yet, so performance remains a release blocker.

The suite uses official Grafana k6 `1.8.0`, pinned as the multi-platform OCI index `grafana/k6:1.8.0@sha256:b992f241070f3f3a7d78096fa6020db1edcda49297ee8ed9eb0ab847ef3dcb32`. The wrapper runs it read-only, capability-free, with `no-new-privileges`, a bounded temporary filesystem, local-only target validation, and ignored output under `.settleflow/performance/`.

## Scenarios and thresholds

| Scenario                  | Exact reference shape                                                                                                                           | Executable pass condition                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments-happy-path`     | Ramp to 30 VUs for 30 s, hold 30 VUs for 4 min, ramp down for 30 s; each iteration creates and fully captures one USD Payment                   | `http_req_failed < 1%`, global HTTP p95 `< 300 ms`, checks `>99%`, zero financial-effect validation failures                                                      |
| `idempotency-retry-storm` | 10 command groups/s for 2 min; each group creates one Payment then issues five concurrent same-key capture attempts and a bounded stored replay | Successful response bodies equivalent, one stable Ledger transaction ID, group failure rate zero; HTTP 409 in-progress is an expected bounded intermediate result |
| `webhook-fanout`          | 1,000 Payment creation events, 30 VUs, worker dispatcher concurrency fixed at 4, one pre-registered healthy synthetic endpoint                  | Exactly 1,000 additional successful `payment.created.v1` deliveries and drain `< 300 s`; request failures `<1%`                                                   |
| `settlement-batch`        | 10 synthetic merchants, each with exactly 500 eligible Payments; ten concurrent bounded runs                                                    | Every run finalizes one distinct 500-item batch, no HTTP/check failure, maximum batch duration `< 300 s`; database uniqueness/invariant checks remain mandatory   |
| `reconciliation-import`   | One strict 50,000-row synthetic CSV within the committed 10 MiB limit                                                                           | Stage reports 50,000 rows, worker returns a completed deterministic report, every row is classified, total completion `< 300 s`, no request/check failure         |

The 5-minute budgets make the specification's Webhook drain and documented Settlement/Reconciliation budgets explicit. They are reference-simulation gates, not service-level promises. Do not increase a budget, reduce shape, remove a check, or mark 409/5xx broadly successful to obtain a green result.

## Validate source definitions

Docker must be running with outbound access to the pinned k6 image on first use:

```shell
pnpm performance:check
```

The command invokes `k6 inspect` for all five scripts with bounded synthetic placeholders. It proves the scripts parse, their scenarios/thresholds are loadable, and the expected pinned image is runnable. It makes no request to SettleFlow and records no performance claim.

## Reference environment contract

Final candidate measurements use an isolated, disposable synthetic environment:

- exact candidate API/worker/migrator images built once from the recorded clean commit;
- Linux containers on one host with at least 4 logical CPUs and 8 GiB RAM, with the exact host CPU/RAM/OS/Docker versions recorded;
- API 1 CPU/384 MiB, worker 1 CPU/512 MiB, PostgreSQL 1 CPU/512 MiB, RabbitMQ 1 CPU/512 MiB, and the existing production-shaped database/broker settings;
- PostgreSQL 18.4 and RabbitMQ 4.3.4 at their repository-pinned digests;
- load generator outside the application resource limits; no network proxy or real external dependency;
- API reachable only through host loopback/`host.docker.internal`; PostgreSQL, RabbitMQ, internal probes/metrics, OTLP, and receiver remain non-public;
- one warm-up pass before recorded measurement, then one clean disposable dataset per scenario; and
- synthetic merchant/API-key/Webhook/CSV data only, with one-time secrets kept in ignored process/environment state.

If the actual environment differs, record it and rerun; do not compare results as if hardware/topology were unchanged.

## Required runtime configuration

The wrapper accepts only `http://127.0.0.1`, `http://localhost`, or `http://host.docker.internal` targets. It passes the API key to Docker by inherited environment name, never as a command-line value.

Shared variables:

| Variable              | Meaning                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `SETTLEFLOW_API_KEY`  | One-time synthetic key with the scopes needed by the scenario; ignored and revoked after the run |
| `SETTLEFLOW_BASE_URL` | Local API origin visible from the k6 container                                                   |
| `SETTLEFLOW_RUN_ID`   | 1–32 lowercase alphanumeric/`_`/`-` characters, unique per disposable run                        |

Additional variables:

- `webhook-fanout`: `SETTLEFLOW_WEBHOOK_RECEIVER_URL` points to the synthetic receiver's evidence control route. Before the run, register exactly one active endpoint subscribed to `payment.created.v1` and configure the receiver with its one-time secret.
- `settlement-batch`: `SETTLEFLOW_SETTLEMENT_FIXTURES_JSON` is an ignored JSON array of exactly ten `{apiKey,currency,cutoffDate}` records. Each merchant must have exactly 500 projected, eligible, unbatched Payments and the key must carry independent `settlements:write` and `settlements:read` scopes.
- `reconciliation-import`: `SETTLEFLOW_RECONCILIATION_CSV_HOST` is an absolute host path to the 50,000-row synthetic CSV; `SETTLEFLOW_RECONCILIATION_PERIOD_START` and `_END` are exact UTC millisecond instants forming a positive half-open window no longer than 31 days. The key needs `reconciliation:write` and `reconciliation:read`.

Fixture creation must use Merchant Access, Payments, Ledger, Eventing, and Settlement application ports with the normal runtime role and transaction rules. Direct financial inserts, trigger/grant changes, disabled consumers, hand-edited queue rows, or copied real provider data invalidate the run. The current deterministic demo is a safe pattern, but the final 10×500 and 50,000-row candidate fixture preparation is part of the controlled Step 10 run and must be recorded.

## Run one prepared scenario

After exporting the ignored variables for the selected synthetic environment:

```shell
pnpm performance:run -- payments-happy-path
pnpm performance:run -- idempotency-retry-storm
pnpm performance:run -- webhook-fanout
pnpm performance:run -- settlement-batch
pnpm performance:run -- reconciliation-import
```

Each run writes a local k6 summary to `.settleflow/performance/<scenario>-summary.json`. Do not commit raw summaries until they are sanitized: a public summary may contain only scenario/threshold results, counts, durations, percentiles, environment/resources, candidate commit/image digests, exact k6 image, and limitations. It must not contain API keys, headers, request/response bodies, merchant/payment/reference values, endpoint URLs, CSV rows, or local network details.

## Controlled candidate orchestration

Step 10 uses the repository-owned reference wrapper. It refuses a dirty tree, a branch other than `main`, or a commit that differs from the configured upstream, builds the exact `v1.0.0-rc.1` candidate images, uses only the isolated `settleflow-demo` project and validated volumes, generates one-time ignored credentials, samples bounded container CPU/memory, sanitizes the k6 summaries, and reruns migrations, runtime grants, and INV-01–INV-10 after each measurement.

```shell
pnpm performance:reference:check
pnpm performance:reference:run-ready
```

`run-ready` performs the deterministic demo as the warm-up, resets the isolated volumes, and measures the four scenarios that can start from a freshly provisioned dataset. It deliberately does not represent a release pass: Settlement eligibility requires a business date to close after the capture fixtures were committed.

Prepare the 10×500 Settlement fixture before 21:00 UTC (midnight in `Africa/Addis_Ababa`), leave the isolated candidate containers running, and resume only after the recorded cutoff:

```shell
pnpm performance:reference:prepare-settlement
# after the command's exact UTC cutoff
pnpm performance:reference:resume-settlement
```

The preparation path creates every Payment and capture through the Payments, Ledger, Idempotency, and Eventing application services using `settleflow_app`; it waits for the normal RabbitMQ/Settlement projection and never edits a financial timestamp or row. The resume command refuses a changed commit or image ID. If the process cannot remain isolated across the cutoff, discard it with `pnpm demo:reset -- --yes` and prepare again on the same clean candidate. Never move a cutoff, forge an event, inject a replacement database clock, or update `available_at` to make this gate pass.

Sanitized scenario evidence is written under `.settleflow/performance/evidence/`. Raw summaries, the generated 50,000-row CSV, API keys, and the resumable Settlement state remain ignored and must not be uploaded. The release process attaches only the validated sanitized evidence.

## Correctness checks around load

Performance never substitutes for financial verification. Before and after every recorded run:

```shell
pnpm db:migrate:verify
pnpm db:permissions:check
pnpm db:invariants:check
```

The recorded evidence must additionally prove:

- one Payment/Ledger/outbox effect per idempotency command group;
- no cumulative over-refund or duplicate business reference;
- no Payment appears in two Settlement batches and every batch/Ledger total balances;
- all 1,000 Webhook projections reach the expected terminal state without manual replay; and
- exactly 50,000 Reconciliation rows receive one deterministic bucket with bounded process/container memory recorded.

Any failed threshold, dropped iteration, financial/invariant discrepancy, skipped post-check, secret exposure, or unbounded resource observation fails the release gate. Preserve sanitized evidence and use the applicable [runbook](../docs/runbooks/README.md); never retry only to hide a failure.

## Result record

| Field                                    | Current value         |
| ---------------------------------------- | --------------------- |
| Candidate commit and image digests       | **PENDING — Step 10** |
| Host CPU/RAM/OS/Docker                   | **PENDING — Step 10** |
| Dataset/warm-up/start/end                | **PENDING — Step 10** |
| Five k6 threshold summaries              | **PENDING — Step 10** |
| Database invariant/uniqueness post-check | **PENDING — Step 10** |
| Peak CPU/RAM and backlog/drain evidence  | **PENDING — Step 10** |
| Limitations and clean-room reviewer      | **PENDING — Step 10** |

Until every field is populated from the exact candidate and reviewed, SettleFlow makes no reference-performance pass claim.
