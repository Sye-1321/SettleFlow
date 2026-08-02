-- The shared non-owner runtime role must exist before object privileges are
-- applied. Role creation/passwords remain outside committed migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'settleflow_app') THEN
    RAISE EXCEPTION 'settleflow_app is not provisioned; run pnpm db:provision-runtime-role first'
      USING ERRCODE = '42704';
  END IF;
END
$$;

CREATE TYPE "webhook_delivery_status" AS ENUM ('pending');

CREATE TABLE "inbox_messages" (
  "consumer_name" VARCHAR(128) NOT NULL,
  "message_id" VARCHAR(30) NOT NULL,
  "event_type" VARCHAR(128) NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "payload_sha256" BYTEA NOT NULL,
  "correlation_id" VARCHAR(128) NOT NULL,
  "received_at" TIMESTAMPTZ(6) NOT NULL,
  "completed_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("consumer_name", "message_id"),
  CONSTRAINT "inbox_messages_consumer_name_check"
    CHECK ("consumer_name" = 'webhook-projection.payment-created.v1'),
  CONSTRAINT "inbox_messages_message_id_format_check"
    CHECK ("message_id" ~ '^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT "inbox_messages_event_type_check"
    CHECK ("event_type" = 'payment.created.v1'),
  CONSTRAINT "inbox_messages_schema_version_check"
    CHECK ("schema_version" = 1),
  CONSTRAINT "inbox_messages_payload_sha256_length_check"
    CHECK (octet_length("payload_sha256") = 32),
  CONSTRAINT "inbox_messages_correlation_id_check"
    CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "inbox_messages_completion_order_check"
    CHECK ("completed_at" >= "received_at")
);

CREATE TABLE "webhook_event_projections" (
  "event_id" VARCHAR(30) NOT NULL,
  "event_type" VARCHAR(128) NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "merchant_id" UUID NOT NULL,
  "payment_id" VARCHAR(29) NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "request_id" VARCHAR(128) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "payment_status" VARCHAR(32) NOT NULL,
  "payload_bytes" BYTEA NOT NULL,
  "payload_sha256" BYTEA NOT NULL,
  "projected_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "webhook_event_projections_pkey" PRIMARY KEY ("event_id"),
  CONSTRAINT "webhook_event_projections_event_id_format_check"
    CHECK ("event_id" ~ '^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT "webhook_event_projections_event_type_check"
    CHECK ("event_type" = 'payment.created.v1'),
  CONSTRAINT "webhook_event_projections_schema_version_check"
    CHECK ("schema_version" = 1),
  CONSTRAINT "webhook_event_projections_payment_id_format_check"
    CHECK ("payment_id" ~ '^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT "webhook_event_projections_request_id_check"
    CHECK ("request_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "webhook_event_projections_amount_minor_check"
    CHECK ("amount_minor" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "webhook_event_projections_currency_check"
    CHECK ("currency" IN ('ETB', 'USD')),
  CONSTRAINT "webhook_event_projections_payment_status_check"
    CHECK ("payment_status" = 'CREATED'),
  CONSTRAINT "webhook_event_projections_payload_bytes_length_check"
    CHECK (octet_length("payload_bytes") BETWEEN 1 AND 16384),
  CONSTRAINT "webhook_event_projections_payload_sha256_length_check"
    CHECK (octet_length("payload_sha256") = 32),
  CONSTRAINT "webhook_event_projections_projection_order_check"
    CHECK ("projected_at" >= "occurred_at")
);

CREATE TABLE "webhook_deliveries" (
  "id" UUID NOT NULL,
  "public_id" VARCHAR(30) NOT NULL,
  "merchant_id" UUID NOT NULL,
  "endpoint_id" UUID NOT NULL,
  "event_id" VARCHAR(30) NOT NULL,
  "status" "webhook_delivery_status" NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_deliveries_public_id_format_check"
    CHECK ("public_id" ~ '^whd_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT "webhook_deliveries_attempt_count_check"
    CHECK ("attempt_count" = 0),
  CONSTRAINT "webhook_deliveries_projection_time_check"
    CHECK (
      "next_attempt_at" = "created_at"
      AND "updated_at" = "created_at"
    )
);

CREATE INDEX "inbox_messages_completed_at_idx"
  ON "inbox_messages"("completed_at");

ALTER TABLE "webhook_endpoints"
  ADD CONSTRAINT "webhook_endpoints_id_merchant_id_key"
  UNIQUE ("id", "merchant_id");

CREATE INDEX "webhook_endpoints_merchant_id_status_id_idx"
  ON "webhook_endpoints"("merchant_id", "status", "id");

ALTER TABLE "webhook_event_projections"
  ADD CONSTRAINT "webhook_event_projections_event_id_merchant_id_key"
  UNIQUE ("event_id", "merchant_id");

CREATE INDEX "webhook_event_projections_merchant_id_projected_at_idx"
  ON "webhook_event_projections"("merchant_id", "projected_at");

CREATE UNIQUE INDEX "webhook_deliveries_public_id_key"
  ON "webhook_deliveries"("public_id");

CREATE UNIQUE INDEX "webhook_deliveries_endpoint_id_event_id_key"
  ON "webhook_deliveries"("endpoint_id", "event_id");

CREATE INDEX "webhook_deliveries_pending_next_attempt_at_id_idx"
  ON "webhook_deliveries"("next_attempt_at", "id")
  WHERE "status" = 'pending';

ALTER TABLE "webhook_event_projections"
  ADD CONSTRAINT "webhook_event_projections_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_endpoint_id_merchant_id_fkey"
  FOREIGN KEY ("endpoint_id", "merchant_id")
  REFERENCES "webhook_endpoints"("id", "merchant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_event_id_merchant_id_fkey"
  FOREIGN KEY ("event_id", "merchant_id")
  REFERENCES "webhook_event_projections"("event_id", "merchant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

REVOKE ALL PRIVILEGES ON TABLE "inbox_messages" FROM "settleflow_app";
REVOKE ALL PRIVILEGES ON TABLE "webhook_event_projections" FROM "settleflow_app";
REVOKE ALL PRIVILEGES ON TABLE "webhook_deliveries" FROM "settleflow_app";

GRANT SELECT, INSERT ON TABLE "inbox_messages" TO "settleflow_app";
GRANT SELECT, INSERT ON TABLE "webhook_event_projections" TO "settleflow_app";
GRANT SELECT, INSERT ON TABLE "webhook_deliveries" TO "settleflow_app";

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  "inbox_messages",
  "webhook_event_projections",
  "webhook_deliveries"
FROM "settleflow_app";
