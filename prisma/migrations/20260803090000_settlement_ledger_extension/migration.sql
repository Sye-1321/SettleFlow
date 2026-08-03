BEGIN;

-- ADR-0021: extend the closed merchant chart and guarded posting vocabulary.
ALTER TYPE "ledger_business_type" ADD VALUE 'settlement';

ALTER TABLE "ledger_accounts"
  DROP CONSTRAINT "ledger_accounts_code_allowlist_check",
  DROP CONSTRAINT "ledger_accounts_code_normal_side_check",
  ADD CONSTRAINT "ledger_accounts_code_allowlist_check"
    CHECK ("code" IN (
      'provider_clearing', 'merchant_payable', 'fee_revenue', 'settlement_clearing'
    )),
  ADD CONSTRAINT "ledger_accounts_code_normal_side_check"
    CHECK (
      ("code" = 'provider_clearing' AND "normal_side" = 'debit')
      OR ("code" IN ('merchant_payable', 'fee_revenue', 'settlement_clearing')
          AND "normal_side" = 'credit')
    );

INSERT INTO "ledger_accounts" (
  "id", "merchant_id", "code", "currency", "normal_side", "created_at"
)
SELECT
  gen_random_uuid(), "merchant"."id", "definition"."code",
  "definition"."currency", 'credit'::"ledger_entry_side", transaction_timestamp()
FROM "merchants" AS "merchant"
CROSS JOIN (
  VALUES
    ('fee_revenue'::VARCHAR(64), 'ETB'::CHAR(3)),
    ('settlement_clearing'::VARCHAR(64), 'ETB'::CHAR(3)),
    ('fee_revenue'::VARCHAR(64), 'USD'::CHAR(3)),
    ('settlement_clearing'::VARCHAR(64), 'USD'::CHAR(3))
) AS "definition"("code", "currency")
ON CONFLICT ("merchant_id", "code", "currency") DO NOTHING;

-- Keep the accepted deferred integrity assertion while changing only the
-- closed-chart cardinality from four to eight accounts per merchant.
DO $$
DECLARE
  "definition" TEXT;
BEGIN
  SELECT pg_get_functiondef('public.settleflow_assert_ledger_transaction(uuid)'::regprocedure)
  INTO "definition";
  "definition" := replace(
    "definition",
    ') <> 4 THEN',
    ') <> 8 THEN'
  );
  IF "definition" NOT LIKE '%) <> 8 THEN%' THEN
    RAISE EXCEPTION 'ledger assertion definition did not contain the approved chart cardinality';
  END IF;
  EXECUTE "definition";
END
$$;

REVOKE ALL PRIVILEGES ON TABLE "ledger_accounts" FROM "settleflow_app";
GRANT SELECT, INSERT ON TABLE "ledger_accounts" TO "settleflow_app";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "ledger_accounts" FROM "settleflow_app";

COMMIT;
