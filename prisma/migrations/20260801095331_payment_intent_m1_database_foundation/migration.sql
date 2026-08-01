-- CreateEnum
CREATE TYPE "payment_capture_method" AS ENUM ('manual');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('created', 'authorized', 'captured', 'partially_refunded', 'refunded', 'voided');

-- CreateEnum
CREATE TYPE "idempotency_state" AS ENUM ('in_progress', 'completed');

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "public_id" VARCHAR(29) NOT NULL,
    "merchant_id" UUID NOT NULL,
    "external_ref" VARCHAR(255) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "capture_method" "payment_capture_method" NOT NULL,
    "payment_status" "payment_status" NOT NULL DEFAULT 'created',
    "captured_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "refunded_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- Payment Intent identifiers and immutable creation terms are constrained at
-- the authoritative PostgreSQL boundary. Future lifecycle services must still
-- perform command-specific transition checks and optimistic locking.
ALTER TABLE "payment_intents"
    ADD CONSTRAINT "payment_intents_public_id_format_check"
        CHECK ("public_id" ~ '^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
    ADD CONSTRAINT "payment_intents_external_ref_format_check"
        CHECK (
            char_length("external_ref") BETWEEN 1 AND 255
            AND "external_ref" !~ '^[[:space:]]'
            AND "external_ref" !~ '[[:space:]]$'
            AND "external_ref" !~ '[[:cntrl:]]'
        ),
    ADD CONSTRAINT "payment_intents_amount_minor_range_check"
        CHECK ("amount_minor" BETWEEN 1 AND 9007199254740991),
    ADD CONSTRAINT "payment_intents_currency_format_check"
        CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "payment_intents_currency_allowlist_check"
        CHECK ("currency" IN ('ETB', 'USD')),
    ADD CONSTRAINT "payment_intents_captured_amount_range_check"
        CHECK (
            "captured_amount_minor" >= 0
            AND "captured_amount_minor" <= "amount_minor"
        ),
    ADD CONSTRAINT "payment_intents_refunded_amount_range_check"
        CHECK (
            "refunded_amount_minor" >= 0
            AND "refunded_amount_minor" <= "captured_amount_minor"
        ),
    ADD CONSTRAINT "payment_intents_version_nonnegative_check"
        CHECK ("version" >= 0),
    ADD CONSTRAINT "payment_intents_status_projection_check"
        CHECK (
            "payment_status" = 'created'
            AND "captured_amount_minor" = 0
            AND "refunded_amount_minor" = 0
        );

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "http_method" VARCHAR(8) NOT NULL,
    "normalized_route" VARCHAR(255) NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "request_hash" BYTEA NOT NULL,
    "state" "idempotency_state" NOT NULL,
    "owner_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "response_status" INTEGER,
    "response_content_type" VARCHAR(128),
    "response_headers" JSONB,
    "response_body" JSONB,
    "result_reference" VARCHAR(255),
    "completed_at" TIMESTAMPTZ(6),
    "response_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- Only the M1 create command is admitted by this first idempotency schema.
-- Later commands expand these route/method constraints by forward migration.
ALTER TABLE "idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_http_method_check"
        CHECK ("http_method" = 'POST'),
    ADD CONSTRAINT "idempotency_keys_normalized_route_check"
        CHECK ("normalized_route" = '/v1/payment-intents'),
    ADD CONSTRAINT "idempotency_keys_key_hash_length_check"
        CHECK (octet_length("key_hash") = 32),
    ADD CONSTRAINT "idempotency_keys_request_hash_length_check"
        CHECK (octet_length("request_hash") = 32),
    ADD CONSTRAINT "idempotency_keys_response_status_check"
        CHECK ("response_status" IS NULL OR "response_status" BETWEEN 100 AND 599),
    ADD CONSTRAINT "idempotency_keys_response_content_type_check"
        CHECK (
            "response_content_type" IS NULL
            OR "response_content_type" IN ('application/json', 'application/problem+json')
        ),
    ADD CONSTRAINT "idempotency_keys_response_headers_object_check"
        CHECK ("response_headers" IS NULL OR jsonb_typeof("response_headers") = 'object'),
    ADD CONSTRAINT "idempotency_keys_response_body_object_check"
        CHECK ("response_body" IS NULL OR jsonb_typeof("response_body") = 'object'),
    ADD CONSTRAINT "idempotency_keys_result_reference_format_check"
        CHECK (
            "result_reference" IS NULL
            OR "result_reference" ~ '^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
        ),
    ADD CONSTRAINT "idempotency_keys_state_consistency_check"
        CHECK (
            (
                "state" = 'in_progress'
                AND "owner_token" IS NOT NULL
                AND "lease_expires_at" IS NOT NULL
                AND "response_status" IS NULL
                AND "response_content_type" IS NULL
                AND "response_headers" IS NULL
                AND "response_body" IS NULL
                AND "result_reference" IS NULL
                AND "completed_at" IS NULL
                AND "response_expires_at" IS NULL
            )
            OR (
                "state" = 'completed'
                AND "owner_token" IS NULL
                AND "lease_expires_at" IS NULL
                AND "completed_at" IS NOT NULL
                AND "response_expires_at" IS NOT NULL
                AND (
                    (
                        "response_status" IS NOT NULL
                        AND "response_content_type" IS NOT NULL
                        AND "response_headers" IS NOT NULL
                        AND "response_body" IS NOT NULL
                    )
                    OR (
                        "response_status" IS NULL
                        AND "response_content_type" IS NULL
                        AND "response_headers" IS NULL
                        AND "response_body" IS NULL
                    )
                )
            )
        ),
    ADD CONSTRAINT "idempotency_keys_minimum_replay_window_check"
        CHECK (
            "response_expires_at" IS NULL
            OR "response_expires_at" >= "completed_at" + INTERVAL '24 hours'
        );

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_id" VARCHAR(30) NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "merchant_id" UUID NOT NULL,
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" VARCHAR(255) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "locked_by" VARCHAR(128),
    "locked_at" TIMESTAMPTZ(6),
    "lease_expires_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- M1 persists only payment.created.v1. The outbox is delivery-compatible, but
-- no relay, broker topology, acknowledgement, or retention job is introduced.
ALTER TABLE "outbox_events"
    ADD CONSTRAINT "outbox_events_event_id_format_check"
        CHECK ("event_id" ~ '^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
    ADD CONSTRAINT "outbox_events_event_type_check"
        CHECK ("event_type" = 'payment.created.v1'),
    ADD CONSTRAINT "outbox_events_aggregate_type_check"
        CHECK ("aggregate_type" = 'payment_intent'),
    ADD CONSTRAINT "outbox_events_aggregate_id_format_check"
        CHECK ("aggregate_id" ~ '^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
    ADD CONSTRAINT "outbox_events_request_id_format_check"
        CHECK ("request_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    ADD CONSTRAINT "outbox_events_attempt_count_nonnegative_check"
        CHECK ("attempt_count" >= 0),
    ADD CONSTRAINT "outbox_events_lock_consistency_check"
        CHECK (num_nonnulls("locked_by", "locked_at", "lease_expires_at") IN (0, 3)),
    ADD CONSTRAINT "outbox_events_lease_order_check"
        CHECK ("lease_expires_at" IS NULL OR "lease_expires_at" > "locked_at"),
    ADD CONSTRAINT "outbox_events_publish_consistency_check"
        CHECK (
            "published_at" IS NULL
            OR (
                "locked_by" IS NULL
                AND "locked_at" IS NULL
                AND "lease_expires_at" IS NULL
                AND "published_at" >= "occurred_at"
            )
        ),
    ADD CONSTRAINT "outbox_events_payload_contract_check"
        CHECK (
            jsonb_typeof("payload") = 'object'
            AND "payload" ?& ARRAY[
                'eventId',
                'eventType',
                'occurredAt',
                'requestId',
                'merchantId',
                'paymentId',
                'amountMinor',
                'currency',
                'status'
            ]
            AND "payload" - ARRAY[
                'eventId',
                'eventType',
                'occurredAt',
                'requestId',
                'merchantId',
                'paymentId',
                'amountMinor',
                'currency',
                'status'
            ] = '{}'::jsonb
            AND jsonb_typeof("payload" -> 'eventId') = 'string'
            AND "payload" ->> 'eventId' = "event_id"
            AND jsonb_typeof("payload" -> 'eventType') = 'string'
            AND "payload" ->> 'eventType' = "event_type"
            AND jsonb_typeof("payload" -> 'occurredAt') = 'string'
            AND CASE
                WHEN "payload" ->> 'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
                    THEN ("payload" ->> 'occurredAt')::timestamptz = "occurred_at"
                ELSE FALSE
            END
            AND jsonb_typeof("payload" -> 'requestId') = 'string'
            AND "payload" ->> 'requestId' = "request_id"
            AND jsonb_typeof("payload" -> 'merchantId') = 'string'
            AND "payload" ->> 'merchantId' = "merchant_id"::text
            AND jsonb_typeof("payload" -> 'paymentId') = 'string'
            AND "payload" ->> 'paymentId' = "aggregate_id"
            AND jsonb_typeof("payload" -> 'amountMinor') = 'number'
            AND CASE
                WHEN jsonb_typeof("payload" -> 'amountMinor') = 'number'
                    THEN ("payload" ->> 'amountMinor')::numeric = trunc(("payload" ->> 'amountMinor')::numeric)
                        AND ("payload" ->> 'amountMinor')::numeric BETWEEN 1 AND 9007199254740991
                ELSE FALSE
            END
            AND jsonb_typeof("payload" -> 'currency') = 'string'
            AND "payload" ->> 'currency' IN ('ETB', 'USD')
            AND jsonb_typeof("payload" -> 'status') = 'string'
            AND "payload" ->> 'status' = 'CREATED'
        );

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_public_id_key" ON "payment_intents"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_merchant_id_external_ref_key" ON "payment_intents"("merchant_id", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_scope_key" ON "idempotency_keys"("merchant_id", "http_method", "normalized_route", "key_hash");

-- Supports stale-owner recovery and replay-snapshot expiry inspection without
-- introducing any destructive cleanup job.
CREATE INDEX "idempotency_keys_in_progress_lease_expires_at_idx"
    ON "idempotency_keys"("lease_expires_at", "id")
    WHERE "state" = 'in_progress';

CREATE INDEX "idempotency_keys_completed_response_expires_at_idx"
    ON "idempotency_keys"("response_expires_at", "id")
    WHERE "state" = 'completed';

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_event_id_key" ON "outbox_events"("event_id");

-- Future relay workers can claim pending rows in availability order. M1 does
-- not run such a worker and never deletes unpublished rows.
CREATE INDEX "outbox_events_pending_available_at_idx"
    ON "outbox_events"("available_at", "id")
    WHERE "published_at" IS NULL;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
