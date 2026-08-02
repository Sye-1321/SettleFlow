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

-- Replace the projection-only enum in one compatible migration so every new
-- value can be used by constraints in this migration transaction.
DROP INDEX "webhook_deliveries_pending_next_attempt_at_id_idx";
ALTER TYPE "webhook_delivery_status" RENAME TO "webhook_delivery_status_old";
CREATE TYPE "webhook_delivery_status" AS ENUM (
  'pending',
  'retrying',
  'delivered',
  'dead_lettered'
);
ALTER TABLE "webhook_deliveries" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "webhook_deliveries"
  ALTER COLUMN "status" TYPE "webhook_delivery_status"
  USING ("status"::text::"webhook_delivery_status");
ALTER TABLE "webhook_deliveries" ALTER COLUMN "status" SET DEFAULT 'pending';
DROP TYPE "webhook_delivery_status_old";

CREATE TYPE "webhook_delivery_attempt_outcome" AS ENUM (
  'delivered',
  'retryable_failure',
  'non_retryable_failure',
  'unknown'
);

ALTER TABLE "webhook_deliveries"
  DROP CONSTRAINT "webhook_deliveries_attempt_count_check",
  DROP CONSTRAINT "webhook_deliveries_projection_time_check",
  ALTER COLUMN "next_attempt_at" DROP NOT NULL,
  ADD COLUMN "locked_by" VARCHAR(128),
  ADD COLUMN "claim_token" UUID,
  ADD COLUMN "locked_at" TIMESTAMPTZ(6),
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "active_attempt_number" INTEGER,
  ADD COLUMN "active_attempt_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "active_signature_timestamp" BIGINT,
  ADD COLUMN "active_current_secret_version" INTEGER,
  ADD COLUMN "active_previous_secret_version" INTEGER,
  ADD COLUMN "delivered_at" TIMESTAMPTZ(6),
  ADD COLUMN "dead_lettered_at" TIMESTAMPTZ(6);

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_attempt_count_check"
    CHECK ("attempt_count" BETWEEN 0 AND 7),
  ADD CONSTRAINT "webhook_deliveries_claim_fields_check"
    CHECK (
      (
        "locked_by" IS NULL
        AND "claim_token" IS NULL
        AND "locked_at" IS NULL
        AND "lease_expires_at" IS NULL
      )
      OR (
        "locked_by" IS NOT NULL
        AND "locked_by" ~ '^[A-Za-z0-9._:-]{1,128}$'
        AND "claim_token" IS NOT NULL
        AND "locked_at" IS NOT NULL
        AND "lease_expires_at" > "locked_at"
      )
    ),
  ADD CONSTRAINT "webhook_deliveries_active_attempt_fields_check"
    CHECK (
      (
        "active_attempt_number" IS NULL
        AND "active_attempt_started_at" IS NULL
        AND "active_signature_timestamp" IS NULL
        AND "active_current_secret_version" IS NULL
        AND "active_previous_secret_version" IS NULL
      )
      OR (
        "claim_token" IS NOT NULL
        AND "active_attempt_number" = "attempt_count"
        AND "active_attempt_number" BETWEEN 1 AND 7
        AND "active_attempt_started_at" IS NOT NULL
        AND "active_signature_timestamp" > 0
        AND "active_current_secret_version" >= 1
        AND (
          "active_previous_secret_version" IS NULL
          OR (
            "active_previous_secret_version" >= 1
            AND "active_previous_secret_version" < "active_current_secret_version"
          )
        )
      )
    ),
  ADD CONSTRAINT "webhook_deliveries_state_fields_check"
    CHECK (
      (
        "status" = 'pending'
        AND "delivered_at" IS NULL
        AND "dead_lettered_at" IS NULL
        AND (
          (
            "active_attempt_number" IS NULL
            AND "attempt_count" = 0
            AND "next_attempt_at" IS NOT NULL
          )
          OR (
            "active_attempt_number" = 1
            AND "attempt_count" = 1
            AND "next_attempt_at" IS NOT NULL
          )
        )
      )
      OR (
        "status" = 'retrying'
        AND "delivered_at" IS NULL
        AND "dead_lettered_at" IS NULL
        AND (
          (
            "active_attempt_number" IS NULL
            AND "attempt_count" BETWEEN 1 AND 6
            AND "next_attempt_at" IS NOT NULL
          )
          OR (
            "active_attempt_number" = "attempt_count"
            AND "attempt_count" BETWEEN 2 AND 7
            AND (
              ("attempt_count" < 7 AND "next_attempt_at" IS NOT NULL)
              OR ("attempt_count" = 7 AND "next_attempt_at" IS NULL)
            )
          )
        )
      )
      OR (
        "status" = 'delivered'
        AND "attempt_count" BETWEEN 1 AND 7
        AND "next_attempt_at" IS NULL
        AND "delivered_at" IS NOT NULL
        AND "dead_lettered_at" IS NULL
        AND "claim_token" IS NULL
        AND "active_attempt_number" IS NULL
      )
      OR (
        "status" = 'dead_lettered'
        AND "attempt_count" BETWEEN 1 AND 7
        AND "next_attempt_at" IS NULL
        AND "delivered_at" IS NULL
        AND "dead_lettered_at" IS NOT NULL
        AND "claim_token" IS NULL
        AND "active_attempt_number" IS NULL
      )
    );

