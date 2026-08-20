# Requirements, Invariants, and Release Evidence Matrix

This matrix records the implemented, waived, deferred, and pending state of the SettleFlow v1 baseline. It is a navigation/evidence artifact, not authority to change a requirement. The [v1.0 specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx), accepted [ADRs](../adr/README.md), and [financial invariants](../architecture/financial-invariants.md) take precedence.

Status meanings:

- **PASS:** implemented and covered by the listed executable/public evidence; final release still reruns the gate.
- **WAIVED:** a P0 portion is absent under the repository owner's explicit first-release waiver; the risk and follow-up remain visible.
- **DEFERRED:** a P1/P2 capability is intentionally outside first-release scope.
- **PENDING:** implementation may exist, but candidate-specific external/manual evidence remains release-blocking.

SettleFlow is only a finance-grade simulation. It does not claim complete specification conformance, production readiness, regulatory approval, or suitability for real funds.

## Functional requirements

| ID / priority                  | Status   | Implemented boundary                                                                                                                                                                               | Primary executable evidence                                                          | Public evidence / gap                                                                                                                                                                                         |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-01 / P0 Merchant API keys   | PASS     | Hashed scoped API keys, one-time plaintext, generic auth failure, merchant predicate, internal issue/revoke/rotate service                                                                         | `merchant-access.int-spec.ts`; credential/service/guard specs                        | [Merchant Access](../api/merchant-access.md), OpenAPI security; lifecycle has no public self-service endpoint by design                                                                                       |
| FR-02 / P0 Payment create/read | PASS     | `/v1/payment-intents` create/read; ETB/USD; exact safe-integer minor units; merchant external-ref uniqueness                                                                                       | `payment-intents.int-spec.ts`; lossless parser/controller/service specs              | [Payment API](../api/payment-intents.md), OpenAPI, HTTP examples                                                                                                                                              |
| FR-03 / P0 Capture             | PASS     | Direct full deterministic mock capture; row lock; one Payment/Ledger/outbox effect; replay snapshot                                                                                                | Payment integration, concurrency/failure suite, Payment/Ledger service specs         | Payment API, demo, atomicity diagram; authorize/partial capture excluded                                                                                                                                      |
| FR-04 / P0 Refunds             | PASS     | Partial/full refunds, positive exact minor units, cumulative row-locked bound, Ledger/outbox atomicity                                                                                             | Payment integration/concurrency tests; capture/refund service and repository specs   | Payment API, demo, capture/refund runbook                                                                                                                                                                     |
| FR-05 / P0 Idempotency         | PASS     | Merchant/method/route/key hash, canonical fingerprint, lease owner, mismatch/in-progress/replay, stored response                                                                                   | Payment/Settlement/Reconciliation integration plus idempotency specs and storms      | ADR-0007, API guides, HTTP collection                                                                                                                                                                         |
| FR-06 / P0 Ledger              | PASS     | Closed chart, fixed postings, deferred balance/currency/count/finalization constraints, immutability, exact reversal                                                                               | `ledger-foundation.int-spec.ts`, migration/invariant/permission checks, Ledger specs | [Ledger foundation](../architecture/ledger-foundation.md), [data model](../architecture/data-model.md)                                                                                                        |
| FR-07 / P0 Outbox              | PASS     | Event row in producer transaction; leased claim; publish confirms; confirmed-only marking; republish tolerance                                                                                     | `outbox-relay.int-spec.ts`, failure/concurrency runs, Eventing specs                 | Event docs, outbox flow, backlog runbook                                                                                                                                                                      |
| FR-08 / P0 Inbox               | PASS     | `(consumer_name,message_id)` dedupe, owned effect in same transaction, ack after commit                                                                                                            | Webhook/Settlement consumer integration, duplicate/crash/poison tests                | Event docs, inbox flow, projection runbook                                                                                                                                                                    |
| FR-09 / P0 Webhook endpoints   | PASS     | Merchant create/list/get/patch/rotate; ETag; active/subscriptions; encrypted current/previous secret; SSRF URL policy                                                                              | `webhook-endpoints.int-spec.ts`; validation/crypto/URL/service specs                 | [Webhook Endpoint API](../api/webhook-endpoints.md), ADR-0014–0017                                                                                                                                            |
| FR-10 / P0 Webhook delivery    | WAIVED   | Exact-byte HMAC delivery, attempt history, jittered seven-attempt lifecycle, dead-letter state and SSRF re-resolution pass; controlled manual replay and merchant delivery inspection do not exist | `webhook-delivery.int-spec.ts`; signature/retry/HTTP/client specs and failure suite  | [Event/Webhook contract](../events/README.md); waiver owner `@Sye-1321`; risk: no operator/merchant recovery surface; follow-up: post-v1 operator-authenticated replay/inspection milestone before next minor |
| FR-11 / P0 Settlement          | PASS     | Merchant/currency/cutoff eligibility, max-500 locked selection, unique membership, fee snapshots, guarded Ledger posting, adjustments, audit/outbox                                                | `settlements-reconciliation.int-spec.ts`, concurrency/failure runs, Settlement specs | [Settlement API](../api/settlements.md), ADR-0021, settlement runbook                                                                                                                                         |
| FR-12 / P0 Reconciliation      | PASS     | Strict bounded mock CSV, checksum/idempotency, failed staging, deterministic buckets/totals, non-mutating report/outbox                                                                            | Settlement/Reconciliation integration and CSV/classifier/repository/service specs    | [Reconciliation API](../api/reconciliation.md), fixture, runbook                                                                                                                                              |
| FR-13 / P0 Operations          | PASS     | Public process/dependency health compatibility routes, internal-only API/worker probes/metrics, request IDs, structured redaction, bounded metrics/alerts                                          | readiness integration; telemetry/config/lifecycle/metric/alert tests                 | [Observability](../operations/observability.md), [alert catalog](../operations/alert-catalog.md), configuration                                                                                               |
| FR-14 / P0 Audit               | PASS     | Append-only privileged endpoint status/subscription/rotation and Settlement/Reconciliation actions with actor/target/reason/request/time                                                           | Webhook/Settlement/Reconciliation integration, audit specs, permission checks        | Threat model/data model; replay audit path is absent with the FR-10 waiver rather than falsely recorded                                                                                                       |
| FR-15 / P1 Authorization flow  | DEFERRED | No authorization state/expiry or partial capture; direct full capture only                                                                                                                         | Boundary/contract tests prove current closed behavior                                | Owner `@Sye-1321`; follow-up: new lifecycle/financial ADR after v1                                                                                                                                            |
| FR-16 / P1 Dashboards/search   | DEFERRED | Prometheus, alerts, metrics, and runbooks only; no Grafana/dashboard/operator search                                                                                                               | Telemetry/alert validation                                                           | Owner `@Sye-1321`; follow-up: post-v1 operations UX milestone                                                                                                                                                 |

