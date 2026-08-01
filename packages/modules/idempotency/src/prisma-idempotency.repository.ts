import { timingSafeEqual } from 'node:crypto';

import {
  isTransientTransactionError,
  PrismaDatabase,
  type PrismaTransactionClient,
} from '@settleflow/infrastructure';

import {
  IdempotencyKeyExpiredError,
  IdempotencyKeyReusedError,
  IdempotencyOwnershipLostError,
  IdempotencyRequestInProgressError,
} from './idempotency.errors';
import type { IdempotencyRepository } from './idempotency.repository';
import type {
  HashedIdempotencyAcquireCommand,
  IdempotencyAcquireResult,
  IdempotencyOwnership,
  IdempotentOperation,
  StoredHttpResponse,
} from './idempotency.types';

const MAX_TRANSACTION_ATTEMPTS = 3;

export interface PrismaIdempotencyRepositoryOptions {
  readonly leaseDurationMs: number;
  readonly lockTimeoutMs: number;
  readonly replayDurationMs: number;
  readonly statementTimeoutMs: number;
}

interface PersistedIdempotencyRow {
  readonly id: string;
  readonly lease_expires_at: Date | null;
  readonly owner_token: string | null;
  readonly request_hash: Uint8Array;
  readonly response_body: unknown;
  readonly response_content_type: string | null;
  readonly response_expires_at: Date | null;
  readonly response_headers: unknown;
  readonly response_status: number | null;
  readonly result_reference: string | null;
  readonly state: 'completed' | 'in_progress';
}

function equalDigest(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.some((entry) => typeof entry[1] !== 'string')) {
    return undefined;
  }

  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function toStoredResponse(row: PersistedIdempotencyRow): StoredHttpResponse | undefined {
  const headers = toHeaders(row.response_headers);
  if (
    row.response_status === null ||
    (row.response_content_type !== 'application/json' &&
      row.response_content_type !== 'application/problem+json') ||
    headers === undefined ||
    !isJsonObject(row.response_body)
  ) {
    return undefined;
  }

  return {
    body: row.response_body,
    contentType: row.response_content_type,
    headers,
    ...(row.result_reference === null ? {} : { resultReference: row.result_reference }),
    status: row.response_status,
  };
}