CREATE TABLE "webhook_delivery_attempts" (
  "id" UUID NOT NULL,
  "delivery_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "outcome" "webhook_delivery_attempt_outcome" NOT NULL,
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "completed_at" TIMESTAMPTZ(6) NOT NULL,
  "duration_ms" INTEGER NOT NULL,
  "http_status" SMALLINT,
  "error_code" VARCHAR(64),
  "response_body_sha256" BYTEA,
  "response_body_truncated" BOOLEAN NOT NULL DEFAULT FALSE,
  "signature_version" VARCHAR(8),
  "signature_timestamp" BIGINT,
  "current_secret_version" INTEGER,
  "previous_secret_version" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_delivery_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_delivery_attempts_attempt_number_check"
    CHECK ("attempt_number" BETWEEN 1 AND 7),
  CONSTRAINT "webhook_delivery_attempts_completion_order_check"
    CHECK ("completed_at" >= "started_at"),
  CONSTRAINT "webhook_delivery_attempts_duration_ms_check"
    CHECK ("duration_ms" BETWEEN 0 AND 30000),
  CONSTRAINT "webhook_delivery_attempts_http_status_check"
    CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599),
  CONSTRAINT "webhook_delivery_attempts_error_code_check"
    CHECK ("error_code" IS NULL OR "error_code" ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT "webhook_delivery_attempts_response_sha256_check"
    CHECK (
      "response_body_sha256" IS NULL
      OR octet_length("response_body_sha256") = 32
    ),
  CONSTRAINT "webhook_delivery_attempts_response_evidence_check"
    CHECK (
      (
        "http_status" IS NULL
        AND "response_body_sha256" IS NULL
        AND "response_body_truncated" = FALSE
      )
      OR (
        "http_status" IS NOT NULL
        AND (
          ("response_body_truncated" = TRUE AND "response_body_sha256" IS NULL)
          OR ("response_body_truncated" = FALSE AND "response_body_sha256" IS NOT NULL)
        )
      )
    ),
  CONSTRAINT "webhook_delivery_attempts_signature_fields_check"
    CHECK (
      (
        "signature_version" IS NULL
        AND "signature_timestamp" IS NULL
        AND "current_secret_version" IS NULL
        AND "previous_secret_version" IS NULL
      )
      OR (
        "signature_version" = 'v1'
        AND "signature_timestamp" > 0
        AND "current_secret_version" >= 1
        AND (
          "previous_secret_version" IS NULL
          OR (
            "previous_secret_version" >= 1
            AND "previous_secret_version" < "current_secret_version"
          )
        )
      )
    ),
  CONSTRAINT "webhook_delivery_attempts_outcome_shape_check"
    CHECK (
      (
        "outcome" = 'delivered'
        AND "http_status" BETWEEN 200 AND 299
        AND "error_code" IS NULL
        AND "signature_version" = 'v1'
      )
      OR (
        "outcome" = 'retryable_failure'
        AND "error_code" IS NOT NULL
        AND (
          "http_status" IS NULL
          OR "http_status" IN (408, 429)
          OR "http_status" BETWEEN 500 AND 599
        )
        AND "signature_version" = 'v1'
      )
      OR (
        "outcome" = 'non_retryable_failure'
        AND "error_code" IS NOT NULL
        AND (
          "http_status" IS NULL
          OR "http_status" BETWEEN 300 AND 407
          OR "http_status" BETWEEN 409 AND 428
          OR "http_status" BETWEEN 430 AND 499
        )
        AND (
          "signature_version" = 'v1'
          OR (
            "error_code" = 'endpoint_inactive'
            AND "signature_version" IS NULL
          )
        )
      )
      OR (
        "outcome" = 'unknown'
        AND "http_status" IS NULL
        AND "error_code" = 'lease_expired_unknown'
        AND "signature_version" = 'v1'
      )
    ),
  CONSTRAINT "webhook_delivery_attempts_delivery_id_attempt_number_key"
    UNIQUE ("delivery_id", "attempt_number")
);

