-- Payment capture/refund persistence and asynchronous compatibility.
-- This migration is forward-only after the first financial posting exists.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'settleflow_app') THEN
    RAISE EXCEPTION 'settleflow_app is not provisioned; run pnpm db:provision-runtime-role first';
  END IF;
END
$$;

ALTER TABLE "payment_intents"
  ADD COLUMN "captured_at" TIMESTAMPTZ(6),
  ADD COLUMN "available_at" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "payment_intents_id_merchant_id_currency_key"
  ON "payment_intents"("id", "merchant_id", "currency");

ALTER TABLE "payment_intents"
  DROP CONSTRAINT "payment_intents_status_projection_check",
  ADD CONSTRAINT "payment_intents_status_projection_check"
    CHECK (
      (
        "payment_status" = 'created'
        AND "captured_amount_minor" = 0
        AND "refunded_amount_minor" = 0
        AND "captured_at" IS NULL
        AND "available_at" IS NULL
      )
      OR (
        "payment_status" = 'captured'
        AND "captured_amount_minor" = "amount_minor"
        AND "refunded_amount_minor" = 0
        AND "captured_at" IS NOT NULL
        AND "available_at" = "captured_at"
      )
      OR (
        "payment_status" = 'partially_refunded'
        AND "captured_amount_minor" = "amount_minor"
        AND "refunded_amount_minor" > 0
        AND "refunded_amount_minor" < "captured_amount_minor"
        AND "captured_at" IS NOT NULL
        AND "available_at" = "captured_at"
      )
      OR (
        "payment_status" = 'refunded'
        AND "captured_amount_minor" = "amount_minor"
        AND "refunded_amount_minor" = "captured_amount_minor"
        AND "captured_at" IS NOT NULL
        AND "available_at" = "captured_at"
      )
    );

