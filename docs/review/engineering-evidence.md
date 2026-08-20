# SettleFlow Engineering Evidence

This guide provides a concise path through the executable evidence behind SettleFlow's public claims. The authoritative [v1.0 specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx), accepted [ADRs](../adr/README.md), and [financial invariants](../architecture/financial-invariants.md) take precedence over this summary.

SettleFlow is a pre-release **finance-grade simulation**. It does not process real funds, store cardholder data, initiate payouts, or claim production, regulatory, security, or compliance certification.

## Fifteen-minute review path

1. Read the [architecture overview](../architecture/README.md) and [module boundaries](../architecture/module-boundaries.md).
2. Inspect [INV-01 through INV-10](../architecture/financial-invariants.md) and the [Ledger foundation](../architecture/ledger-foundation.md).
3. Review the committed [OpenAPI contract](../api/openapi.json) and [event schemas](../events/README.md).
4. Inspect the [CI and supply-chain contract](../operations/continuous-integration.md).
5. Check the [requirements/invariants matrix](requirements-evidence-matrix.md), then run the isolated [deterministic demonstration](../demo/README.md) when Docker is available.

## Claim-to-evidence map

| Claim                                                      | Enforcement boundary                                                                                   | Primary executable evidence                                                                     | Operator evidence                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Merchant data cannot cross tenant boundaries               | Authenticated merchant ID in each owned database predicate                                             | Merchant Access and PostgreSQL integration tenant-negative cases                                | Stable authorization error codes; no credential logging  |
| Duplicate Payment commands create one effect               | Merchant/method/route/key uniqueness, canonical fingerprint, lease ownership, stored response snapshot | Same-key storms, changed-fingerprint conflict, replay equivalence, stale-owner recovery         | `payment.command` bounded outcomes and idempotency state |
| Payment state, Ledger posting, and event intent are atomic | One explicit PostgreSQL transaction across Payments, Ledger, and Eventing ports                        | Rollback injection, constraint-negative tests, committed evidence joins                         | No broker dependency in synchronous financial success    |
| Ledger postings remain balanced and immutable              | Deferred constraint triggers, immutable-row triggers, restricted runtime grants                        | Single-entry, imbalance, mixed-currency, update/delete, reversal, and permission-negative tests | Ledger invariant alert and preservation-first runbook    |
| Refunds cannot exceed capture                              | Payment row lock, cumulative projection constraint, exact minor-unit arithmetic                        | Concurrent refund requests whose total exceeds capture                                          | Stable conflict response; no compensating row edit       |
| Outbox delivery tolerates crashes and duplicates           | Short PostgreSQL leases, publish outside claim transaction, confirms, stable event IDs                 | Competing relays, broker outage, publish-before-mark recovery, duplicate consumption            | Backlog age/count metrics and outbox runbook             |
| State-changing consumers are idempotent                    | Consumer/message inbox uniqueness and acknowledgement after database commit                            | Redelivery, crash-before-ack, invalid message, and transient-dependency cases                   | Dedup counters, DLQ signals, consumer readiness          |
| Webhook delivery is signed and SSRF-aware                  | Exact persisted bytes, HMAC-SHA-256, endpoint secrets, DNS/IP policy, no redirects                     | Signature vectors, stale timestamp, rotation overlap, URL/DNS corpus, retry classification      | Immutable attempt evidence and delivery runbook          |
| Settlements cannot double-claim a Payment                  | Locked selection plus unique Payment membership and merchant/currency checks                           | Dual-worker races, fee/net arithmetic, adjustment, and guarded-posting tests                    | Batch/audit/outbox evidence and mismatch runbook         |
| Reconciliation is deterministic and non-mutating           | Bounded staging, merchant isolation, closed result buckets, immutable source records                   | Exact-match, malformed, duplicate, wrong-merchant, out-of-window, and mismatch tests            | Currency-separated summaries and investigation runbooks  |
| Telemetry cannot decide financial outcomes                 | Infrastructure-owned non-interfering adapters outside transaction decisions                            | Export failure, redaction, label-cardinality, readiness, and shutdown tests                     | Internal-only probes, bounded metrics, executable alerts |

## Financial transaction boundary

Capture and refund use one explicit PostgreSQL transaction to:

1. establish the idempotency owner and lock the merchant-owned Payment;
2. re-check lifecycle, currency, amount, and cumulative projections;
3. stage and finalize one balanced immutable Ledger transaction;
4. update the Payment/refund projection;
5. insert the versioned outbox event and complete the response snapshot; and
6. commit every effect together or roll back every effect.

