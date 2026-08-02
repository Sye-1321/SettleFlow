-- ADR-0020: immutable, merchant-scoped, posted-only double-entry ledger.
-- The shared runtime role is provisioned outside migrations so credentials
-- never enter migration history.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'settleflow_app') THEN
    RAISE EXCEPTION 'settleflow_app is not provisioned; run pnpm db:provision-runtime-role first'
      USING ERRCODE = '42704';
  END IF;
END
$$;

CREATE TYPE "ledger_entry_side" AS ENUM ('debit', 'credit');
CREATE TYPE "ledger_business_type" AS ENUM ('capture', 'refund', 'reversal');

CREATE TABLE "ledger_accounts" (
  "id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "normal_side" "ledger_entry_side" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_accounts_currency_format_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ledger_accounts_currency_allowlist_check"
    CHECK ("currency" IN ('ETB', 'USD')),
  CONSTRAINT "ledger_accounts_code_allowlist_check"
    CHECK ("code" IN ('provider_clearing', 'merchant_payable')),
  CONSTRAINT "ledger_accounts_code_normal_side_check"
    CHECK (
      ("code" = 'provider_clearing' AND "normal_side" = 'debit')
      OR ("code" = 'merchant_payable' AND "normal_side" = 'credit')
    )
);

CREATE TABLE "ledger_transactions" (
  "id" UUID NOT NULL,
  "public_id" VARCHAR(30) NOT NULL,
  "merchant_id" UUID NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "business_type" "ledger_business_type" NOT NULL,
  "business_reference" VARCHAR(255) NOT NULL,
  "reversal_of_id" UUID,
  "request_id" VARCHAR(128) NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "posted_at" TIMESTAMPTZ(6),

  CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_transactions_public_id_format_check"
    CHECK ("public_id" ~ '^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT "ledger_transactions_currency_format_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ledger_transactions_currency_allowlist_check"
    CHECK ("currency" IN ('ETB', 'USD')),
  CONSTRAINT "ledger_transactions_business_reference_check"
    CHECK (
      char_length("business_reference") BETWEEN 1 AND 255
      AND "business_reference" !~ '[[:cntrl:]]'
      AND "business_reference" !~ '^[[:space:]]|[[:space:]]$'
    ),
  CONSTRAINT "ledger_transactions_request_id_check"
    CHECK ("request_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "ledger_transactions_reversal_shape_check"
    CHECK (
      ("business_type" = 'reversal' AND "reversal_of_id" IS NOT NULL)
      OR ("business_type" <> 'reversal' AND "reversal_of_id" IS NULL)
    )
);

CREATE TABLE "ledger_entries" (
  "id" UUID NOT NULL,
  "ledger_transaction_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "entry_seq" SMALLINT NOT NULL,
  "side" "ledger_entry_side" NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_entries_sequence_check"
    CHECK ("entry_seq" BETWEEN 1 AND 32767),
  CONSTRAINT "ledger_entries_amount_minor_range_check"
    CHECK ("amount_minor" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "ledger_entries_currency_format_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ledger_entries_currency_allowlist_check"
    CHECK ("currency" IN ('ETB', 'USD'))
);

CREATE UNIQUE INDEX "ledger_accounts_merchant_id_code_currency_key"
  ON "ledger_accounts"("merchant_id", "code", "currency");
CREATE UNIQUE INDEX "ledger_accounts_id_merchant_id_currency_key"
  ON "ledger_accounts"("id", "merchant_id", "currency");
CREATE UNIQUE INDEX "ledger_transactions_public_id_key"
  ON "ledger_transactions"("public_id");
CREATE UNIQUE INDEX "ledger_transactions_merchant_id_business_type_reference_key"
  ON "ledger_transactions"("merchant_id", "business_type", "business_reference");
CREATE UNIQUE INDEX "ledger_transactions_reversal_of_id_key"
  ON "ledger_transactions"("reversal_of_id");
CREATE UNIQUE INDEX "ledger_transactions_id_merchant_id_currency_key"
  ON "ledger_transactions"("id", "merchant_id", "currency");
CREATE UNIQUE INDEX "ledger_entries_transaction_id_entry_seq_key"
  ON "ledger_entries"("ledger_transaction_id", "entry_seq");

ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "ledger_accounts_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "ledger_transactions_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "ledger_transactions_reversal_of_id_merchant_id_currency_fkey"
  FOREIGN KEY ("reversal_of_id", "merchant_id", "currency")
  REFERENCES "ledger_transactions"("id", "merchant_id", "currency")
  ON DELETE RESTRICT ON UPDATE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_transaction_id_merchant_id_currency_fkey"
  FOREIGN KEY ("ledger_transaction_id", "merchant_id", "currency")
  REFERENCES "ledger_transactions"("id", "merchant_id", "currency")
  ON DELETE RESTRICT ON UPDATE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_account_id_merchant_id_currency_fkey"
  FOREIGN KEY ("account_id", "merchant_id", "currency")
  REFERENCES "ledger_accounts"("id", "merchant_id", "currency")
  ON DELETE RESTRICT ON UPDATE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

-- One assertion function is used by both parent and entry constraint triggers.
-- The parent trigger is required so a zero-entry transaction cannot commit.
CREATE FUNCTION "settleflow_assert_ledger_transaction"("target_transaction_id" UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  "target_transaction" RECORD;
  "original_transaction" RECORD;
  "entry_count" BIGINT;
  "original_entry_count" BIGINT;
  "debit_total" NUMERIC;
  "credit_total" NUMERIC;
BEGIN
  SELECT
    "id",
    "merchant_id",
    "currency",
    "business_type",
    "reversal_of_id",
    "posted_at"
  INTO "target_transaction"
  FROM public."ledger_transactions"
  WHERE "id" = "target_transaction_id";

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF "target_transaction"."posted_at" IS NULL THEN
    RAISE EXCEPTION 'ledger transaction must be finalized before commit'
      USING ERRCODE = '23514',
        CONSTRAINT = 'ledger_transactions_posted_at_required_check';
  END IF;

  IF (
    SELECT count(*)
    FROM public."ledger_accounts"
    WHERE "merchant_id" = "target_transaction"."merchant_id"
  ) <> 4 THEN
    RAISE EXCEPTION 'merchant ledger account provisioning is incomplete'
      USING ERRCODE = '23514',
        CONSTRAINT = 'ledger_accounts_provisioning_complete_check';
  END IF;

  SELECT
    count(*),
    COALESCE(sum("amount_minor") FILTER (WHERE "side" = 'debit'), 0::numeric),
    COALESCE(sum("amount_minor") FILTER (WHERE "side" = 'credit'), 0::numeric)
  INTO "entry_count", "debit_total", "credit_total"
  FROM public."ledger_entries"
  WHERE "ledger_transaction_id" = "target_transaction_id";

  IF "entry_count" < 2 THEN
    RAISE EXCEPTION 'ledger transaction requires at least two entries'
      USING ERRCODE = '23514',
        CONSTRAINT = 'ledger_entries_minimum_count_check';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."ledger_entries" AS "entry"
    LEFT JOIN public."ledger_accounts" AS "account"
      ON "account"."id" = "entry"."account_id"
    WHERE "entry"."ledger_transaction_id" = "target_transaction_id"
      AND (
        "entry"."merchant_id" <> "target_transaction"."merchant_id"
        OR "entry"."currency" <> "target_transaction"."currency"
        OR "account"."id" IS NULL
        OR "account"."merchant_id" <> "target_transaction"."merchant_id"
        OR "account"."currency" <> "target_transaction"."currency"
      )
  ) THEN
    RAISE EXCEPTION 'ledger entry merchant or currency does not match its transaction and account'
      USING ERRCODE = '23514',
        CONSTRAINT = 'ledger_entries_currency_consistency_check';
  END IF;

  IF "debit_total" <> "credit_total" THEN
    RAISE EXCEPTION 'ledger transaction debits and credits must balance'
      USING ERRCODE = '23514',
        CONSTRAINT = 'ledger_transactions_balance_check';
  END IF;

  IF "target_transaction"."business_type" = 'reversal' THEN
    SELECT
      "id",
      "merchant_id",
      "currency",
      "business_type",
      "posted_at"
    INTO "original_transaction"
    FROM public."ledger_transactions"
    WHERE "id" = "target_transaction"."reversal_of_id";

    IF NOT FOUND
      OR "original_transaction"."posted_at" IS NULL
      OR "original_transaction"."business_type" = 'reversal'
      OR "original_transaction"."merchant_id" <> "target_transaction"."merchant_id"
      OR "original_transaction"."currency" <> "target_transaction"."currency"
    THEN
      RAISE EXCEPTION 'ledger reversal target is invalid'
        USING ERRCODE = '23514',
          CONSTRAINT = 'ledger_transactions_reversal_target_check';
    END IF;

    SELECT count(*)
    INTO "original_entry_count"
    FROM public."ledger_entries"
    WHERE "ledger_transaction_id" = "original_transaction"."id";

    IF "original_entry_count" <> "entry_count"
      OR EXISTS (
        SELECT 1
        FROM public."ledger_entries" AS "reversal_entry"
        LEFT JOIN public."ledger_entries" AS "original_entry"
          ON "original_entry"."ledger_transaction_id" = "original_transaction"."id"
          AND "original_entry"."entry_seq" = "reversal_entry"."entry_seq"
        WHERE "reversal_entry"."ledger_transaction_id" = "target_transaction_id"
          AND (
            "original_entry"."id" IS NULL
            OR "original_entry"."account_id" <> "reversal_entry"."account_id"
            OR "original_entry"."amount_minor" <> "reversal_entry"."amount_minor"
            OR "original_entry"."currency" <> "reversal_entry"."currency"
            OR "original_entry"."side" = "reversal_entry"."side"
          )
      )
    THEN
      RAISE EXCEPTION 'ledger reversal must exactly invert the original entries'
        USING ERRCODE = '23514',
          CONSTRAINT = 'ledger_transactions_reversal_exact_check';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION "settleflow_enforce_ledger_transaction"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    PERFORM public."settleflow_assert_ledger_transaction"(NEW."id");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public."settleflow_assert_ledger_transaction"(OLD."ledger_transaction_id");
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM public."settleflow_assert_ledger_transaction"(OLD."ledger_transaction_id");
    IF NEW."ledger_transaction_id" <> OLD."ledger_transaction_id" THEN
      PERFORM public."settleflow_assert_ledger_transaction"(NEW."ledger_transaction_id");
    END IF;
  ELSE
    PERFORM public."settleflow_assert_ledger_transaction"(NEW."ledger_transaction_id");
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_transactions_integrity_trigger"
AFTER INSERT OR UPDATE ON "ledger_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "settleflow_enforce_ledger_transaction"();

CREATE CONSTRAINT TRIGGER "ledger_entries_integrity_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "ledger_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "settleflow_enforce_ledger_transaction"();

-- A transaction is staged only inside its creating database transaction. The
-- sole allowed update finalizes posted_at to PostgreSQL's transaction clock.
CREATE FUNCTION "settleflow_guard_ledger_transaction_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."posted_at" IS NOT NULL THEN
      RAISE EXCEPTION 'ledger transaction must be inserted unfinalized'
        USING ERRCODE = '55000',
          CONSTRAINT = 'ledger_transactions_finalization_only_check';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."posted_at" IS NULL
    AND NEW."posted_at" = transaction_timestamp()
    AND ROW(
      NEW."id",
      NEW."public_id",
      NEW."merchant_id",
      NEW."currency",
      NEW."business_type",
      NEW."business_reference",
      NEW."reversal_of_id",
      NEW."request_id",
      NEW."occurred_at",
      NEW."created_at"
    ) IS NOT DISTINCT FROM ROW(
      OLD."id",
      OLD."public_id",
      OLD."merchant_id",
      OLD."currency",
      OLD."business_type",
      OLD."business_reference",
      OLD."reversal_of_id",
      OLD."request_id",
      OLD."occurred_at",
      OLD."created_at"
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'posted ledger transactions are immutable'
    USING ERRCODE = '55000',
      CONSTRAINT = 'ledger_transactions_append_only_check';
END;
$$;

CREATE TRIGGER "ledger_transactions_guard_mutation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ledger_transactions"
FOR EACH ROW EXECUTE FUNCTION "settleflow_guard_ledger_transaction_mutation"();

CREATE FUNCTION "settleflow_guard_ledger_entry_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  "parent_posted_at" TIMESTAMPTZ(6);
BEGIN
  SELECT "posted_at"
  INTO "parent_posted_at"
  FROM public."ledger_transactions"
  WHERE "id" = NEW."ledger_transaction_id";

  IF FOUND AND "parent_posted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'entries cannot be appended to a posted ledger transaction'
      USING ERRCODE = '55000',
        CONSTRAINT = 'ledger_entries_posted_transaction_immutable_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ledger_entries_guard_insert_trigger"
BEFORE INSERT ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "settleflow_guard_ledger_entry_insert"();

CREATE FUNCTION "settleflow_reject_ledger_row_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'ledger accounts and entries are immutable'
    USING ERRCODE = '55000',
      CONSTRAINT = CASE
        WHEN TG_TABLE_NAME = 'ledger_accounts'
          THEN 'ledger_accounts_append_only_check'
        ELSE 'ledger_entries_append_only_check'
      END;
END;
$$;

CREATE TRIGGER "ledger_accounts_reject_update_delete_trigger"
BEFORE UPDATE OR DELETE ON "ledger_accounts"
FOR EACH ROW EXECUTE FUNCTION "settleflow_reject_ledger_row_mutation"();

CREATE TRIGGER "ledger_entries_reject_update_delete_trigger"
BEFORE UPDATE OR DELETE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "settleflow_reject_ledger_row_mutation"();

CREATE FUNCTION "settleflow_reject_ledger_truncate"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'ledger tables cannot be truncated'
    USING ERRCODE = '55000',
      CONSTRAINT = 'ledger_tables_append_only_check';
END;
$$;

CREATE TRIGGER "ledger_accounts_reject_truncate_trigger"
BEFORE TRUNCATE ON "ledger_accounts"
FOR EACH STATEMENT EXECUTE FUNCTION "settleflow_reject_ledger_truncate"();
CREATE TRIGGER "ledger_transactions_reject_truncate_trigger"
BEFORE TRUNCATE ON "ledger_transactions"
FOR EACH STATEMENT EXECUTE FUNCTION "settleflow_reject_ledger_truncate"();
CREATE TRIGGER "ledger_entries_reject_truncate_trigger"
BEFORE TRUNCATE ON "ledger_entries"
FOR EACH STATEMENT EXECUTE FUNCTION "settleflow_reject_ledger_truncate"();

-- Existing merchants receive exactly the closed ETB/USD chart. Future account
-- provisioning uses the internal Ledger port and never a payment transaction.
INSERT INTO "ledger_accounts" (
  "id",
  "merchant_id",
  "code",
  "currency",
  "normal_side",
  "created_at"
)
SELECT
  gen_random_uuid(),
  "merchant"."id",
  "definition"."code",
  "definition"."currency",
  "definition"."normal_side",
  transaction_timestamp()
FROM "merchants" AS "merchant"
CROSS JOIN (
  VALUES
    ('provider_clearing'::VARCHAR(64), 'ETB'::CHAR(3), 'debit'::"ledger_entry_side"),
    ('merchant_payable'::VARCHAR(64), 'ETB'::CHAR(3), 'credit'::"ledger_entry_side"),
    ('provider_clearing'::VARCHAR(64), 'USD'::CHAR(3), 'debit'::"ledger_entry_side"),
    ('merchant_payable'::VARCHAR(64), 'USD'::CHAR(3), 'credit'::"ledger_entry_side")
) AS "definition"("code", "currency", "normal_side")
ORDER BY "merchant"."id", "definition"."currency", "definition"."code"
ON CONFLICT ("merchant_id", "code", "currency") DO NOTHING;

REVOKE ALL PRIVILEGES ON TABLE
  "ledger_accounts",
  "ledger_transactions",
  "ledger_entries"
FROM "settleflow_app";

GRANT SELECT, INSERT ON TABLE
  "ledger_accounts",
  "ledger_entries"
TO "settleflow_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "ledger_transactions" TO "settleflow_app";

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  "ledger_accounts",
  "ledger_entries"
FROM "settleflow_app";
REVOKE DELETE, TRUNCATE ON TABLE "ledger_transactions" FROM "settleflow_app";
GRANT USAGE ON SCHEMA "public" TO "settleflow_app";
