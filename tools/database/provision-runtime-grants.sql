\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'settleflow_app') THEN
    RAISE EXCEPTION 'settleflow_app role must be provisioned before runtime grants';
  END IF;
END;
$$;

REVOKE CREATE ON SCHEMA "public" FROM "settleflow_app";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM "settleflow_app";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "public" FROM "settleflow_app";
GRANT USAGE ON SCHEMA "public" TO "settleflow_app";

GRANT SELECT, INSERT, UPDATE ON TABLE
  "api_keys",
  "idempotency_keys",
  "merchants",
  "outbox_events",
  "payment_intents",
  "reconciliation_imports",
  "settlement_adjustments",
  "settlement_batches",
  "settlement_positions",
  "settlement_streams",
  "webhook_deliveries",
  "webhook_endpoint_secrets",
  "webhook_endpoints"
TO "settleflow_app";

GRANT SELECT, INSERT ON TABLE
  "audit_events",
  "inbox_messages",
  "ledger_accounts",
  "ledger_entries",
  "reconciliation_provider_rows",
  "reconciliation_results",
  "reconciliation_summaries",
  "refunds",
  "settlement_batch_items",
  "settlement_runs",
  "webhook_delivery_attempts",
  "webhook_event_projections"
TO "settleflow_app";

GRANT SELECT, INSERT, UPDATE ON TABLE "ledger_transactions" TO "settleflow_app";
GRANT SELECT ON TABLE "settlement_fee_policies" TO "settleflow_app";
GRANT SELECT, INSERT, DELETE ON TABLE "webhook_endpoint_subscriptions" TO "settleflow_app";

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  "audit_events",
  "ledger_accounts",
  "ledger_entries",
  "reconciliation_provider_rows",
  "reconciliation_results",
  "reconciliation_summaries",
  "refunds",
  "settlement_batch_items",
  "settlement_runs",
  "webhook_delivery_attempts",
  "webhook_event_projections"
FROM "settleflow_app";

REVOKE DELETE, TRUNCATE ON TABLE
  "api_keys",
  "idempotency_keys",
  "ledger_transactions",
  "merchants",
  "outbox_events",
  "payment_intents",
  "reconciliation_imports",
  "settlement_adjustments",
  "settlement_batches",
  "settlement_positions",
  "settlement_streams",
  "webhook_deliveries",
  "webhook_endpoint_secrets",
  "webhook_endpoints"
FROM "settleflow_app";
