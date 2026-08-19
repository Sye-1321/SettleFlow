# System and Reliability Flows

These diagrams describe the implemented SettleFlow finance-grade simulation. The [v1.0 specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx), accepted [ADRs](../adr/README.md), [module boundaries](module-boundaries.md), and [financial invariants](financial-invariants.md) remain authoritative.

## System context

```mermaid
flowchart LR
  Merchant[Merchant backend] -->|Bearer API key; REST /v1| API[API deployable]
  API -->|Merchant-scoped transactions| DB[(PostgreSQL)]
  Worker[Worker deployable] -->|Claims, projections, jobs| DB
  Worker <--> |Confirms and manual acknowledgements| MQ[(RabbitMQ)]
  Worker -->|Signed HTTP POST; no redirects| Hook[Merchant Webhook endpoint]
  Provider[Mock provider CSV] -->|Untrusted bounded upload| API
  API -.->|Internal telemetry| Telemetry[Prometheus and OTLP Collector]
  Worker -.->|Internal telemetry| Telemetry

  classDef authoritative fill:#16324f,color:#fff,stroke:#0b1f33;
  class DB authoritative;
```

PostgreSQL is the only authoritative transactional and financial store. RabbitMQ, merchant endpoints, CSV input, logs, metrics, and traces are non-authoritative. No real payment rail, bank, payout system, or card-data system is connected.

## Payment and Ledger atomicity

```mermaid
sequenceDiagram
  autonumber
  participant M as Merchant backend
  participant A as API / Payments
  participant I as Idempotency
  participant P as PostgreSQL transaction
  participant L as Ledger
  participant E as Eventing

  M->>A: Capture/refund + Idempotency-Key
  A->>I: Acquire merchant/method/route/key fingerprint
  I->>P: Establish single owner
  A->>P: Lock merchant-owned Payment row
  A->>P: Revalidate lifecycle, currency, and amount
  A->>L: Stage fixed balanced posting in P
  L->>P: Entries + posted_at finalization
  A->>P: Update Payment/refund projection
  A->>E: Insert versioned outbox event in P
  A->>I: Complete response snapshot in P
  P-->>A: Commit all effects or roll back all effects
  A-->>M: Stored/replayable response
```

RabbitMQ and Webhook availability are outside this transaction. INV-01 through INV-07 and INV-10 are enforced by row locks, uniqueness, checks, restricted grants, immutable-row triggers, and deferred commit-time Ledger triggers.

## Transactional outbox and inbox

```mermaid
flowchart LR
  TX[Committed domain transaction] --> O[(outbox_events)]
  O -->|Short claim transaction; lease; SKIP LOCKED| Relay[Outbox relay]
  Relay -->|Publish outside DB transaction| Confirm[Publisher confirm]
  Confirm -->|Confirmed only| Published[Mark published_at]
  Confirm -. crash before mark .-> Redelivery[Lease expiry and possible republish]
  Relay --> MQ[(RabbitMQ durable exchange/queues)]
  MQ --> Consumer[State-changing consumer]
  Consumer -->|Validate message and metadata| Inbox[(inbox_messages)]
  Inbox -->|One DB transaction| Effect[Owned projection/effect]
  Effect -->|Commit first| Ack[Manual acknowledgement]
  Redelivery --> Consumer
  Inbox -->|Completed duplicate is a no-op| Ack
```

The design intentionally provides at-least-once delivery. Stable event IDs plus `(consumer_name, message_id)` uniqueness prevent repeated state-changing effects; they do not create an exactly-once transport claim.

## Webhook projection and delivery

```mermaid
flowchart TD
  Event[Validated committed domain event] --> Eligible{Endpoint active and subscribed at projection time?}
  Eligible -- No --> Marker[Retain processed event marker; no historical fanout]
  Eligible -- Yes --> Delivery[(Pending Webhook delivery)]
  Delivery --> Claim[Lease one due delivery]
  Claim --> Recheck{Endpoint active and URL safe after DNS re-resolution?}
  Recheck -- No --> Dead[dead_lettered + immutable attempt evidence]
  Recheck -- Yes --> Sign[Decrypt current and eligible previous secret in memory]
  Sign --> Post[Exact-byte signed POST; 8 s; 64 KiB; no redirects]
  Post -->|2xx| Done[delivered + immutable attempt]
  Post -->|408, 429, 5xx, timeout/reset| Budget{Attempt budget remains?}
  Post -->|3xx or other terminal 4xx| Dead
  Budget -- Yes --> Retry[retrying + full-jitter next_attempt_at]
  Budget -- No --> Dead
  Retry --> Claim
```