RabbitMQ publication, Webhook projection, and outbound delivery happen only after commit and may repeat. SettleFlow does not claim exactly-once messaging.

Settlement finalization has its own explicit transaction and guarded Ledger posting. Reconciliation never edits Payment, Ledger, or Settlement financial history; mismatches are investigation evidence, not authority to repair rows.

## Verification commands

The repository scripts are the local source of truth:

```shell
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm boundaries:check
pnpm contracts:check
pnpm openapi:check
pnpm test
pnpm test:coverage
pnpm test:integration
pnpm test:concurrency
pnpm test:failure
pnpm prisma:validate
pnpm db:migrate:verify
pnpm db:permissions:check
pnpm db:invariants:check
pnpm telemetry:check
pnpm security:policy
pnpm docs:check
```

Docker is required for real PostgreSQL, RabbitMQ, HTTP, image, telemetry, and release-simulation evidence. GitHub Actions runs the same repository-owned gates on `main`, with scheduled no-retry reliability evidence and an independent security/supply-chain workflow.

## Current verified posture

| Gate            | Current evidence                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coverage        | 91.46% statements, 84.71% branches, 91.80% functions, and 92.13% lines globally; all seven critical-module floors pass                                      |
| Database        | Complete committed migration history, runtime grants, schema drift, deferred constraints, and financial invariant verification pass against real PostgreSQL |
| Integration     | Real PostgreSQL/RabbitMQ/HTTP suites cover API, workers, messaging, Webhooks, settlement, reconciliation, failure, and concurrency behavior                 |
| Runtime images  | API, worker, and migrator use pinned distroless `base-nossl`, exact Node, no-QUIC shared OpenSSL, fixed non-root identity, and read-only execution          |
| Vulnerabilities | Zero critical and zero unreviewed high findings in the three runtime images; no active security exception                                                   |
| Supply chain    | Frozen lockfile, dependency/license review, secret scanning, CodeQL, Dockerfile policy, SPDX SBOMs, and bounded provenance evidence                         |
| Contracts       | Strict `/v1` OpenAPI and the five closed event schemas pass drift/extra-field validation                                                                    |
| Operations      | Internal health/metrics, structured redaction, alert rules, dependency degradation, and graceful shutdown are executable                                    |
| Recovery        | Isolated logical restore, grants/invariants, and API/worker smoke pass; measured RTO was 78 seconds, while sustained-cadence RPO remains unclaimed          |

Current workflow state is available from [CI](https://github.com/Sye-1321/SettleFlow/actions/workflows/ci.yml), [Security and supply chain](https://github.com/Sye-1321/SettleFlow/actions/workflows/security.yml), and [Reliability evidence](https://github.com/Sye-1321/SettleFlow/actions/workflows/nightly.yml). Historical percentages and results are evidence snapshots, not a substitute for the current workflow result.

## Known limitations

The following work remains outside the current verified posture:

- sustained-cadence PostgreSQL RPO evidence; the isolated restore/RTO exercise is implemented and passes;
- final-candidate execution and environment/results for the five source-controlled reference performance scenarios;
- production KMS, real provider/payout integration, and catastrophic RabbitMQ-loss replay;
- authorize-then-capture, partial capture, dashboards/operator search, public Ledger reads, Webhook delivery inspection/manual replay, and destructive retention jobs;
- the clean-room release review, immutable `v1.0.0` artifacts, and public GHCR publication.

These limitations are deliberate and release-blocking where required. They are governed by the [operational-readiness and v1 release plan](../plans/2026-08-03-operational-readiness-and-v1-release.md), not hidden behind the successful demo or green CI.

## Evidence integrity

- PostgreSQL is the authoritative financial store; RabbitMQ and telemetry are not.
- Test fixtures, logs, screenshots, statements, destinations, and credentials are synthetic.
- No secret, authorization value, signing material, raw financial request body, CSV row, or full Webhook payload belongs in public evidence.
- A failed gate remains failed until its cause is resolved; thresholds, constraints, and negative tests are not weakened to obtain a green result.
- Posted financial and immutable audit evidence is never repaired through direct row mutation.

The detailed P0/P1, INV-01–INV-10, waiver, deferral, limitation, and pending-release record is the [requirements evidence matrix](requirements-evidence-matrix.md). Neither page is final `v1.0.0` approval.