## Financial invariants

| ID                                      | Status | Enforcement                                                                          | Required proof location                                                       |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| INV-01 positive entries                 | PASS   | `BIGINT` amount check greater than zero                                              | Ledger database integration and `db:invariants:check`                         |
| INV-02 at least two entries             | PASS   | Deferred constraint trigger at commit                                                | Single-entry commit-negative test                                             |
| INV-03 debits equal credits             | PASS   | Deferred numeric aggregate trigger at commit                                         | Balanced positive and imbalance-negative tests                                |
| INV-04 one transaction currency         | PASS   | Composite FKs plus deferred currency trigger                                         | Mixed-currency commit-negative test                                           |
| INV-05 posted rows immutable            | PASS   | Update/delete/truncate triggers plus restricted `settleflow_app` grants              | Mutation and permission-negative tests                                        |
| INV-06 reversal-only correction         | PASS   | Unique same-merchant/currency reversal link and exact opposite-entry trigger/service | Exact reversal, duplicate, chain, and original-unchanged tests                |
| INV-07 no over-refund                   | PASS   | Payment row lock plus cumulative projection check                                    | Concurrent refund sum and rollback tests                                      |
| INV-08 unique Settlement membership     | PASS   | Unique `payment_intent_id` on batch item plus locked candidates                      | Repeated dual-worker Settlement races                                         |
| INV-09 one batch merchant/currency      | PASS   | Composite owner/currency foreign keys and item/total validation                      | Cross-owner/currency negatives and finalized arithmetic tests                 |
| INV-10 duplicate command has one effect | PASS   | Idempotency uniqueness/snapshot plus domain/Ledger/event business keys               | Same-key storms, changed fingerprints, Settlement/Reconciliation replay tests |

No release waiver applies to INV-01 through INV-10. Any failure stops release.

## P0 waiver and retention register

