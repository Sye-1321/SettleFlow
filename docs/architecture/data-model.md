# Data Model and Schema Inventory

This is a readable inventory of the committed Prisma/PostgreSQL schema. It contains no database contents. [Prisma schema](../../prisma/schema.prisma) and committed [migrations](../../prisma/migrations) are executable evidence; the [specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx), [financial invariants](financial-invariants.md), and accepted ADRs remain authoritative.

PostgreSQL is the sole authoritative transactional and financial store. Internal primary keys are UUIDs unless a model uses a documented composite/business key; external identifiers use the accepted prefixed ULID forms. Money is stored as integer `BIGINT` minor units with an explicit ETB/USD currency.

## Ownership inventory

| Owner           | Tables                                                                                                                                                               | Purpose and critical boundary                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Merchant Access | `merchants`, `api_keys`                                                                                                                                              | Tenant root; one-time API-key plaintext, slow hash at rest, closed scopes and lifecycle                |
| Payments        | `payment_intents`, `refunds`                                                                                                                                         | Merchant-owned Payment lifecycle and immutable refund results; no Settlement status column             |
| Ledger          | `ledger_accounts`, `ledger_transactions`, `ledger_entries`                                                                                                           | Closed chart and immutable posted double-entry accounting enforced at commit                           |
| Idempotency     | `idempotency_keys`                                                                                                                                                   | Single-winner command ownership, request fingerprint, lease, and response snapshot                     |
| Eventing        | `outbox_events`, `inbox_messages`                                                                                                                                    | Atomic event intent, publish leases, and durable consumer deduplication                                |
| Webhooks        | `webhook_endpoints`, `webhook_endpoint_subscriptions`, `webhook_endpoint_secrets`, `webhook_event_projections`, `webhook_deliveries`, `webhook_delivery_attempts`    | Endpoint policy, encrypted secrets, exact event bytes, leased delivery, and immutable attempt evidence |
| Settlements     | `settlement_streams`, `settlement_fee_policies`, `settlement_positions`, `settlement_runs`, `settlement_batches`, `settlement_batch_items`, `settlement_adjustments` | Event-driven eligibility, immutable fee/item snapshots, unique membership, and simulated clearing      |
| Reconciliation  | `reconciliation_imports`, `reconciliation_provider_rows`, `reconciliation_results`, `reconciliation_summaries`                                                       | Bounded untrusted staging and deterministic, non-mutating per-currency evidence                        |
| Operations      | `audit_events`                                                                                                                                                       | Append-only privileged lifecycle/action evidence                                                       |

Physical co-location does not grant cross-module writes. An owner exposes application ports or stable merchant-scoped readers; foreign keys reinforce integrity without changing ownership.

## Merchant, Payment, Ledger, and command records

```mermaid
erDiagram
  MERCHANT ||--o{ API_KEY : owns
  MERCHANT ||--o{ PAYMENT_INTENT : owns
  PAYMENT_INTENT ||--o{ REFUND : receives
  MERCHANT ||--o{ LEDGER_ACCOUNT : provisions
  MERCHANT ||--o{ LEDGER_TRANSACTION : records
  LEDGER_TRANSACTION ||--|{ LEDGER_ENTRY : contains
  LEDGER_ACCOUNT ||--o{ LEDGER_ENTRY : receives
  LEDGER_TRANSACTION o|--o| LEDGER_TRANSACTION : reverses
  MERCHANT ||--o{ IDEMPOTENCY_KEY : scopes
  MERCHANT ||--o{ OUTBOX_EVENT : emits

  MERCHANT {
    uuid id PK
    varchar code UK
    enum status
  }
  API_KEY {
    uuid id PK
    uuid merchant_id FK
    varchar prefix UK
    text secret_hash
    text_array scopes
    enum status
  }
  PAYMENT_INTENT {
    uuid id PK
    varchar public_id UK
    uuid merchant_id FK
    varchar external_ref
    bigint amount_minor
    char3 currency
    enum payment_status
    bigint captured_amount_minor
    bigint refunded_amount_minor
    int version
  }
  REFUND {
    uuid id PK
    varchar public_id UK
    uuid payment_intent_id FK
    uuid merchant_id FK
    bigint amount_minor
    char3 currency
  }
  LEDGER_ACCOUNT {
    uuid id PK
    uuid merchant_id FK
    varchar code
    char3 currency
    enum normal_side
  }
  LEDGER_TRANSACTION {
    uuid id PK
    varchar public_id UK
    uuid merchant_id FK
    char3 currency
    enum business_type
    varchar business_reference
    uuid reversal_of_id UK
    timestamptz posted_at
  }
  LEDGER_ENTRY {
    uuid id PK
    uuid ledger_transaction_id FK
    uuid account_id FK
    uuid merchant_id FK
    smallint entry_seq
    enum side
    bigint amount_minor
    char3 currency
  }
  IDEMPOTENCY_KEY {
    uuid id PK
    uuid merchant_id FK
    varchar http_method
    varchar normalized_route
    bytea key_hash
    bytea request_hash
    enum state
    jsonb response_body
    timestamptz response_expires_at
  }
  OUTBOX_EVENT {
    uuid id PK
    varchar event_id UK
    varchar event_type
    uuid merchant_id FK
    jsonb payload
    timestamptz available_at
    timestamptz lease_expires_at
    timestamptz published_at
  }
```