export class PrismaIdempotencyRepository implements IdempotencyRepository {
  public constructor(
    private readonly database: PrismaDatabase,
    private readonly options: PrismaIdempotencyRepositoryOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async acquire(
    command: HashedIdempotencyAcquireCommand,
  ): Promise<IdempotencyAcquireResult> {
    const leaseExpiresAt = new Date(command.now.getTime() + this.options.leaseDurationMs);

    try {
      return await this.database.getClient().$transaction(
        async (transaction) => {
          await this.setTransactionTimeouts(transaction);
          const rows = await transaction.$queryRaw<PersistedIdempotencyRow[]>`
          INSERT INTO "idempotency_keys" (
            "id",
            "merchant_id",
            "http_method",
            "normalized_route",
            "key_hash",
            "request_hash",
            "state",
            "owner_token",
            "lease_expires_at",
            "created_at",
            "updated_at"
          )
          VALUES (
            ${command.recordId}::uuid,
            ${command.merchantId}::uuid,
            ${command.method},
            ${command.normalizedRoute},
            ${command.keyHash},
            ${command.requestHash},
            'in_progress',
            ${command.ownerToken}::uuid,
            ${leaseExpiresAt},
            ${command.now},
            ${command.now}
          )
          ON CONFLICT ("merchant_id", "http_method", "normalized_route", "key_hash")
          DO UPDATE SET "updated_at" = "idempotency_keys"."updated_at"
          RETURNING
            "id",
            "lease_expires_at",
            "owner_token",
            "request_hash",
            "response_body",
            "response_content_type",
            "response_expires_at",
            "response_headers",
            "response_status",
            "result_reference",
            "state"
        `;
          const row = rows[0];
          if (row === undefined) {
            throw new Error('Idempotency acquisition returned no row');
          }

          if (!equalDigest(row.request_hash, command.requestHash)) {
            throw new IdempotencyKeyReusedError();
          }

          if (row.state === 'completed') {
            const response = toStoredResponse(row);
            if (
              response === undefined ||
              row.response_expires_at === null ||
              row.response_expires_at.getTime() <= command.now.getTime()
            ) {
              throw new IdempotencyKeyExpiredError();
            }

            return { kind: 'replay', response };
          }

          if (row.owner_token === command.ownerToken) {
            return {
              kind: 'acquired',
              ownership: { ownerToken: command.ownerToken, recordId: row.id },
            };
          }

          if (
            row.lease_expires_at !== null &&
            row.lease_expires_at.getTime() > command.now.getTime()
          ) {
            throw new IdempotencyRequestInProgressError();
          }

          const takeover = await transaction.$queryRaw<{ readonly id: string }[]>`
          UPDATE "idempotency_keys"
          SET
            "owner_token" = ${command.ownerToken}::uuid,
            "lease_expires_at" = ${leaseExpiresAt},
            "updated_at" = ${command.now}
          WHERE "id" = ${row.id}::uuid
            AND "state" = 'in_progress'
            AND "lease_expires_at" <= ${command.now}
          RETURNING "id"
        `;
          if (takeover[0] === undefined) {
            throw new IdempotencyRequestInProgressError();
          }

          return {
            kind: 'acquired',
            ownership: { ownerToken: command.ownerToken, recordId: row.id },
          };
        },
        {
          maxWait: this.options.lockTimeoutMs,
          timeout: this.options.statementTimeoutMs,
        },
      );
    } catch (error: unknown) {
      if (
        error instanceof IdempotencyKeyExpiredError ||
        error instanceof IdempotencyKeyReusedError ||
        error instanceof IdempotencyRequestInProgressError
      ) {
        throw error;
      }
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async complete<T>(
    ownership: IdempotencyOwnership,
    operation: IdempotentOperation<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.getClient().$transaction(
          async (transaction) => {
            await this.setTransactionTimeouts(transaction);
            const locked = await transaction.$queryRaw<{ readonly id: string }[]>`
              SELECT "id"
              FROM "idempotency_keys"
              WHERE "id" = ${ownership.recordId}::uuid
                AND "owner_token" = ${ownership.ownerToken}::uuid
                AND "state" = 'in_progress'
              FOR UPDATE
            `;
            if (locked[0] === undefined) {
              throw new IdempotencyOwnershipLostError();
            }

            const result = await operation(transaction);
            const completedAt = this.clock();
            const responseExpiresAt = new Date(
              completedAt.getTime() + this.options.replayDurationMs,
            );
            const responseHeaders = JSON.stringify(result.response.headers);
            const responseBody = JSON.stringify(result.response.body);
            const updated = await transaction.$executeRaw`
              UPDATE "idempotency_keys"
              SET
                "state" = 'completed',
                "owner_token" = NULL,
                "lease_expires_at" = NULL,
                "response_status" = ${result.response.status},
                "response_content_type" = ${result.response.contentType},
                "response_headers" = ${responseHeaders}::jsonb,
                "response_body" = ${responseBody}::jsonb,
                "result_reference" = ${result.response.resultReference ?? null},
                "completed_at" = ${completedAt},
                "response_expires_at" = ${responseExpiresAt},
                "updated_at" = ${completedAt}
              WHERE "id" = ${ownership.recordId}::uuid
                AND "owner_token" = ${ownership.ownerToken}::uuid
                AND "state" = 'in_progress'
            `;
            if (updated !== 1) {
              throw new IdempotencyOwnershipLostError();
            }

            return result.value;
          },
          {
            maxWait: this.options.lockTimeoutMs,
            timeout: this.options.statementTimeoutMs,
          },
        );
      } catch (error: unknown) {
        if (isTransientTransactionError(error) && attempt < MAX_TRANSACTION_ATTEMPTS) {
          continue;
        }
        if (error instanceof IdempotencyOwnershipLostError) {
          throw error;
        }
        return this.database.rethrowDatabaseError(error);
      }
    }

    throw new Error('Idempotency transaction retry exhausted');
  }

  private async setTransactionTimeouts(transaction: PrismaTransactionClient): Promise<void> {
    const lockTimeout = `${this.options.lockTimeoutMs}ms`;
    const statementTimeout = `${this.options.statementTimeoutMs}ms`;
    await transaction.$queryRaw`
      SELECT
        set_config('lock_timeout', ${lockTimeout}, true),
        set_config('statement_timeout', ${statementTimeout}, true)
    `;
  }
}