| Missing P0 surface                                           | Rationale                                                                                                           | Risk                                                                   | Owner and follow-up                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Controlled/manual Webhook replay and privileged replay audit | Safe replay needs separate operator authentication, reason capture, new delivery identity, and authorization design | Dead-lettered delivery cannot be recovered through an approved command | `@Sye-1321`; approve replay ADR/plan before next minor                             |
| Merchant Webhook-delivery inspection API                     | Query filters, tenant disclosure, retention, and operational semantics were not safely designed in v1               | Merchant cannot self-inspect terminal/attempt state                    | `@Sye-1321`; Webhook operations milestone before next minor                        |
| Public Ledger transaction read API                           | Accounting disclosure, pagination, and authorization are outside the minimum posting foundation                     | Ledger proof remains internal/database/test evidence                   | `@Sye-1321`; Ledger read-model ADR before next minor                               |
| Destructive Table 23 retention jobs                          | Outbox/inbox/marker/audit/financial deletion can break dedupe, no-historical-fanout, or evidence guarantees         | Data grows; configured disposal windows are not enforced               | `@Sye-1321`; approve retention/deletion invariants before any purge implementation |

The repository retains financial/audit/Webhook marker evidence conservatively and provides no hidden deletion command.

## Operational limitations and release treatment

| Limitation                                                 | Release treatment                                                         | Risk/mitigation                                                                                             | Owner/review                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Catastrophic RabbitMQ-volume loss after outbox publication | Accepted simulation limitation; no full async RPO or message-backup claim | Published-but-unconsumed work can be lost; declarative topology only; no manual `published_at`/queue repair | `@Sye-1321`; recovery/replay design before next minor |
| PostgreSQL RPO                                             | PENDING and unclaimed                                                     | Isolated restore/RTO passes, but one-off backup does not prove <=15-minute cadence                          | `@Sye-1321`; Step 10/future scheduler evidence        |
| Production deployment/KMS                                  | Deferred                                                                  | Release Compose and local keyring are simulation-only; production mode rejects local provider               | `@Sye-1321`; production-deployment ADR if pursued     |
| No 24x7/SLA/backup maintainer                              | Accepted public maintenance boundary                                      | Single-owner availability/bus-factor risk is disclosed                                                      | `@Sye-1321`; review before next minor                 |
| Initial version has no prior public upgrade fixture        | Accepted first-release limitation                                         | Future schema compatibility is unproven against a public version                                            | `@Sye-1321`; mandatory starting `v1.0.1`              |
| Reference performance result                               | PENDING                                                                   | Executable scenario definitions exist; no final candidate environment claim yet                             | `@Sye-1321`; Step 10 candidate run                    |
| GitHub PVR/notifications/tabletop                          | PARTIAL: PVR and tabletop pass; email check pending                       | Private intake/triage/closure is exercised; account-level email delivery is not machine-verifiable          | `@Sye-1321`; confirm email before `v1.0.0`            |
| Clean-room review and immutable artifact promotion         | PENDING                                                                   | Local/CI evidence is not final independent release approval                                                 | `@Sye-1321` plus clean-room reviewer; Step 10         |

## Release-gate evidence

| Specification gate | Current state                           | Evidence and final action                                                                                                                                   |
| ------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness        | PASS snapshot                           | Unit/integration/concurrency/failure/database invariant gates; rerun on candidate                                                                           |
| Contracts          | PASS snapshot                           | OpenAPI/event/example contract checks; rerun and attach candidate artifacts                                                                                 |
| Concurrency        | PASS snapshot                           | Repeated capture/refund/idempotency/relay/Settlement races; no retry-to-green                                                                               |
| Security           | PARTIAL: owner email check              | Tenant, signature/SSRF/CSV/secret/dependency/image gates pass; Private Vulnerability Reporting and the tabletop pass; confirm Security-alert email delivery |
| Operations         | PASS snapshot                           | Internal health/metrics/log correlation, executable alerts, and runbooks                                                                                    |
| Recovery           | PARTIAL                                 | Isolated restore/RTO passes; sustained RPO and async replay remain unclaimed/limited                                                                        |
| Reproducibility    | PASS implementation, PENDING clean room | Deterministic demo exists; fresh-clone timed independent run is Step 10                                                                                     |
| Documentation      | PASS for Step 9 after current checks    | README, architecture/ERD/ADRs/API/contribution/security/limits/release/evidence pack                                                                        |
| Performance        | PENDING                                 | Five Table 37 k6 contracts; final environment/run results required before tag                                                                               |

## Exact verification entry points

```shell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:coverage
pnpm test:integration
pnpm test:concurrency
pnpm test:failure
pnpm prisma:validate
pnpm db:migrate:verify
pnpm db:permissions:check
pnpm db:invariants:check
pnpm boundaries:check
pnpm contracts:check
pnpm openapi:check
pnpm config:check
pnpm telemetry:check
pnpm security:policy
pnpm security:secrets
pnpm docs:check
pnpm performance:check
```

Current workflow state, exact counts, versions, image digests, and dated evidence belong in the [engineering evidence guide](engineering-evidence.md) and final sanitized release summary. This matrix must be reviewed before every minor release and whenever a requirement, waiver, or limitation changes.