Merchant/external reference uniqueness, cumulative Payment projections, prefixed public-ID checks, business-reference uniqueness, and composite owner/currency foreign keys are database constraints. Ledger entry positivity is immediate; entry count, debit/credit equality, currency agreement, and posting finalization are deferred constraint triggers checked at commit. Posted rows cannot be updated, deleted, or truncated; exact one-time reversal is the correction mechanism.

## Asynchronous and Webhook records

```mermaid
erDiagram
  MERCHANT ||--o{ WEBHOOK_ENDPOINT : owns
  WEBHOOK_ENDPOINT ||--o{ WEBHOOK_ENDPOINT_SUBSCRIPTION : subscribes
  WEBHOOK_ENDPOINT ||--o{ WEBHOOK_ENDPOINT_SECRET : rotates
  MERCHANT ||--o{ WEBHOOK_EVENT_PROJECTION : projects
  WEBHOOK_EVENT_PROJECTION ||--o{ WEBHOOK_DELIVERY : fans_out
  WEBHOOK_ENDPOINT ||--o{ WEBHOOK_DELIVERY : receives
  WEBHOOK_DELIVERY ||--o{ WEBHOOK_DELIVERY_ATTEMPT : records

  INBOX_MESSAGE {
    varchar consumer_name PK
    varchar message_id PK
    varchar event_type
    int schema_version
    bytea payload_sha256
    varchar correlation_id
    timestamptz completed_at
  }
  WEBHOOK_ENDPOINT {
    uuid id PK
    varchar public_id UK
    uuid merchant_id FK
    text normalized_url
    enum status
    int version
  }
  WEBHOOK_ENDPOINT_SUBSCRIPTION {
    uuid endpoint_id PK, FK
    varchar event_type PK
  }
  WEBHOOK_ENDPOINT_SECRET {
    uuid id PK
    uuid endpoint_id FK
    int secret_version
    enum lifecycle
    varchar encryption_key_id
    bytea nonce
    bytea ciphertext
    bytea authentication_tag
    timestamptz overlap_expires_at
  }
  WEBHOOK_EVENT_PROJECTION {
    varchar event_id PK
    uuid merchant_id FK
    varchar event_type
    bytea payload_bytes
    bytea payload_sha256
    timestamptz projected_at
  }
  WEBHOOK_DELIVERY {
    uuid id PK
    varchar public_id UK
    uuid merchant_id FK
    uuid endpoint_id FK
    varchar event_id FK
    enum status
    int attempt_count
    timestamptz next_attempt_at
    timestamptz lease_expires_at
  }
  WEBHOOK_DELIVERY_ATTEMPT {
    uuid id PK
    uuid delivery_id FK
    int attempt_number
    enum outcome
    int duration_ms
    smallint http_status
    varchar error_code
    bytea response_body_sha256
  }
```

`inbox_messages` uses `(consumer_name, message_id)` as its primary key. A Webhook event projection retains exact validated bytes and their hash so delivery never reserializes the signed body. Endpoint/event uniqueness prevents duplicate initial fanout. Delivery attempts are append-only evidence; delivery state changes are guarded by claim ownership and the runtime role.

## Settlement and Reconciliation records

