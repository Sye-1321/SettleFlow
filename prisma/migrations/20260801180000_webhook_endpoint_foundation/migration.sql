-- The runtime role is cluster-scoped and must be provisioned by the owner
-- before this migration. Keep role creation/passwords outside migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'settleflow_app') THEN
    RAISE EXCEPTION 'settleflow_app is not provisioned; run pnpm db:provision-runtime-role first'
      USING ERRCODE = '42704';
  END IF;
END
$$;

CREATE TYPE "webhook_endpoint_status" AS ENUM ('active', 'inactive');
CREATE TYPE "webhook_secret_lifecycle" AS ENUM ('current', 'previous', 'retired');

CREATE TABLE "webhook_endpoints" (
  "id" UUID NOT NULL,
  "public_id" VARCHAR(30) NOT NULL,
  "merchant_id" UUID NOT NULL,
  "normalized_url" TEXT NOT NULL,
  "status" "webhook_endpoint_status" NOT NULL DEFAULT 'active',
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_endpoints_public_id_format_check"
    CHECK ("public_id" ~ '^whe_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT "webhook_endpoints_normalized_url_length_check"
    CHECK (octet_length("normalized_url") BETWEEN 1 AND 2048),
  CONSTRAINT "webhook_endpoints_normalized_url_control_character_check"
    CHECK ("normalized_url" !~ '[[:cntrl:]]'),
  CONSTRAINT "webhook_endpoints_version_check" CHECK ("version" >= 0)
);

CREATE TABLE "webhook_endpoint_subscriptions" (
  "endpoint_id" UUID NOT NULL,
  "event_type" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_endpoint_subscriptions_pkey" PRIMARY KEY ("endpoint_id", "event_type"),
  CONSTRAINT "webhook_endpoint_subscriptions_event_type_check"
    CHECK ("event_type" = 'payment.created.v1')
);

CREATE TABLE "webhook_endpoint_secrets" (
  "id" UUID NOT NULL,
  "endpoint_id" UUID NOT NULL,
  "secret_version" INTEGER NOT NULL,
  "lifecycle" "webhook_secret_lifecycle" NOT NULL,
  "algorithm" VARCHAR(32) NOT NULL,
  "encryption_key_id" VARCHAR(64) NOT NULL,
  "nonce" BYTEA NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "authentication_tag" BYTEA NOT NULL,
  "overlap_expires_at" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_endpoint_secrets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_endpoint_secrets_secret_version_check" CHECK ("secret_version" >= 1),
  CONSTRAINT "webhook_endpoint_secrets_algorithm_check" CHECK ("algorithm" = 'aes-256-gcm'),
  CONSTRAINT "webhook_endpoint_secrets_encryption_key_id_check"
    CHECK ("encryption_key_id" ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT "webhook_endpoint_secrets_nonce_length_check" CHECK (octet_length("nonce") = 12),
  CONSTRAINT "webhook_endpoint_secrets_ciphertext_length_check" CHECK (octet_length("ciphertext") = 49),
  CONSTRAINT "webhook_endpoint_secrets_authentication_tag_length_check"
    CHECK (octet_length("authentication_tag") = 16),
  CONSTRAINT "webhook_endpoint_secrets_lifecycle_check" CHECK (
    ("lifecycle" = 'current' AND "overlap_expires_at" IS NULL AND "retired_at" IS NULL)
    OR ("lifecycle" = 'previous' AND "overlap_expires_at" IS NOT NULL AND "retired_at" IS NULL)
    OR ("lifecycle" = 'retired' AND "retired_at" IS NOT NULL)
  )
);

CREATE TABLE "audit_events" (
  "id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "actor_type" VARCHAR(32) NOT NULL,
  "actor_api_key_id" UUID NOT NULL,
  "action" VARCHAR(128) NOT NULL,
  "target_type" VARCHAR(64) NOT NULL,
  "target_id" VARCHAR(30) NOT NULL,
  "reason" VARCHAR(64) NOT NULL,
  "request_id" VARCHAR(128) NOT NULL,
  "details" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_events_actor_type_check" CHECK ("actor_type" = 'merchant_api_key'),
  CONSTRAINT "audit_events_action_check" CHECK (
    "action" IN (
      'webhook_endpoint.created',
      'webhook_endpoint.secret_rotated',
      'webhook_endpoint.status_changed',
      'webhook_endpoint.subscriptions_changed'
    )
  ),
  CONSTRAINT "audit_events_target_type_check" CHECK ("target_type" = 'webhook_endpoint'),
  CONSTRAINT "audit_events_target_id_format_check"
    CHECK ("target_id" ~ '^whe_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT "audit_events_reason_check" CHECK ("reason" = 'merchant_api_request'),
  CONSTRAINT "audit_events_request_id_check"
    CHECK ("request_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "audit_events_details_check"
    CHECK (jsonb_typeof("details") = 'object' AND octet_length("details"::text) <= 4096)
);

CREATE UNIQUE INDEX "webhook_endpoints_public_id_key"
  ON "webhook_endpoints"("public_id");
CREATE UNIQUE INDEX "webhook_endpoints_merchant_id_normalized_url_key"
  ON "webhook_endpoints"("merchant_id", "normalized_url");
CREATE INDEX "webhook_endpoints_merchant_id_public_id_idx"
  ON "webhook_endpoints"("merchant_id", "public_id" DESC);
CREATE UNIQUE INDEX "webhook_endpoint_secrets_endpoint_id_secret_version_key"
  ON "webhook_endpoint_secrets"("endpoint_id", "secret_version");
CREATE UNIQUE INDEX "webhook_endpoint_secrets_one_current_idx"
  ON "webhook_endpoint_secrets"("endpoint_id") WHERE "lifecycle" = 'current';
CREATE UNIQUE INDEX "webhook_endpoint_secrets_one_previous_idx"
  ON "webhook_endpoint_secrets"("endpoint_id") WHERE "lifecycle" = 'previous';
CREATE INDEX "audit_events_merchant_id_occurred_at_id_idx"
  ON "audit_events"("merchant_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "audit_events_target_occurred_at_id_idx"
  ON "audit_events"("target_type", "target_id", "occurred_at" DESC, "id" DESC);

ALTER TABLE "webhook_endpoints"
  ADD CONSTRAINT "webhook_endpoints_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_endpoint_subscriptions"
  ADD CONSTRAINT "webhook_endpoint_subscriptions_endpoint_id_fkey"
  FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_endpoint_secrets"
  ADD CONSTRAINT "webhook_endpoint_secrets_endpoint_id_fkey"
  FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_actor_api_key_id_fkey"
  FOREIGN KEY ("actor_api_key_id") REFERENCES "api_keys"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "settleflow_check_endpoint_has_subscription"("target_endpoint_id" UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "webhook_endpoints" WHERE "id" = "target_endpoint_id")
    AND NOT EXISTS (
      SELECT 1 FROM "webhook_endpoint_subscriptions"
      WHERE "endpoint_id" = "target_endpoint_id"
    ) THEN
    RAISE EXCEPTION 'webhook endpoint requires at least one subscription'
      USING ERRCODE = '23514', CONSTRAINT = 'webhook_endpoint_subscriptions_nonempty_check';
  END IF;
END;
$$;

CREATE FUNCTION "settleflow_enforce_endpoint_subscription"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'webhook_endpoints' THEN
    PERFORM "settleflow_check_endpoint_has_subscription"(NEW."id");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM "settleflow_check_endpoint_has_subscription"(OLD."endpoint_id");
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM "settleflow_check_endpoint_has_subscription"(OLD."endpoint_id");
    IF NEW."endpoint_id" <> OLD."endpoint_id" THEN
      PERFORM "settleflow_check_endpoint_has_subscription"(NEW."endpoint_id");
    END IF;
  ELSE
    PERFORM "settleflow_check_endpoint_has_subscription"(NEW."endpoint_id");
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "webhook_endpoints_subscription_required_trigger"
AFTER INSERT ON "webhook_endpoints"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "settleflow_enforce_endpoint_subscription"();

CREATE CONSTRAINT TRIGGER "webhook_endpoint_subscriptions_nonempty_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "webhook_endpoint_subscriptions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "settleflow_enforce_endpoint_subscription"();

CREATE FUNCTION "settleflow_check_endpoint_has_current_secret"("target_endpoint_id" UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  current_count INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM "webhook_endpoints" WHERE "id" = "target_endpoint_id") THEN
    SELECT count(*) INTO current_count
    FROM "webhook_endpoint_secrets"
    WHERE "endpoint_id" = "target_endpoint_id" AND "lifecycle" = 'current';
    IF current_count <> 1 THEN
      RAISE EXCEPTION 'webhook endpoint requires exactly one current secret'
        USING ERRCODE = '23514', CONSTRAINT = 'webhook_endpoint_secrets_current_required_check';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION "settleflow_enforce_endpoint_current_secret"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'webhook_endpoints' THEN
    PERFORM "settleflow_check_endpoint_has_current_secret"(NEW."id");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM "settleflow_check_endpoint_has_current_secret"(OLD."endpoint_id");
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM "settleflow_check_endpoint_has_current_secret"(OLD."endpoint_id");
    IF NEW."endpoint_id" <> OLD."endpoint_id" THEN
      PERFORM "settleflow_check_endpoint_has_current_secret"(NEW."endpoint_id");
    END IF;
  ELSE
    PERFORM "settleflow_check_endpoint_has_current_secret"(NEW."endpoint_id");
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "webhook_endpoints_current_secret_required_trigger"
AFTER INSERT ON "webhook_endpoints"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "settleflow_enforce_endpoint_current_secret"();

CREATE CONSTRAINT TRIGGER "webhook_endpoint_secrets_current_required_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "webhook_endpoint_secrets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "settleflow_enforce_endpoint_current_secret"();

CREATE FUNCTION "settleflow_reject_audit_event_row_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'audit_events_append_only_check';
END;
$$;

CREATE TRIGGER "audit_events_reject_update_delete_trigger"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "settleflow_reject_audit_event_row_mutation"();

CREATE FUNCTION "settleflow_reject_audit_event_truncate"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'audit_events_append_only_check';
END;
$$;

CREATE TRIGGER "audit_events_reject_truncate_trigger"
BEFORE TRUNCATE ON "audit_events"
FOR EACH STATEMENT EXECUTE FUNCTION "settleflow_reject_audit_event_truncate"();

REVOKE CREATE ON SCHEMA "public" FROM "settleflow_app";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM "settleflow_app";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "public" FROM "settleflow_app";

GRANT SELECT, INSERT, UPDATE ON TABLE
  "merchants",
  "api_keys",
  "payment_intents",
  "idempotency_keys",
  "outbox_events"
TO "settleflow_app";

GRANT SELECT, INSERT, UPDATE ON TABLE "webhook_endpoints" TO "settleflow_app";
GRANT SELECT, INSERT, DELETE ON TABLE "webhook_endpoint_subscriptions" TO "settleflow_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "webhook_endpoint_secrets" TO "settleflow_app";
GRANT SELECT, INSERT ON TABLE "audit_events" TO "settleflow_app";

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_events" FROM "settleflow_app";
GRANT USAGE ON SCHEMA "public" TO "settleflow_app";