CREATE INDEX "webhook_deliveries_due_next_attempt_at_id_idx"
  ON "webhook_deliveries"("next_attempt_at", "id")
  WHERE "status" IN ('pending', 'retrying') AND "claim_token" IS NULL;

CREATE INDEX "webhook_deliveries_lease_expires_at_id_idx"
  ON "webhook_deliveries"("lease_expires_at", "id")
  WHERE "claim_token" IS NOT NULL;

CREATE INDEX "webhook_delivery_attempts_outcome_completed_at_id_idx"
  ON "webhook_delivery_attempts"("outcome", "completed_at", "id");

ALTER TABLE "webhook_delivery_attempts"
  ADD CONSTRAINT "webhook_delivery_attempts_delivery_id_fkey"
  FOREIGN KEY ("delivery_id") REFERENCES "webhook_deliveries"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "settleflow_reject_webhook_delivery_attempt_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'webhook delivery attempts are append-only'
    USING ERRCODE = '55000',
      CONSTRAINT = 'webhook_delivery_attempts_append_only_check';
END;
$$;

CREATE TRIGGER "webhook_delivery_attempts_reject_update_delete_trigger"
BEFORE UPDATE OR DELETE ON "webhook_delivery_attempts"
FOR EACH ROW EXECUTE FUNCTION "settleflow_reject_webhook_delivery_attempt_mutation"();

CREATE FUNCTION "settleflow_reject_webhook_delivery_attempt_truncate"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'webhook delivery attempts are append-only'
    USING ERRCODE = '55000',
      CONSTRAINT = 'webhook_delivery_attempts_append_only_check';
END;
$$;

CREATE TRIGGER "webhook_delivery_attempts_reject_truncate_trigger"
BEFORE TRUNCATE ON "webhook_delivery_attempts"
FOR EACH STATEMENT EXECUTE FUNCTION "settleflow_reject_webhook_delivery_attempt_truncate"();

REVOKE ALL PRIVILEGES ON TABLE "webhook_deliveries" FROM "settleflow_app";
REVOKE ALL PRIVILEGES ON TABLE "webhook_delivery_attempts" FROM "settleflow_app";

GRANT SELECT, INSERT, UPDATE ON TABLE "webhook_deliveries" TO "settleflow_app";
GRANT SELECT, INSERT ON TABLE "webhook_delivery_attempts" TO "settleflow_app";

REVOKE DELETE, TRUNCATE ON TABLE "webhook_deliveries" FROM "settleflow_app";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "webhook_delivery_attempts" FROM "settleflow_app";