```mermaid
erDiagram
  MERCHANT ||--o{ SETTLEMENT_STREAM : has
  PAYMENT_INTENT ||--o| SETTLEMENT_POSITION : projects
  SETTLEMENT_POSITION ||--o| SETTLEMENT_BATCH_ITEM : claimed_as
  SETTLEMENT_BATCH ||--|{ SETTLEMENT_BATCH_ITEM : contains
  SETTLEMENT_BATCH ||--o{ SETTLEMENT_ADJUSTMENT : consumes
  PAYMENT_INTENT ||--o{ SETTLEMENT_ADJUSTMENT : creates
  SETTLEMENT_RUN o|--o| SETTLEMENT_BATCH : finalizes
  LEDGER_TRANSACTION ||--o| SETTLEMENT_BATCH : posts
  RECONCILIATION_IMPORT ||--o{ RECONCILIATION_PROVIDER_ROW : stages
  RECONCILIATION_IMPORT ||--o{ RECONCILIATION_RESULT : classifies
  RECONCILIATION_IMPORT ||--|{ RECONCILIATION_SUMMARY : summarizes
  RECONCILIATION_PROVIDER_ROW ||--o| RECONCILIATION_RESULT : maps

  SETTLEMENT_BATCH {
    uuid id PK
    varchar public_id UK
    uuid merchant_id FK
    char3 currency
    date cutoff_date
    enum status
    bigint gross_minor
    bigint fee_minor
    bigint net_minor
    int item_count
    uuid ledger_transaction_id UK
    timestamptz settled_at
  }
  SETTLEMENT_BATCH_ITEM {
    uuid id PK
    uuid batch_id FK
    uuid payment_intent_id UK, FK
    uuid merchant_id FK
    char3 currency
    bigint gross_minor
    varchar fee_policy_version
    bigint fee_minor
    bigint net_minor
  }
  SETTLEMENT_ADJUSTMENT {
    uuid id PK
    varchar public_id UK
    uuid payment_intent_id FK
    uuid refund_id UK
    uuid source_batch_item_id FK
    enum status
    bigint amount_minor
    uuid applied_batch_id FK
  }
  RECONCILIATION_IMPORT {
    uuid id PK
    varchar public_id UK
    uuid merchant_id FK
    bytea content_sha256
    enum status
    timestamptz period_start
    timestamptz period_end
    int row_count
  }
  RECONCILIATION_PROVIDER_ROW {
    uuid id PK
    uuid import_id FK
    int row_number
    varchar provider_transaction_id
    enum event_type
    char3 currency
    bigint gross_minor
    bigint fee_minor
    bigint net_minor
  }
  RECONCILIATION_RESULT {
    uuid id PK
    uuid import_id FK
    uuid provider_row_id UK, FK
    enum bucket
    char3 currency
    int sort_ordinal
  }
  RECONCILIATION_SUMMARY {
    uuid import_id PK, FK
    char3 currency PK
    int bucket_counts
    bigint provider_totals
    bigint platform_totals
    bigint unexplained_difference_minor
  }
```

Settlement selection uses locked, deterministic candidates and unique `payment_intent_id` membership. Each batch is exactly one merchant/currency; immutable item rows snapshot the fee policy and arithmetic. Reconciliation imports own their rows, results, and exactly two ETB/USD summary records. Reports never mutate the platform evidence they compare.

## Derived and deliberately absent state

- Payment reads compose Settlement status from Settlement-owned records; `payment_intents` has no `settlement_status` column.
- Ledger balances are derived from immutable entries; there is no mutable balance table.
- RabbitMQ queue state and telemetry are not replicated as accounting records.
- Real provider, payout, bank, PAN/CVV, KYC, wallet, subscription, FX, tax, dispute, and chargeback tables do not exist.
- Manual Webhook replay, delivery-inspection, public Ledger-read, and destructive retention records/endpoints are waived or deferred as listed in the [v1 release notes](../release/v1.0.0.md).

## Migration and access boundary

The migration/owner role applies the complete ordered migration history and provisions least-privilege grants. API and worker use non-owner `settleflow_app`; schema ownership and migration credentials are never available to the normal processes. Prisma handles routine access. Reviewed parameterized raw SQL is limited to lock/claim, deferred-trigger, permission, and concurrency behavior Prisma cannot express safely.

Use `pnpm prisma:validate`, `pnpm db:migrate:verify`, `pnpm db:permissions:check`, `pnpm db:invariants:check`, and `pnpm db:schema:drift` for executable schema evidence. Do not infer authorization from a relationship diagram; tenant ownership must be present in the database predicate.