CREATE TABLE "refunds" (
  "id" UUID NOT NULL,
  "public_id" VARCHAR(29) NOT NULL,
  "merchant_id" UUID NOT NULL,
  "payment_intent_id" UUID NOT NULL,
  "external_ref" VARCHAR(255) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "refunds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refunds_public_id_format_check"
    CHECK ("public_id" ~ '^rf_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT "refunds_external_ref_format_check"
    CHECK (
      char_length("external_ref") BETWEEN 1 AND 255
      AND "external_ref" !~ '^[[:space:]]'
      AND "external_ref" !~ '[[:space:]]$'
      AND "external_ref" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "refunds_amount_minor_range_check"
    CHECK ("amount_minor" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "refunds_currency_format_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "refunds_currency_allowlist_check"
    CHECK ("currency" IN ('ETB', 'USD'))
);

CREATE UNIQUE INDEX "refunds_public_id_key" ON "refunds"("public_id");
CREATE UNIQUE INDEX "refunds_merchant_id_external_ref_key"
  ON "refunds"("merchant_id", "external_ref");
CREATE INDEX "refunds_merchant_id_payment_intent_id_created_at_idx"
  ON "refunds"("merchant_id", "payment_intent_id", "created_at", "id");

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "refunds_payment_intent_id_merchant_id_currency_fkey"
    FOREIGN KEY ("payment_intent_id", "merchant_id", "currency")
    REFERENCES "payment_intents"("id", "merchant_id", "currency")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION public.payment_intents_guard_financial_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."public_id" IS DISTINCT FROM OLD."public_id"
    OR NEW."merchant_id" IS DISTINCT FROM OLD."merchant_id"
    OR NEW."external_ref" IS DISTINCT FROM OLD."external_ref"
    OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."capture_method" IS DISTINCT FROM OLD."capture_method"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."version" <> OLD."version" + 1
    OR NEW."updated_at" < OLD."updated_at"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_intents_financial_update_guard_check';
  END IF;

  IF OLD."payment_status" = 'created' THEN
    IF NEW."payment_status" <> 'captured'
      OR NEW."captured_amount_minor" <> OLD."amount_minor"
      OR NEW."refunded_amount_minor" <> 0
      OR NEW."captured_at" IS NULL
      OR NEW."available_at" IS DISTINCT FROM NEW."captured_at"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'payment_intents_capture_transition_check';
    END IF;
  ELSIF OLD."payment_status" IN ('captured', 'partially_refunded') THEN
    IF NEW."payment_status" NOT IN ('partially_refunded', 'refunded')
      OR NEW."captured_amount_minor" IS DISTINCT FROM OLD."captured_amount_minor"
      OR NEW."refunded_amount_minor" <= OLD."refunded_amount_minor"
      OR NEW."captured_at" IS DISTINCT FROM OLD."captured_at"
      OR NEW."available_at" IS DISTINCT FROM OLD."available_at"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'payment_intents_refund_transition_check';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_intents_terminal_transition_check';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "payment_intents_guard_financial_update_trigger"
BEFORE UPDATE ON "payment_intents"
FOR EACH ROW EXECUTE FUNCTION public.payment_intents_guard_financial_update();

CREATE OR REPLACE FUNCTION public.refunds_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', CONSTRAINT = 'refunds_append_only_check';
END
$$;

CREATE TRIGGER "refunds_reject_update_delete_trigger"
BEFORE UPDATE OR DELETE ON "refunds"
FOR EACH ROW EXECUTE FUNCTION public.refunds_reject_mutation();

CREATE TRIGGER "refunds_reject_truncate_trigger"
BEFORE TRUNCATE ON "refunds"
FOR EACH STATEMENT EXECUTE FUNCTION public.refunds_reject_mutation();

ALTER TABLE "idempotency_keys"
  DROP CONSTRAINT "idempotency_keys_normalized_route_check",
  ADD CONSTRAINT "idempotency_keys_normalized_route_check"
    CHECK (
      "normalized_route" IN (
        '/v1/payment-intents',
        '/v1/payment-intents/{id}/capture',
        '/v1/payment-intents/{id}/refunds'
      )
    ),
  DROP CONSTRAINT "idempotency_keys_result_reference_format_check",
  ADD CONSTRAINT "idempotency_keys_result_reference_format_check"
    CHECK (
      "result_reference" IS NULL
      OR "result_reference" ~ '^(pi|rf)_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
    );

ALTER TABLE "outbox_events"
  DROP CONSTRAINT "outbox_events_event_type_check",
  ADD CONSTRAINT "outbox_events_event_type_check"
    CHECK (
      "event_type" IN (
        'payment.created.v1',
        'payment.captured.v1',
        'payment.refunded.v1'
      )
    ),
  DROP CONSTRAINT "outbox_events_payload_contract_check",
  ADD CONSTRAINT "outbox_events_payload_contract_check"
    CHECK (
      jsonb_typeof("payload") = 'object'
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
      AND jsonb_typeof("payload" -> 'currency') = 'string'
      AND "payload" ->> 'currency' IN ('ETB', 'USD')
      AND (
        (
          "event_type" = 'payment.created.v1'
          AND "payload" ?& ARRAY[
            'eventId', 'eventType', 'occurredAt', 'requestId', 'merchantId',
            'paymentId', 'amountMinor', 'currency', 'status'
          ]
          AND "payload" - ARRAY[
            'eventId', 'eventType', 'occurredAt', 'requestId', 'merchantId',
            'paymentId', 'amountMinor', 'currency', 'status'
          ] = '{}'::jsonb
          AND jsonb_typeof("payload" -> 'amountMinor') = 'number'
          AND ("payload" ->> 'amountMinor')::numeric = trunc(("payload" ->> 'amountMinor')::numeric)
          AND ("payload" ->> 'amountMinor')::numeric BETWEEN 1 AND 9007199254740991
          AND jsonb_typeof("payload" -> 'status') = 'string'
          AND "payload" ->> 'status' = 'CREATED'
        )
        OR (
          "event_type" = 'payment.captured.v1'
          AND "payload" ?& ARRAY[
            'eventId', 'eventType', 'occurredAt', 'requestId', 'merchantId',
            'paymentId', 'capturedAmountMinor', 'currency', 'availableOn',
            'ledgerTransactionId'
          ]
          AND "payload" - ARRAY[
            'eventId', 'eventType', 'occurredAt', 'requestId', 'merchantId',
            'paymentId', 'capturedAmountMinor', 'currency', 'availableOn',
            'ledgerTransactionId'
          ] = '{}'::jsonb
          AND jsonb_typeof("payload" -> 'capturedAmountMinor') = 'number'
          AND ("payload" ->> 'capturedAmountMinor')::numeric = trunc(("payload" ->> 'capturedAmountMinor')::numeric)
          AND ("payload" ->> 'capturedAmountMinor')::numeric BETWEEN 1 AND 9007199254740991
          AND jsonb_typeof("payload" -> 'availableOn') = 'string'
          AND "payload" ->> 'availableOn' = "payload" ->> 'occurredAt'
          AND jsonb_typeof("payload" -> 'ledgerTransactionId') = 'string'
          AND "payload" ->> 'ledgerTransactionId' ~ '^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
        )
        OR (
          "event_type" = 'payment.refunded.v1'
          AND "payload" ?& ARRAY[
            'eventId', 'eventType', 'occurredAt', 'requestId', 'merchantId',
            'paymentId', 'refundId', 'amountMinor', 'currency',
            'cumulativeRefundedAmountMinor', 'ledgerTransactionId'
          ]
          AND "payload" - ARRAY[
            'eventId', 'eventType', 'occurredAt', 'requestId', 'merchantId',
            'paymentId', 'refundId', 'amountMinor', 'currency',
            'cumulativeRefundedAmountMinor', 'ledgerTransactionId'
          ] = '{}'::jsonb
          AND jsonb_typeof("payload" -> 'refundId') = 'string'
          AND "payload" ->> 'refundId' ~ '^rf_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
          AND jsonb_typeof("payload" -> 'amountMinor') = 'number'
          AND ("payload" ->> 'amountMinor')::numeric = trunc(("payload" ->> 'amountMinor')::numeric)
          AND ("payload" ->> 'amountMinor')::numeric BETWEEN 1 AND 9007199254740991
          AND jsonb_typeof("payload" -> 'cumulativeRefundedAmountMinor') = 'number'
          AND ("payload" ->> 'cumulativeRefundedAmountMinor')::numeric = trunc(("payload" ->> 'cumulativeRefundedAmountMinor')::numeric)
          AND ("payload" ->> 'cumulativeRefundedAmountMinor')::numeric
            BETWEEN ("payload" ->> 'amountMinor')::numeric AND 9007199254740991
          AND jsonb_typeof("payload" -> 'ledgerTransactionId') = 'string'
          AND "payload" ->> 'ledgerTransactionId' ~ '^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
        )
      )
    );

ALTER TABLE "inbox_messages"
  DROP CONSTRAINT "inbox_messages_consumer_name_check",
  ADD CONSTRAINT "inbox_messages_consumer_name_check"
    CHECK (
      "consumer_name" IN (
        'webhook-projection.payment-created.v1',
        'webhook-projection.payment-captured.v1',
        'webhook-projection.payment-refunded.v1'
      )
    ),
  DROP CONSTRAINT "inbox_messages_event_type_check",
  ADD CONSTRAINT "inbox_messages_event_type_check"
    CHECK (
      "event_type" IN (
        'payment.created.v1',
        'payment.captured.v1',
        'payment.refunded.v1'
      )
    ),
  ADD CONSTRAINT "inbox_messages_consumer_event_match_check"
    CHECK (
      ("consumer_name" = 'webhook-projection.payment-created.v1' AND "event_type" = 'payment.created.v1')
      OR ("consumer_name" = 'webhook-projection.payment-captured.v1' AND "event_type" = 'payment.captured.v1')
      OR ("consumer_name" = 'webhook-projection.payment-refunded.v1' AND "event_type" = 'payment.refunded.v1')
    );

ALTER TABLE "webhook_endpoint_subscriptions"
  DROP CONSTRAINT "webhook_endpoint_subscriptions_event_type_check",
  ADD CONSTRAINT "webhook_endpoint_subscriptions_event_type_check"
    CHECK (
      "event_type" IN (
        'payment.created.v1',
        'payment.captured.v1',
        'payment.refunded.v1'
      )
    );

ALTER TABLE "webhook_event_projections"
  ALTER COLUMN "payment_status" DROP NOT NULL,
  ADD COLUMN "refund_id" VARCHAR(29),
  ADD COLUMN "ledger_transaction_id" VARCHAR(30),
  ADD COLUMN "available_on" TIMESTAMPTZ(6),
  ADD COLUMN "cumulative_refunded_amount_minor" BIGINT,
  DROP CONSTRAINT "webhook_event_projections_event_type_check",
  ADD CONSTRAINT "webhook_event_projections_event_type_check"
    CHECK (
      "event_type" IN (
        'payment.created.v1',
        'payment.captured.v1',
        'payment.refunded.v1'
      )
    ),
  DROP CONSTRAINT "webhook_event_projections_payment_status_check",
  ADD CONSTRAINT "webhook_event_projections_event_fields_check"
    CHECK (
      (
        "event_type" = 'payment.created.v1'
        AND "payment_status" = 'CREATED'
        AND "refund_id" IS NULL
        AND "ledger_transaction_id" IS NULL
        AND "available_on" IS NULL
        AND "cumulative_refunded_amount_minor" IS NULL
      )
      OR (
        "event_type" = 'payment.captured.v1'
        AND "payment_status" IS NULL
        AND "refund_id" IS NULL
        AND "ledger_transaction_id" IS NOT NULL
        AND "ledger_transaction_id" ~ '^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
        AND "available_on" IS NOT NULL
        AND "available_on" = "occurred_at"
        AND "cumulative_refunded_amount_minor" IS NULL
      )
      OR (
        "event_type" = 'payment.refunded.v1'
        AND "payment_status" IS NULL
        AND "refund_id" IS NOT NULL
        AND "refund_id" ~ '^rf_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
        AND "ledger_transaction_id" IS NOT NULL
        AND "ledger_transaction_id" ~ '^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
        AND "available_on" IS NULL
        AND "cumulative_refunded_amount_minor" IS NOT NULL
        AND "cumulative_refunded_amount_minor" BETWEEN "amount_minor" AND 9007199254740991
      )
    );

REVOKE ALL PRIVILEGES ON TABLE "refunds" FROM "settleflow_app";
GRANT SELECT, INSERT ON TABLE "refunds" TO "settleflow_app";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "refunds" FROM "settleflow_app";
GRANT SELECT, UPDATE ON TABLE "payment_intents" TO "settleflow_app";
GRANT SELECT, INSERT ON TABLE "webhook_event_projections" TO "settleflow_app";
GRANT SELECT, INSERT, DELETE ON TABLE "webhook_endpoint_subscriptions" TO "settleflow_app";
GRANT USAGE ON SCHEMA "public" TO "settleflow_app";
