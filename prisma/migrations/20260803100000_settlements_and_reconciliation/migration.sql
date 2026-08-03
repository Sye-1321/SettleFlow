BEGIN;

-- CreateEnum
CREATE TYPE "settlement_run_status" AS ENUM ('completed', 'no_eligible_items');

-- CreateEnum
CREATE TYPE "settlement_batch_status" AS ENUM ('batched', 'settled');

-- CreateEnum
CREATE TYPE "settlement_adjustment_status" AS ENUM ('pending', 'batched', 'settled');

-- CreateEnum
CREATE TYPE "reconciliation_import_status" AS ENUM ('staged', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "reconciliation_event_type" AS ENUM ('capture', 'refund', 'settlement', 'adjustment');

-- CreateEnum
CREATE TYPE "reconciliation_provider_status" AS ENUM ('succeeded', 'failed');

-- CreateEnum
CREATE TYPE "reconciliation_result_bucket" AS ENUM ('matched_exact', 'provider_only', 'platform_only', 'currency_mismatch', 'amount_mismatch', 'status_mismatch', 'duplicate_provider_row');

-- AlterTable
ALTER TABLE "webhook_event_projections" ADD COLUMN     "aggregate_id" VARCHAR(255) NOT NULL DEFAULT '',
ADD COLUMN     "aggregate_type" VARCHAR(64) NOT NULL DEFAULT 'payment_intent',
ALTER COLUMN "payment_id" DROP NOT NULL,
ALTER COLUMN "amount_minor" DROP NOT NULL,
ALTER COLUMN "currency" DROP NOT NULL;

-- CreateTable
CREATE TABLE "settlement_streams" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_positions" (
    "id" UUID NOT NULL,
    "payment_intent_id" UUID NOT NULL,
    "payment_public_id" VARCHAR(29) NOT NULL,
    "merchant_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "captured_amount_minor" BIGINT NOT NULL,
    "refunded_amount_minor" BIGINT NOT NULL,
    "available_at" TIMESTAMPTZ(6) NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "last_event_id" VARCHAR(30) NOT NULL,
    "last_event_occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_runs" (
    "id" UUID NOT NULL,
    "public_id" VARCHAR(30) NOT NULL,
    "merchant_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "cutoff_date" DATE NOT NULL,
    "cutoff_timezone" VARCHAR(64) NOT NULL,
    "cutoff_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "settlement_run_status" NOT NULL,
    "batch_id" UUID,
    "more_eligible" BOOLEAN NOT NULL DEFAULT false,
    "request_id" VARCHAR(128) NOT NULL,
    "requested_by_api_key_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settlement_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_batches" (
    "id" UUID NOT NULL,
    "public_id" VARCHAR(30) NOT NULL,
    "merchant_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "cutoff_date" DATE NOT NULL,
    "cutoff_timezone" VARCHAR(64) NOT NULL,
    "cutoff_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "settlement_batch_status" NOT NULL DEFAULT 'batched',
    "payment_gross_minor" BIGINT NOT NULL,
    "adjustment_minor" BIGINT NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "item_count" INTEGER NOT NULL,
    "adjustment_count" INTEGER NOT NULL,
    "ledger_transaction_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "settlement_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_batch_items" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "settlement_position_id" UUID NOT NULL,
    "payment_intent_id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "captured_amount_minor" BIGINT NOT NULL,
    "refunded_amount_minor" BIGINT NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "fee_policy_version" VARCHAR(64) NOT NULL,
    "flat_fee_minor" BIGINT NOT NULL,
    "basis_points" INTEGER NOT NULL,
    "fee_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "available_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_adjustments" (
    "id" UUID NOT NULL,
    "public_id" VARCHAR(30) NOT NULL,
    "merchant_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "payment_intent_id" UUID NOT NULL,
    "settlement_position_id" UUID NOT NULL,
    "original_batch_item_id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "refund_public_id" VARCHAR(29) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" "settlement_adjustment_status" NOT NULL DEFAULT 'pending',
    "batch_id" UUID,
    "source_event_id" VARCHAR(30) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "settlement_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_imports" (
    "id" UUID NOT NULL,
    "public_id" VARCHAR(30) NOT NULL,
    "merchant_id" UUID NOT NULL,
    "content_sha256" BYTEA NOT NULL,
    "byte_count" INTEGER NOT NULL,
    "row_count" INTEGER NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "status" "reconciliation_import_status" NOT NULL DEFAULT 'staged',
    "request_id" VARCHAR(128) NOT NULL,
    "requested_by_api_key_id" UUID NOT NULL,
    "failure_code" VARCHAR(64),
    "failure_row_number" INTEGER,
    "raw_rows_expire_at" TIMESTAMPTZ(6) NOT NULL,
    "locked_by" VARCHAR(128),
    "locked_at" TIMESTAMPTZ(6),
    "lease_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),

    CONSTRAINT "reconciliation_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_provider_rows" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "provider_transaction_id" VARCHAR(255) NOT NULL,
    "merchant_code" VARCHAR(64) NOT NULL,
    "provider_ref" VARCHAR(255) NOT NULL,
    "external_ref" VARCHAR(255),
    "event_type" "reconciliation_event_type" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "status" "reconciliation_provider_status" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_provider_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_results" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "provider_row_id" UUID,
    "bucket" "reconciliation_result_bucket" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "platform_record_type" VARCHAR(32),
    "platform_public_ref" VARCHAR(255),
    "matched_by" VARCHAR(32),
    "provider_gross_minor" BIGINT,
    "provider_fee_minor" BIGINT,
    "provider_net_minor" BIGINT,
    "platform_gross_minor" BIGINT,
    "platform_fee_minor" BIGINT,
    "platform_net_minor" BIGINT,
    "reason_code" VARCHAR(64) NOT NULL,
    "sort_ordinal" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_summaries" (
    "import_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "matched_exact_count" INTEGER NOT NULL,
    "provider_only_count" INTEGER NOT NULL,
    "platform_only_count" INTEGER NOT NULL,
    "currency_mismatch_count" INTEGER NOT NULL,
    "amount_mismatch_count" INTEGER NOT NULL,
    "status_mismatch_count" INTEGER NOT NULL,
    "duplicate_provider_row_count" INTEGER NOT NULL,
    "provider_gross_minor" BIGINT NOT NULL,
    "provider_fee_minor" BIGINT NOT NULL,
    "provider_net_minor" BIGINT NOT NULL,
    "platform_gross_minor" BIGINT NOT NULL,
    "platform_fee_minor" BIGINT NOT NULL,
    "platform_net_minor" BIGINT NOT NULL,
    "unexplained_difference_minor" BIGINT NOT NULL,
    "completed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reconciliation_summaries_pkey" PRIMARY KEY ("import_id","currency")
);

-- CreateIndex
CREATE UNIQUE INDEX "settlement_streams_merchant_id_currency_key" ON "settlement_streams"("merchant_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_positions_payment_intent_id_key" ON "settlement_positions"("payment_intent_id");

-- CreateIndex
CREATE INDEX "settlement_positions_eligibility_idx" ON "settlement_positions"("merchant_id", "currency", "available_at", "payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_positions_id_merchant_id_currency_key" ON "settlement_positions"("id", "merchant_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_positions_payment_owner_key" ON "settlement_positions"("payment_intent_id", "merchant_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_runs_public_id_key" ON "settlement_runs"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_runs_batch_id_key" ON "settlement_runs"("batch_id");

-- CreateIndex
CREATE INDEX "settlement_runs_merchant_id_created_at_id_idx" ON "settlement_runs"("merchant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "settlement_runs_id_merchant_id_currency_key" ON "settlement_runs"("id", "merchant_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batches_public_id_key" ON "settlement_batches"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batches_ledger_transaction_id_key" ON "settlement_batches"("ledger_transaction_id");

-- CreateIndex
CREATE INDEX "settlement_batches_merchant_id_created_at_id_idx" ON "settlement_batches"("merchant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batches_id_merchant_id_currency_key" ON "settlement_batches"("id", "merchant_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batches_ledger_owner_key" ON "settlement_batches"("ledger_transaction_id", "merchant_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batch_items_position_id_key" ON "settlement_batch_items"("settlement_position_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batch_items_payment_intent_id_key" ON "settlement_batch_items"("payment_intent_id");

-- CreateIndex
CREATE INDEX "settlement_batch_items_batch_order_idx" ON "settlement_batch_items"("batch_id", "available_at", "payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batch_items_id_merchant_id_currency_key" ON "settlement_batch_items"("id", "merchant_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batch_items_position_owner_key" ON "settlement_batch_items"("settlement_position_id", "merchant_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batch_items_payment_owner_key" ON "settlement_batch_items"("payment_intent_id", "merchant_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_adjustments_public_id_key" ON "settlement_adjustments"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_adjustments_refund_id_key" ON "settlement_adjustments"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_adjustments_source_event_id_key" ON "settlement_adjustments"("source_event_id");

-- CreateIndex
CREATE INDEX "settlement_adjustments_pending_idx" ON "settlement_adjustments"("merchant_id", "currency", "status", "occurred_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_imports_public_id_key" ON "reconciliation_imports"("public_id");

-- CreateIndex
CREATE INDEX "reconciliation_imports_merchant_id_status_created_at_idx" ON "reconciliation_imports"("merchant_id", "status", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_imports_merchant_id_checksum_key" ON "reconciliation_imports"("merchant_id", "content_sha256");

-- CreateIndex
CREATE INDEX "reconciliation_provider_rows_provider_ref_idx" ON "reconciliation_provider_rows"("import_id", "provider_ref", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_provider_rows_import_id_row_number_key" ON "reconciliation_provider_rows"("import_id", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_results_provider_row_id_key" ON "reconciliation_results"("provider_row_id");

-- CreateIndex
CREATE INDEX "reconciliation_results_import_id_bucket_sort_idx" ON "reconciliation_results"("import_id", "bucket", "sort_ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_results_platform_record_key" ON "reconciliation_results"("import_id", "platform_record_type", "platform_public_ref");

-- AddForeignKey
ALTER TABLE "settlement_streams" ADD CONSTRAINT "settlement_streams_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_positions" ADD CONSTRAINT "settlement_positions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_positions" ADD CONSTRAINT "settlement_positions_payment_owner_fkey" FOREIGN KEY ("payment_intent_id", "merchant_id", "currency") REFERENCES "payment_intents"("id", "merchant_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_runs" ADD CONSTRAINT "settlement_runs_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_runs" ADD CONSTRAINT "settlement_runs_requested_by_api_key_id_fkey" FOREIGN KEY ("requested_by_api_key_id") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_runs" ADD CONSTRAINT "settlement_runs_batch_id_merchant_id_currency_fkey" FOREIGN KEY ("batch_id", "merchant_id", "currency") REFERENCES "settlement_batches"("id", "merchant_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_batches" ADD CONSTRAINT "settlement_batches_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_batches" ADD CONSTRAINT "settlement_batches_ledger_owner_fkey" FOREIGN KEY ("ledger_transaction_id", "merchant_id", "currency") REFERENCES "ledger_transactions"("id", "merchant_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_batch_items" ADD CONSTRAINT "settlement_batch_items_batch_id_merchant_id_currency_fkey" FOREIGN KEY ("batch_id", "merchant_id", "currency") REFERENCES "settlement_batches"("id", "merchant_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_batch_items" ADD CONSTRAINT "settlement_batch_items_position_id_merchant_id_currency_fkey" FOREIGN KEY ("settlement_position_id", "merchant_id", "currency") REFERENCES "settlement_positions"("id", "merchant_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_batch_items" ADD CONSTRAINT "settlement_batch_items_payment_owner_fkey" FOREIGN KEY ("payment_intent_id", "merchant_id", "currency") REFERENCES "payment_intents"("id", "merchant_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_adjustments" ADD CONSTRAINT "settlement_adjustments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_adjustments" ADD CONSTRAINT "settlement_adjustments_payment_owner_fkey" FOREIGN KEY ("payment_intent_id", "merchant_id", "currency") REFERENCES "payment_intents"("id", "merchant_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_adjustments" ADD CONSTRAINT "settlement_adjustments_position_id_merchant_id_currency_fkey" FOREIGN KEY ("settlement_position_id", "merchant_id", "currency") REFERENCES "settlement_positions"("id", "merchant_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_adjustments" ADD CONSTRAINT "settlement_adjustments_original_item_owner_fkey" FOREIGN KEY ("original_batch_item_id", "merchant_id", "currency") REFERENCES "settlement_batch_items"("id", "merchant_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_adjustments" ADD CONSTRAINT "settlement_adjustments_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "settlement_adjustments" ADD CONSTRAINT "settlement_adjustments_batch_id_merchant_id_currency_fkey" FOREIGN KEY ("batch_id", "merchant_id", "currency") REFERENCES "settlement_batches"("id", "merchant_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reconciliation_imports" ADD CONSTRAINT "reconciliation_imports_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reconciliation_imports" ADD CONSTRAINT "reconciliation_imports_requested_by_api_key_id_fkey" FOREIGN KEY ("requested_by_api_key_id") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reconciliation_provider_rows" ADD CONSTRAINT "reconciliation_provider_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "reconciliation_imports"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "reconciliation_imports"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_provider_row_id_fkey" FOREIGN KEY ("provider_row_id") REFERENCES "reconciliation_provider_rows"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reconciliation_summaries" ADD CONSTRAINT "reconciliation_summaries_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "reconciliation_imports"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Approved immutable fee schedule. Runtime code reads but cannot mutate it.
CREATE TABLE "settlement_fee_policies" (
  "version" VARCHAR(64) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "flat_fee_minor" BIGINT NOT NULL,
  "basis_points" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settlement_fee_policies_pkey" PRIMARY KEY ("version", "currency"),
  CONSTRAINT "settlement_fee_policies_version_check" CHECK ("version" = 'settlement_fee_v1'),
  CONSTRAINT "settlement_fee_policies_currency_check" CHECK ("currency" IN ('ETB', 'USD')),
  CONSTRAINT "settlement_fee_policies_values_check" CHECK (
    ("currency" = 'ETB' AND "flat_fee_minor" = 600 AND "basis_points" = 200)
    OR ("currency" = 'USD' AND "flat_fee_minor" = 25 AND "basis_points" = 200)
  )
);
INSERT INTO "settlement_fee_policies" ("version", "currency", "flat_fee_minor", "basis_points")
VALUES ('settlement_fee_v1', 'ETB', 600, 200), ('settlement_fee_v1', 'USD', 25, 200);

ALTER TABLE "settlement_streams"
  ADD CONSTRAINT "settlement_streams_currency_check" CHECK ("currency" IN ('ETB', 'USD'));
ALTER TABLE "settlement_positions"
  ADD CONSTRAINT "settlement_positions_payment_id_check" CHECK ("payment_public_id" ~ '^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  ADD CONSTRAINT "settlement_positions_event_id_check" CHECK ("last_event_id" ~ '^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  ADD CONSTRAINT "settlement_positions_currency_check" CHECK ("currency" IN ('ETB', 'USD')),
  ADD CONSTRAINT "settlement_positions_amounts_check" CHECK (
    "captured_amount_minor" BETWEEN 1 AND 9007199254740991
    AND "refunded_amount_minor" BETWEEN 0 AND "captured_amount_minor"
  );
ALTER TABLE "settlement_runs"
  ADD CONSTRAINT "settlement_runs_public_id_check" CHECK ("public_id" ~ '^str_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  ADD CONSTRAINT "settlement_runs_currency_check" CHECK ("currency" IN ('ETB', 'USD')),
  ADD CONSTRAINT "settlement_runs_timezone_check" CHECK ("cutoff_timezone" = 'Africa/Addis_Ababa'),
  ADD CONSTRAINT "settlement_runs_result_shape_check" CHECK (
    ("status" = 'completed' AND "batch_id" IS NOT NULL)
    OR ("status" = 'no_eligible_items' AND "batch_id" IS NULL)
  );
ALTER TABLE "settlement_batches"
  ADD CONSTRAINT "settlement_batches_public_id_check" CHECK ("public_id" ~ '^stb_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  ADD CONSTRAINT "settlement_batches_currency_check" CHECK ("currency" IN ('ETB', 'USD')),
  ADD CONSTRAINT "settlement_batches_timezone_check" CHECK ("cutoff_timezone" = 'Africa/Addis_Ababa'),
  ADD CONSTRAINT "settlement_batches_money_check" CHECK (
    "payment_gross_minor" BETWEEN 1 AND 9007199254740991
    AND "adjustment_minor" BETWEEN 0 AND "payment_gross_minor" - 1
    AND "gross_minor" = "payment_gross_minor" - "adjustment_minor"
    AND "fee_minor" BETWEEN 1 AND "gross_minor" - 1
    AND "net_minor" = "gross_minor" - "fee_minor"
  ),
  ADD CONSTRAINT "settlement_batches_counts_check" CHECK (
    "item_count" BETWEEN 1 AND 500 AND "adjustment_count" BETWEEN 0 AND 500
  ),
  ADD CONSTRAINT "settlement_batches_status_shape_check" CHECK (
    ("status" = 'batched' AND "settled_at" IS NULL)
    OR ("status" = 'settled' AND "settled_at" IS NOT NULL)
  );
ALTER TABLE "settlement_batch_items"
  ADD CONSTRAINT "settlement_batch_items_currency_check" CHECK ("currency" IN ('ETB', 'USD')),
  ADD CONSTRAINT "settlement_batch_items_money_check" CHECK (
    "captured_amount_minor" BETWEEN 1 AND 9007199254740991
    AND "refunded_amount_minor" BETWEEN 0 AND "captured_amount_minor" - 1
    AND "gross_minor" = "captured_amount_minor" - "refunded_amount_minor"
    AND "flat_fee_minor" >= 0 AND "basis_points" BETWEEN 0 AND 10000
    AND "fee_minor" = "flat_fee_minor" + floor(("gross_minor"::numeric * "basis_points") / 10000)::bigint
    AND "fee_minor" BETWEEN 1 AND "gross_minor" - 1
    AND "net_minor" = "gross_minor" - "fee_minor"
  ),
  ADD CONSTRAINT "settlement_batch_items_policy_check" CHECK ("fee_policy_version" = 'settlement_fee_v1');
ALTER TABLE "settlement_adjustments"
  ADD CONSTRAINT "settlement_adjustments_public_id_check" CHECK ("public_id" ~ '^sta_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  ADD CONSTRAINT "settlement_adjustments_refund_id_check" CHECK ("refund_public_id" ~ '^rf_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  ADD CONSTRAINT "settlement_adjustments_event_id_check" CHECK ("source_event_id" ~ '^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  ADD CONSTRAINT "settlement_adjustments_currency_check" CHECK ("currency" IN ('ETB', 'USD')),
  ADD CONSTRAINT "settlement_adjustments_amount_check" CHECK ("amount_minor" BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT "settlement_adjustments_status_shape_check" CHECK (
    ("status" = 'pending' AND "batch_id" IS NULL AND "settled_at" IS NULL)
    OR ("status" = 'batched' AND "batch_id" IS NOT NULL AND "settled_at" IS NULL)
    OR ("status" = 'settled' AND "batch_id" IS NOT NULL AND "settled_at" IS NOT NULL)
  );

ALTER TABLE "reconciliation_imports"
  ADD CONSTRAINT "reconciliation_imports_public_id_check" CHECK ("public_id" ~ '^rec_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  ADD CONSTRAINT "reconciliation_imports_checksum_check" CHECK (octet_length("content_sha256") = 32),
  ADD CONSTRAINT "reconciliation_imports_size_check" CHECK (
    "byte_count" BETWEEN 0 AND 10485760 AND "row_count" BETWEEN 0 AND 50000
    AND ("status" = 'failed' OR ("byte_count" >= 1 AND "row_count" >= 1))
  ),
  ADD CONSTRAINT "reconciliation_imports_period_check" CHECK (
    "period_start" < "period_end" AND "period_end" <= "period_start" + interval '31 days'
  ),
  ADD CONSTRAINT "reconciliation_imports_status_shape_check" CHECK (
    ("status" = 'staged' AND "completed_at" IS NULL AND "failed_at" IS NULL AND "failure_code" IS NULL AND "failure_row_number" IS NULL)
    OR ("status" = 'completed' AND "completed_at" IS NOT NULL AND "failed_at" IS NULL AND "failure_code" IS NULL AND "failure_row_number" IS NULL
      AND "locked_by" IS NULL AND "locked_at" IS NULL AND "lease_expires_at" IS NULL)
    OR ("status" = 'failed' AND "completed_at" IS NULL AND "failed_at" IS NOT NULL
      AND "failure_code" IN ('csv_invalid', 'row_limit_exceeded', 'aggregate_overflow')
      AND "failure_row_number" IS NULL AND "locked_by" IS NULL AND "locked_at" IS NULL AND "lease_expires_at" IS NULL)
  );
ALTER TABLE "reconciliation_provider_rows"
  ADD CONSTRAINT "reconciliation_provider_rows_row_number_check" CHECK ("row_number" BETWEEN 1 AND 50000),
  ADD CONSTRAINT "reconciliation_provider_rows_currency_check" CHECK ("currency" IN ('ETB', 'USD')),
  ADD CONSTRAINT "reconciliation_provider_rows_money_check" CHECK (
    "gross_minor" BETWEEN 0 AND 9007199254740991
    AND "fee_minor" BETWEEN 0 AND 9007199254740991
    AND "net_minor" BETWEEN 0 AND 9007199254740991
    AND (
      ("event_type" = 'settlement' AND "gross_minor" = "fee_minor" + "net_minor")
      OR ("event_type" IN ('capture', 'refund', 'adjustment') AND "fee_minor" = 0 AND "net_minor" = "gross_minor")
    )
  );
ALTER TABLE "reconciliation_results"
  ADD CONSTRAINT "reconciliation_results_currency_check" CHECK ("currency" IN ('ETB', 'USD')),
  ADD CONSTRAINT "reconciliation_results_matched_by_check" CHECK ("matched_by" IS NULL OR "matched_by" IN ('provider_ref', 'external_ref')),
  ADD CONSTRAINT "reconciliation_results_shape_check" CHECK (
    ("provider_row_id" IS NOT NULL OR "bucket" = 'platform_only')
    AND ("platform_public_ref" IS NOT NULL OR "bucket" IN ('provider_only', 'duplicate_provider_row'))
  ),
  ADD CONSTRAINT "reconciliation_results_money_check" CHECK (
    ("provider_gross_minor" IS NULL OR "provider_gross_minor" BETWEEN 0 AND 9007199254740991)
    AND ("provider_fee_minor" IS NULL OR "provider_fee_minor" BETWEEN 0 AND 9007199254740991)
    AND ("provider_net_minor" IS NULL OR "provider_net_minor" BETWEEN 0 AND 9007199254740991)
    AND ("platform_gross_minor" IS NULL OR "platform_gross_minor" BETWEEN 0 AND 9007199254740991)
    AND ("platform_fee_minor" IS NULL OR "platform_fee_minor" BETWEEN 0 AND 9007199254740991)
    AND ("platform_net_minor" IS NULL OR "platform_net_minor" BETWEEN 0 AND 9007199254740991)
  );
ALTER TABLE "reconciliation_summaries"
  ADD CONSTRAINT "reconciliation_summaries_currency_check" CHECK ("currency" IN ('ETB', 'USD')),
  ADD CONSTRAINT "reconciliation_summaries_counts_check" CHECK (
    "matched_exact_count" >= 0 AND "provider_only_count" >= 0 AND "platform_only_count" >= 0
    AND "currency_mismatch_count" >= 0 AND "amount_mismatch_count" >= 0
    AND "status_mismatch_count" >= 0 AND "duplicate_provider_row_count" >= 0
  ),
  ADD CONSTRAINT "reconciliation_summaries_difference_check" CHECK (
    "unexplained_difference_minor" = "provider_net_minor" - "platform_net_minor"
    AND "provider_gross_minor" BETWEEN 0 AND 9007199254740991
    AND "provider_fee_minor" BETWEEN 0 AND 9007199254740991
    AND "provider_net_minor" BETWEEN 0 AND 9007199254740991
    AND "platform_gross_minor" BETWEEN 0 AND 9007199254740991
    AND "platform_fee_minor" BETWEEN 0 AND 9007199254740991
    AND "platform_net_minor" BETWEEN 0 AND 9007199254740991
    AND "unexplained_difference_minor" BETWEEN -9007199254740991 AND 9007199254740991
  );

-- One stream per merchant/currency and historical lifecycle position catch-up.
INSERT INTO "settlement_streams" ("id", "merchant_id", "currency")
SELECT gen_random_uuid(), "m"."id", "c"."currency"
FROM "merchants" "m" CROSS JOIN (VALUES ('ETB'::char(3)), ('USD'::char(3))) "c"("currency")
ON CONFLICT ("merchant_id", "currency") DO NOTHING;

INSERT INTO "settlement_positions" (
  "id", "payment_intent_id", "payment_public_id", "merchant_id", "currency",
  "captured_amount_minor", "refunded_amount_minor", "available_at", "captured_at",
  "last_event_id", "last_event_occurred_at"
)
SELECT gen_random_uuid(), "p"."id", "p"."public_id", "p"."merchant_id", "p"."currency",
  "p"."captured_amount_minor", "p"."refunded_amount_minor", "p"."available_at", "p"."captured_at",
  "e"."event_id", "e"."occurred_at"
FROM "payment_intents" "p"
JOIN LATERAL (
  SELECT "event_id", "occurred_at" FROM "outbox_events"
  WHERE "merchant_id" = "p"."merchant_id" AND "aggregate_id" = "p"."public_id"
    AND "event_type" IN ('payment.captured.v1', 'payment.refunded.v1')
  ORDER BY "occurred_at" DESC, "event_id" DESC LIMIT 1
) "e" ON TRUE
WHERE "p"."captured_at" IS NOT NULL AND "p"."available_at" IS NOT NULL
ON CONFLICT ("payment_intent_id") DO NOTHING;

CREATE FUNCTION public.settleflow_assert_settlement_batch("target_batch_id" UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE "batch" RECORD; "item_count" BIGINT; "adjustment_count" BIGINT;
  "payment_gross" NUMERIC; "fee_total" NUMERIC; "adjustment_total" NUMERIC;
BEGIN
  SELECT * INTO "batch" FROM public."settlement_batches" WHERE "id" = "target_batch_id";
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*), coalesce(sum("gross_minor"),0), coalesce(sum("fee_minor"),0)
    INTO "item_count", "payment_gross", "fee_total"
    FROM public."settlement_batch_items" WHERE "batch_id" = "target_batch_id";
  SELECT count(*), coalesce(sum("amount_minor"),0)
    INTO "adjustment_count", "adjustment_total"
    FROM public."settlement_adjustments" WHERE "batch_id" = "target_batch_id";
  IF "item_count" <> "batch"."item_count"
    OR "adjustment_count" <> "batch"."adjustment_count"
    OR "payment_gross" <> "batch"."payment_gross_minor"
    OR "adjustment_total" <> "batch"."adjustment_minor"
    OR "fee_total" <> "batch"."fee_minor"
  THEN RAISE EXCEPTION 'settlement batch child evidence does not equal finalized totals'
    USING ERRCODE='23514', CONSTRAINT='settlement_batches_deferred_totals_check'; END IF;
  IF "batch"."status" <> 'settled' THEN
    RAISE EXCEPTION 'settlement batch must be finalized before commit'
      USING ERRCODE='23514', CONSTRAINT='settlement_batches_finalized_check'; END IF;
END $$;

CREATE FUNCTION public.settleflow_enforce_settlement_batch()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'settlement_batches' THEN
    PERFORM public.settleflow_assert_settlement_batch(NEW."id");
  ELSE
    PERFORM public.settleflow_assert_settlement_batch(COALESCE(NEW."batch_id", OLD."batch_id"));
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "settlement_batches_integrity_trigger"
AFTER INSERT OR UPDATE ON "settlement_batches" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.settleflow_enforce_settlement_batch();
CREATE CONSTRAINT TRIGGER "settlement_batch_items_integrity_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "settlement_batch_items" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.settleflow_enforce_settlement_batch();
CREATE CONSTRAINT TRIGGER "settlement_adjustments_batch_integrity_trigger"
AFTER UPDATE ON "settlement_adjustments" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.settleflow_enforce_settlement_batch();

CREATE FUNCTION public.settleflow_reject_financial_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'settlement and reconciliation evidence is append-only'
    USING ERRCODE='55000', CONSTRAINT=TG_TABLE_NAME || '_append_only_check';
END $$;
CREATE TRIGGER "settlement_fee_policies_reject_mutation" BEFORE UPDATE OR DELETE ON "settlement_fee_policies" FOR EACH ROW EXECUTE FUNCTION public.settleflow_reject_financial_evidence_mutation();
CREATE TRIGGER "settlement_streams_reject_mutation" BEFORE UPDATE OR DELETE ON "settlement_streams" FOR EACH ROW EXECUTE FUNCTION public.settleflow_reject_financial_evidence_mutation();
CREATE TRIGGER "settlement_runs_reject_mutation" BEFORE UPDATE OR DELETE ON "settlement_runs" FOR EACH ROW EXECUTE FUNCTION public.settleflow_reject_financial_evidence_mutation();
CREATE TRIGGER "settlement_batch_items_reject_mutation" BEFORE UPDATE OR DELETE ON "settlement_batch_items" FOR EACH ROW EXECUTE FUNCTION public.settleflow_reject_financial_evidence_mutation();
CREATE TRIGGER "reconciliation_provider_rows_reject_mutation" BEFORE UPDATE OR DELETE ON "reconciliation_provider_rows" FOR EACH ROW EXECUTE FUNCTION public.settleflow_reject_financial_evidence_mutation();
CREATE TRIGGER "reconciliation_results_reject_mutation" BEFORE UPDATE OR DELETE ON "reconciliation_results" FOR EACH ROW EXECUTE FUNCTION public.settleflow_reject_financial_evidence_mutation();
CREATE TRIGGER "reconciliation_summaries_reject_mutation" BEFORE UPDATE OR DELETE ON "reconciliation_summaries" FOR EACH ROW EXECUTE FUNCTION public.settleflow_reject_financial_evidence_mutation();

CREATE FUNCTION public.settleflow_guard_settlement_batch_update()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."status"='batched' AND NEW."status"='settled' AND OLD."settled_at" IS NULL
    AND NEW."settled_at"=transaction_timestamp()
    AND ROW(NEW."id",NEW."public_id",NEW."merchant_id",NEW."currency",NEW."cutoff_date",NEW."cutoff_timezone",NEW."cutoff_at",NEW."payment_gross_minor",NEW."adjustment_minor",NEW."gross_minor",NEW."fee_minor",NEW."net_minor",NEW."item_count",NEW."adjustment_count",NEW."ledger_transaction_id",NEW."created_at")
      IS NOT DISTINCT FROM ROW(OLD."id",OLD."public_id",OLD."merchant_id",OLD."currency",OLD."cutoff_date",OLD."cutoff_timezone",OLD."cutoff_at",OLD."payment_gross_minor",OLD."adjustment_minor",OLD."gross_minor",OLD."fee_minor",OLD."net_minor",OLD."item_count",OLD."adjustment_count",OLD."ledger_transaction_id",OLD."created_at")
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'settlement batch mutation is not an approved finalization'
    USING ERRCODE='55000', CONSTRAINT='settlement_batches_finalization_only_check';
END $$;
CREATE TRIGGER "settlement_batches_guard_update_delete" BEFORE UPDATE OR DELETE ON "settlement_batches" FOR EACH ROW EXECUTE FUNCTION public.settleflow_guard_settlement_batch_update();

CREATE FUNCTION public.settleflow_guard_settlement_adjustment_update()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW."id",NEW."public_id",NEW."merchant_id",NEW."currency",NEW."payment_intent_id",NEW."settlement_position_id",NEW."original_batch_item_id",NEW."refund_id",NEW."refund_public_id",NEW."amount_minor",NEW."source_event_id",NEW."occurred_at",NEW."created_at")
    IS DISTINCT FROM ROW(OLD."id",OLD."public_id",OLD."merchant_id",OLD."currency",OLD."payment_intent_id",OLD."settlement_position_id",OLD."original_batch_item_id",OLD."refund_id",OLD."refund_public_id",OLD."amount_minor",OLD."source_event_id",OLD."occurred_at",OLD."created_at")
  THEN RAISE EXCEPTION 'settlement adjustment identity is immutable' USING ERRCODE='55000', CONSTRAINT='settlement_adjustments_identity_check'; END IF;
  IF (OLD."status"='pending' AND NEW."status"='batched' AND OLD."batch_id" IS NULL AND NEW."batch_id" IS NOT NULL AND NEW."settled_at" IS NULL)
    OR (OLD."status"='batched' AND NEW."status"='settled' AND NEW."batch_id"=OLD."batch_id" AND NEW."settled_at"=transaction_timestamp())
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'settlement adjustment transition is invalid' USING ERRCODE='55000', CONSTRAINT='settlement_adjustments_transition_check';
END $$;
CREATE TRIGGER "settlement_adjustments_guard_update_delete" BEFORE UPDATE OR DELETE ON "settlement_adjustments" FOR EACH ROW EXECUTE FUNCTION public.settleflow_guard_settlement_adjustment_update();

CREATE FUNCTION public.settleflow_guard_settlement_position_update()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR ROW(NEW."id",NEW."payment_intent_id",NEW."payment_public_id",NEW."merchant_id",NEW."currency",NEW."available_at",NEW."captured_at",NEW."created_at")
      IS DISTINCT FROM ROW(OLD."id",OLD."payment_intent_id",OLD."payment_public_id",OLD."merchant_id",OLD."currency",OLD."available_at",OLD."captured_at",OLD."created_at")
    OR NEW."captured_amount_minor" < OLD."captured_amount_minor"
    OR NEW."refunded_amount_minor" < OLD."refunded_amount_minor"
    OR NEW."refunded_amount_minor" > NEW."captured_amount_minor"
    OR NEW."last_event_occurred_at" < OLD."last_event_occurred_at"
    OR NEW."updated_at" < OLD."updated_at"
  THEN RAISE EXCEPTION 'settlement position mutation is invalid'
    USING ERRCODE='55000', CONSTRAINT='settlement_positions_monotonic_update_check'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "settlement_positions_guard_update_delete" BEFORE UPDATE OR DELETE ON "settlement_positions" FOR EACH ROW EXECUTE FUNCTION public.settleflow_guard_settlement_position_update();

CREATE FUNCTION public.settleflow_guard_reconciliation_import_update()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR OLD."status" <> 'staged'
    OR NEW."status" NOT IN ('staged', 'completed', 'failed')
    OR ROW(NEW."id",NEW."public_id",NEW."merchant_id",NEW."content_sha256",NEW."byte_count",NEW."row_count",NEW."period_start",NEW."period_end",NEW."request_id",NEW."requested_by_api_key_id",NEW."raw_rows_expire_at",NEW."created_at")
      IS DISTINCT FROM ROW(OLD."id",OLD."public_id",OLD."merchant_id",OLD."content_sha256",OLD."byte_count",OLD."row_count",OLD."period_start",OLD."period_end",OLD."request_id",OLD."requested_by_api_key_id",OLD."raw_rows_expire_at",OLD."created_at")
  THEN RAISE EXCEPTION 'reconciliation import mutation is invalid'
    USING ERRCODE='55000', CONSTRAINT='reconciliation_imports_lifecycle_update_check'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "reconciliation_imports_guard_update_delete" BEFORE UPDATE OR DELETE ON "reconciliation_imports" FOR EACH ROW EXECUTE FUNCTION public.settleflow_guard_reconciliation_import_update();

CREATE FUNCTION public.settleflow_reject_financial_evidence_truncate()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'financial evidence cannot be truncated' USING ERRCODE='55000', CONSTRAINT='settlement_reconciliation_no_truncate_check'; END $$;
CREATE TRIGGER "settlement_fee_policies_reject_truncate" BEFORE TRUNCATE ON "settlement_fee_policies" FOR EACH STATEMENT EXECUTE FUNCTION public.settleflow_reject_financial_evidence_truncate();
CREATE TRIGGER "settlement_streams_reject_truncate" BEFORE TRUNCATE ON "settlement_streams" FOR EACH STATEMENT EXECUTE FUNCTION public.settleflow_reject_financial_evidence_truncate();
CREATE TRIGGER "settlement_positions_reject_truncate" BEFORE TRUNCATE ON "settlement_positions" FOR EACH STATEMENT EXECUTE FUNCTION public.settleflow_reject_financial_evidence_truncate();
CREATE TRIGGER "settlement_runs_reject_truncate" BEFORE TRUNCATE ON "settlement_runs" FOR EACH STATEMENT EXECUTE FUNCTION public.settleflow_reject_financial_evidence_truncate();
CREATE TRIGGER "settlement_batches_reject_truncate" BEFORE TRUNCATE ON "settlement_batches" FOR EACH STATEMENT EXECUTE FUNCTION public.settleflow_reject_financial_evidence_truncate();
CREATE TRIGGER "settlement_batch_items_reject_truncate" BEFORE TRUNCATE ON "settlement_batch_items" FOR EACH STATEMENT EXECUTE FUNCTION public.settleflow_reject_financial_evidence_truncate();
CREATE TRIGGER "settlement_adjustments_reject_truncate" BEFORE TRUNCATE ON "settlement_adjustments" FOR EACH STATEMENT EXECUTE FUNCTION public.settleflow_reject_financial_evidence_truncate();
CREATE TRIGGER "reconciliation_imports_reject_truncate" BEFORE TRUNCATE ON "reconciliation_imports" FOR EACH STATEMENT EXECUTE FUNCTION public.settleflow_reject_financial_evidence_truncate();
CREATE TRIGGER "reconciliation_provider_rows_reject_truncate" BEFORE TRUNCATE ON "reconciliation_provider_rows" FOR EACH STATEMENT EXECUTE FUNCTION public.settleflow_reject_financial_evidence_truncate();
CREATE TRIGGER "reconciliation_results_reject_truncate" BEFORE TRUNCATE ON "reconciliation_results" FOR EACH STATEMENT EXECUTE FUNCTION public.settleflow_reject_financial_evidence_truncate();
CREATE TRIGGER "reconciliation_summaries_reject_truncate" BEFORE TRUNCATE ON "reconciliation_summaries" FOR EACH STATEMENT EXECUTE FUNCTION public.settleflow_reject_financial_evidence_truncate();

-- Exact route/result vocabularies for independently scoped commands.
ALTER TABLE "idempotency_keys"
  DROP CONSTRAINT "idempotency_keys_normalized_route_check",
  ADD CONSTRAINT "idempotency_keys_normalized_route_check" CHECK ("normalized_route" IN (
    '/v1/payment-intents', '/v1/payment-intents/{id}/capture', '/v1/payment-intents/{id}/refunds',
    '/v1/settlement-runs', '/v1/reconciliation-imports'
  )),
  DROP CONSTRAINT "idempotency_keys_result_reference_format_check",
  ADD CONSTRAINT "idempotency_keys_result_reference_format_check" CHECK (
    "result_reference" IS NULL OR "result_reference" ~ '^(pi|rf|str|rec)_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
  );

-- Audit remains append-only while admitting only the two approved operations.
ALTER TABLE "audit_events"
  DROP CONSTRAINT "audit_events_action_check",
  ADD CONSTRAINT "audit_events_action_check" CHECK ("action" IN (
    'webhook_endpoint.created', 'webhook_endpoint.status_changed',
    'webhook_endpoint.subscriptions_changed', 'webhook_endpoint.secret_rotated',
    'settlement.run_executed', 'reconciliation.import_created'
  )),
  DROP CONSTRAINT "audit_events_target_type_check",
  ADD CONSTRAINT "audit_events_target_type_check" CHECK ("target_type" IN (
    'webhook_endpoint', 'settlement_run', 'reconciliation_import'
  )),
  DROP CONSTRAINT "audit_events_target_id_format_check",
  ADD CONSTRAINT "audit_events_target_id_format_check" CHECK (
    ("target_type" = 'webhook_endpoint' AND "target_id" ~ '^whe_[0-9A-HJKMNP-TV-Z]{26}$')
    OR ("target_type" = 'settlement_run' AND "target_id" ~ '^str_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
    OR ("target_type" = 'reconciliation_import' AND "target_id" ~ '^rec_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
  );

-- Public events are projected generically; Payment-only columns remain strict
-- for the existing three event contracts.
UPDATE "webhook_event_projections"
SET "aggregate_id" = "payment_id", "aggregate_type" = 'payment_intent'
WHERE "aggregate_id" = '';
ALTER TABLE "webhook_event_projections"
  ALTER COLUMN "aggregate_id" DROP DEFAULT,
  ALTER COLUMN "aggregate_type" DROP DEFAULT,
  DROP CONSTRAINT "webhook_event_projections_event_type_check",
  ADD CONSTRAINT "webhook_event_projections_event_type_check" CHECK ("event_type" IN (
    'payment.created.v1', 'payment.captured.v1', 'payment.refunded.v1',
    'settlement.finalized.v1', 'reconciliation.completed.v1'
  )),
  DROP CONSTRAINT "webhook_event_projections_event_fields_check",
  ADD CONSTRAINT "webhook_event_projections_event_fields_check" CHECK (
    ("event_type" = 'payment.created.v1' AND "aggregate_type" = 'payment_intent'
      AND "aggregate_id" = "payment_id" AND "payment_id" IS NOT NULL
      AND "amount_minor" IS NOT NULL AND "currency" IS NOT NULL
      AND "payment_status" = 'CREATED' AND "refund_id" IS NULL
      AND "ledger_transaction_id" IS NULL AND "available_on" IS NULL
      AND "cumulative_refunded_amount_minor" IS NULL)
    OR ("event_type" = 'payment.captured.v1' AND "aggregate_type" = 'payment_intent'
      AND "aggregate_id" = "payment_id" AND "payment_id" IS NOT NULL
      AND "amount_minor" IS NOT NULL AND "currency" IS NOT NULL
      AND "payment_status" IS NULL AND "refund_id" IS NULL
      AND "ledger_transaction_id" ~ '^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
      AND "available_on" = "occurred_at" AND "cumulative_refunded_amount_minor" IS NULL)
    OR ("event_type" = 'payment.refunded.v1' AND "aggregate_type" = 'payment_intent'
      AND "aggregate_id" = "payment_id" AND "payment_id" IS NOT NULL
      AND "amount_minor" IS NOT NULL AND "currency" IS NOT NULL
      AND "payment_status" IS NULL AND "refund_id" ~ '^rf_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
      AND "ledger_transaction_id" ~ '^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
      AND "available_on" IS NULL
      AND "cumulative_refunded_amount_minor" BETWEEN "amount_minor" AND 9007199254740991)
    OR ("event_type" = 'settlement.finalized.v1' AND "aggregate_type" = 'settlement_batch'
      AND "aggregate_id" ~ '^stb_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
      AND "payment_id" IS NULL AND "amount_minor" IS NULL AND "currency" IS NULL
      AND "payment_status" IS NULL AND "refund_id" IS NULL
      AND "ledger_transaction_id" IS NULL AND "available_on" IS NULL
      AND "cumulative_refunded_amount_minor" IS NULL)
    OR ("event_type" = 'reconciliation.completed.v1' AND "aggregate_type" = 'reconciliation_import'
      AND "aggregate_id" ~ '^rec_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
      AND "payment_id" IS NULL AND "amount_minor" IS NULL AND "currency" IS NULL
      AND "payment_status" IS NULL AND "refund_id" IS NULL
      AND "ledger_transaction_id" IS NULL AND "available_on" IS NULL
      AND "cumulative_refunded_amount_minor" IS NULL)
  );
ALTER TABLE "webhook_endpoint_subscriptions"
  DROP CONSTRAINT "webhook_endpoint_subscriptions_event_type_check",
  ADD CONSTRAINT "webhook_endpoint_subscriptions_event_type_check" CHECK ("event_type" IN (
    'payment.created.v1', 'payment.captured.v1', 'payment.refunded.v1',
    'settlement.finalized.v1', 'reconciliation.completed.v1'
  ));

ALTER TABLE "outbox_events"
  DROP CONSTRAINT "outbox_events_event_type_check",
  ADD CONSTRAINT "outbox_events_event_type_check" CHECK ("event_type" IN (
    'payment.created.v1', 'payment.captured.v1', 'payment.refunded.v1',
    'settlement.finalized.v1', 'reconciliation.completed.v1'
  )),
  DROP CONSTRAINT "outbox_events_aggregate_type_check",
  ADD CONSTRAINT "outbox_events_aggregate_type_check" CHECK (
    "aggregate_type" IN ('payment_intent', 'settlement_batch', 'reconciliation_import')
  ),
  DROP CONSTRAINT "outbox_events_aggregate_id_format_check",
  ADD CONSTRAINT "outbox_events_aggregate_id_format_check" CHECK (
    ("aggregate_type" = 'payment_intent' AND "aggregate_id" ~ '^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
    OR ("aggregate_type" = 'settlement_batch' AND "aggregate_id" ~ '^stb_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
    OR ("aggregate_type" = 'reconciliation_import' AND "aggregate_id" ~ '^rec_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
  ),
  DROP CONSTRAINT "outbox_events_payload_contract_check",
  ADD CONSTRAINT "outbox_events_payload_contract_check" CHECK (
    jsonb_typeof("payload") = 'object'
    AND "payload" ->> 'eventId' = "event_id"
    AND "payload" ->> 'eventType' = "event_type"
    AND "payload" ->> 'requestId' = "request_id"
    AND "payload" ->> 'merchantId' = "merchant_id"::text
    AND jsonb_typeof("payload" -> 'occurredAt') = 'string'
    AND CASE WHEN "payload" ->> 'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      THEN ("payload" ->> 'occurredAt')::timestamptz = "occurred_at" ELSE FALSE END
    AND (
      ("event_type" = 'payment.created.v1' AND "aggregate_type" = 'payment_intent'
        AND "payload" ->> 'paymentId' = "aggregate_id"
        AND "payload" - ARRAY['eventId','eventType','occurredAt','requestId','merchantId','paymentId','amountMinor','currency','status'] = '{}'::jsonb
        AND "payload" ->> 'status' = 'CREATED')
      OR ("event_type" = 'payment.captured.v1' AND "aggregate_type" = 'payment_intent'
        AND "payload" ->> 'paymentId' = "aggregate_id"
        AND "payload" - ARRAY['eventId','eventType','occurredAt','requestId','merchantId','paymentId','capturedAmountMinor','currency','availableOn','ledgerTransactionId'] = '{}'::jsonb)
      OR ("event_type" = 'payment.refunded.v1' AND "aggregate_type" = 'payment_intent'
        AND "payload" ->> 'paymentId' = "aggregate_id"
        AND "payload" - ARRAY['eventId','eventType','occurredAt','requestId','merchantId','paymentId','refundId','amountMinor','currency','cumulativeRefundedAmountMinor','ledgerTransactionId'] = '{}'::jsonb)
      OR ("event_type" = 'settlement.finalized.v1' AND "aggregate_type" = 'settlement_batch'
        AND "payload" ->> 'batchId' = "aggregate_id"
        AND "payload" - ARRAY['eventId','eventType','occurredAt','requestId','merchantId','batchId','cutoffAt','grossAmountMinor','feeAmountMinor','netAmountMinor','currency','itemCount'] = '{}'::jsonb
        AND "payload" ->> 'currency' IN ('ETB','USD')
        AND ("payload" ->> 'grossAmountMinor')::numeric BETWEEN 1 AND 9007199254740991
        AND ("payload" ->> 'feeAmountMinor')::numeric BETWEEN 1 AND 9007199254740991
        AND ("payload" ->> 'netAmountMinor')::numeric BETWEEN 1 AND 9007199254740991
        AND ("payload" ->> 'grossAmountMinor')::numeric = ("payload" ->> 'feeAmountMinor')::numeric + ("payload" ->> 'netAmountMinor')::numeric
        AND ("payload" ->> 'itemCount')::numeric BETWEEN 1 AND 500)
      OR ("event_type" = 'reconciliation.completed.v1' AND "aggregate_type" = 'reconciliation_import'
        AND "payload" ->> 'importId' = "aggregate_id"
        AND "payload" - ARRAY['eventId','eventType','occurredAt','requestId','merchantId','importId','matchedExactCount','mismatchCount','unexplainedDifferenceMinorByCurrency'] = '{}'::jsonb
        AND jsonb_typeof("payload" -> 'unexplainedDifferenceMinorByCurrency') = 'object'
        AND ("payload" -> 'unexplainedDifferenceMinorByCurrency') - ARRAY['ETB','USD'] = '{}'::jsonb)
    )
  );

ALTER TABLE "inbox_messages"
  DROP CONSTRAINT IF EXISTS "inbox_messages_consumer_event_match_check",
  DROP CONSTRAINT "inbox_messages_consumer_name_check",
  DROP CONSTRAINT "inbox_messages_event_type_check",
  ADD CONSTRAINT "inbox_messages_consumer_name_check" CHECK ("consumer_name" IN (
    'webhook-projection.payment-created.v1', 'webhook-projection.payment-captured.v1',
    'webhook-projection.payment-refunded.v1', 'webhook-projection.settlement-finalized.v1',
    'webhook-projection.reconciliation-completed.v1', 'settlement-projection.payment-captured.v1',
    'settlement-projection.payment-refunded.v1'
  )),
  ADD CONSTRAINT "inbox_messages_event_type_check" CHECK ("event_type" IN (
    'payment.created.v1', 'payment.captured.v1', 'payment.refunded.v1',
    'settlement.finalized.v1', 'reconciliation.completed.v1'
  )),
  ADD CONSTRAINT "inbox_messages_consumer_event_match_check" CHECK (
    ("event_type" = 'payment.created.v1' AND "consumer_name" = 'webhook-projection.payment-created.v1')
    OR ("event_type" = 'payment.captured.v1' AND "consumer_name" IN ('webhook-projection.payment-captured.v1','settlement-projection.payment-captured.v1'))
    OR ("event_type" = 'payment.refunded.v1' AND "consumer_name" IN ('webhook-projection.payment-refunded.v1','settlement-projection.payment-refunded.v1'))
    OR ("event_type" = 'settlement.finalized.v1' AND "consumer_name" = 'webhook-projection.settlement-finalized.v1')
    OR ("event_type" = 'reconciliation.completed.v1' AND "consumer_name" = 'webhook-projection.reconciliation-completed.v1')
  );

-- Runtime access is explicit. Immutable evidence has no delete/truncate grant.
REVOKE ALL PRIVILEGES ON TABLE
  "settlement_fee_policies", "settlement_streams", "settlement_positions",
  "settlement_runs", "settlement_batches", "settlement_batch_items", "settlement_adjustments",
  "reconciliation_imports", "reconciliation_provider_rows", "reconciliation_results",
  "reconciliation_summaries"
FROM "settleflow_app";
GRANT SELECT ON TABLE "settlement_fee_policies" TO "settleflow_app";
GRANT SELECT, INSERT ON TABLE "settlement_runs", "settlement_batch_items",
  "reconciliation_provider_rows", "reconciliation_results", "reconciliation_summaries" TO "settleflow_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "settlement_streams" TO "settleflow_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "settlement_positions", "settlement_batches",
  "settlement_adjustments", "reconciliation_imports" TO "settleflow_app";
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM "settleflow_app";
GRANT SELECT, INSERT ON TABLE "webhook_event_projections" TO "settleflow_app";
GRANT SELECT, INSERT, DELETE ON TABLE "webhook_endpoint_subscriptions" TO "settleflow_app";

COMMIT;