Automatic retries keep the delivery ID and exact body but use a new timestamp/signature. Manual replay and merchant delivery inspection are approved v1 waivers and do not exist.

## Settlement and reconciliation

```mermaid
flowchart LR
  Capture[Committed capture/refund events] --> Position[(Settlement positions and adjustments)]
  Position -->|Merchant + currency + cutoff; SKIP LOCKED| Batch[Settlement batch]
  Batch -->|Unique Payment membership| Items[Immutable item/fee snapshots]
  Items -->|One explicit transaction| Posting[Guarded balanced Settlement Ledger posting]
  Posting --> Final[Terminal simulated SETTLED batch]
  Final --> Outbox[settlement.finalized.v1 outbox event]

  CSV[Bounded mock-provider CSV] --> Stage[(Reconciliation staging)]
  Stage --> Match[Deterministic matching and closed buckets]
  Final --> Match
  Match --> Report[(Immutable per-currency report)]
  Report --> RecEvent[reconciliation.completed.v1 outbox event]

  Report -. no mutation .-> Final
  Report -. no mutation .-> Posting
```

A finalized Settlement means simulated internal clearing, not a bank payout. Reconciliation differences are investigation evidence and never authority to edit Payment, Ledger, or Settlement history.

## Deployment and network boundaries

```mermaid
flowchart TB
  Host[Local/release-simulation host]
  Host -->|Loopback-only 3000| API[Non-root API container]
  Host -. optional loopback .-> Prom[Prometheus]

  subgraph Backend[Internal backend network]
    PG[(PostgreSQL)]
    RMQ[(RabbitMQ)]
    Provision[One-shot role provisioner]
    Migrate[One-shot migrator]
    Worker[Non-root worker container]
  end

  subgraph Telemetry[Internal telemetry network]
    Collector[OTLP Collector]
    Prom
  end

  Provision --> PG
  Migrate --> PG
  Migrate -->|Complete before normal startup| API
  Migrate -->|Complete before normal startup| Worker
  API --> PG
  API --> RMQ
  Worker --> PG
  Worker --> RMQ
  API -.-> Collector
  Worker -.-> Collector
  Prom -. scrape internal metrics .-> API
  Prom -. scrape internal metrics .-> Worker
  Worker -->|Restricted outbound Webhook path| Internet[Untrusted endpoint]
```

API, worker, and migrator images are non-root, read-only compatible, capability-free runtime images. PostgreSQL, RabbitMQ, worker probes, application metrics, and OTLP are not public host ports. This is a production-shaped release simulation, not a production deployment topology.

## Failure model

| Failure                   | Preserved guarantee                                      | Observable recovery path                                                            |
| ------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| PostgreSQL unavailable    | No financial command commits                             | API/worker readiness fails; use the database-recovery runbook                       |
| RabbitMQ unavailable      | Committed financial state and outbox intent remain valid | Worker unready; relay retries and backlog alerts fire                               |
| Relay crash after confirm | Republish is allowed                                     | Inbox deduplication prevents another consumer effect                                |
| Consumer crash before ack | Committed effect remains durable                         | Broker redelivery becomes a completed-inbox no-op                                   |
| Merchant endpoint failure | Payment/Settlement state is unchanged                    | Bounded retries end delivered or dead-lettered                                      |
| Settlement race           | One Payment belongs to at most one batch                 | Locks plus unique membership; losing transaction rolls back                         |
| Reconciliation mismatch   | Authoritative records remain immutable                   | Investigate the report; reverse/forward-fix only through an approved financial path |

Use the [runbook index](../runbooks/README.md), [alert catalog](../operations/alert-catalog.md), and [engineering evidence map](../review/engineering-evidence.md) for executable diagnostics and proof.
