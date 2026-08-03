BEGIN;

ALTER TABLE "settlement_batches"
ADD COLUMN "ledger_transaction_public_id" VARCHAR(30);

UPDATE "settlement_batches" AS sb
SET "ledger_transaction_public_id" = lt."public_id"
FROM "ledger_transactions" AS lt
WHERE lt."id" = sb."ledger_transaction_id"
  AND lt."merchant_id" = sb."merchant_id"
  AND lt."currency" = sb."currency";

ALTER TABLE "settlement_batches"
ALTER COLUMN "ledger_transaction_public_id" SET NOT NULL,
ADD CONSTRAINT "settlement_batches_ledger_transaction_public_id_check"
  CHECK ("ledger_transaction_public_id" ~ '^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$');

CREATE UNIQUE INDEX "settlement_batches_ledger_transaction_public_id_key"
ON "settlement_batches"("ledger_transaction_public_id");

CREATE OR REPLACE FUNCTION public.settleflow_guard_settlement_batch_update()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."status"='batched' AND NEW."status"='settled' AND OLD."settled_at" IS NULL
    AND NEW."settled_at"=transaction_timestamp()
    AND ROW(NEW."id",NEW."public_id",NEW."merchant_id",NEW."currency",NEW."cutoff_date",NEW."cutoff_timezone",NEW."cutoff_at",NEW."payment_gross_minor",NEW."adjustment_minor",NEW."gross_minor",NEW."fee_minor",NEW."net_minor",NEW."item_count",NEW."adjustment_count",NEW."ledger_transaction_id",NEW."ledger_transaction_public_id",NEW."created_at")
      IS NOT DISTINCT FROM ROW(OLD."id",OLD."public_id",OLD."merchant_id",OLD."currency",OLD."cutoff_date",OLD."cutoff_timezone",OLD."cutoff_at",OLD."payment_gross_minor",OLD."adjustment_minor",OLD."gross_minor",OLD."fee_minor",OLD."net_minor",OLD."item_count",OLD."adjustment_count",OLD."ledger_transaction_id",OLD."ledger_transaction_public_id",OLD."created_at")
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'settlement batch mutation is not an approved finalization'
    USING ERRCODE='55000', CONSTRAINT='settlement_batches_finalization_only_check';
END $$;

COMMIT;
