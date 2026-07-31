-- CreateEnum
CREATE TYPE "merchant_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "api_key_status" AS ENUM ('active', 'disabled', 'revoked');

-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "status" "merchant_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "merchants_code_nonempty_check" CHECK (char_length(btrim("code")) > 0)
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "prefix" VARCHAR(32) NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "status" "api_key_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "rotated_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "api_keys_prefix_format_check" CHECK ("prefix" ~ '^sf_test_[A-Za-z0-9_-]{12}$'),
    CONSTRAINT "api_keys_secret_hash_format_check" CHECK ("secret_hash" ~ '^scrypt:v1:16384:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$'),
    CONSTRAINT "api_keys_scopes_nonempty_check" CHECK (cardinality("scopes") > 0),
    CONSTRAINT "api_keys_scopes_allowlist_check" CHECK (
        "scopes" <@ ARRAY[
            'payments:write',
            'payments:read',
            'ledger:read',
            'webhooks:manage',
            'webhooks:read',
            'settlements:write',
            'settlements:read',
            'reconciliation:write',
            'reconciliation:read'
        ]::TEXT[]
    ),
    CONSTRAINT "api_keys_revocation_state_check" CHECK (
        ("status" = 'revoked') = ("revoked_at" IS NOT NULL)
    ),
    CONSTRAINT "api_keys_rotation_state_check" CHECK (
        "rotated_at" IS NULL OR
        ("status" = 'revoked' AND "revoked_at" = "rotated_at")
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_code_key" ON "merchants"("code");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "api_keys_merchant_id_status_idx" ON "api_keys"("merchant_id", "status");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
