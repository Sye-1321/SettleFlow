import { randomUUID } from 'node:crypto';
import {
  isTransientTransactionError,
  PrismaDatabase,
  type PrismaTransactionClient,
} from '@settleflow/infrastructure';

import type {
  ClaimedWebhookDelivery,
  StartWebhookDeliveryAttemptResult,
  StoredWebhookSecret,
  WebhookDeliveryAttemptEvidence,
  WebhookDeliveryContext,
  WebhookDeliveryFinalizationResult,
  WebhookDeliveryRecoveryResult,
  WebhookDeliveryRepository,
} from './webhook-delivery.types';

interface ClaimRow {
  readonly attemptCount: number;
  readonly claimToken: string;
  readonly deliveryId: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly merchantId: string;
  readonly publicId: string;
}

interface LockedDeliveryRow {
  readonly activeAttemptNumber: number | null;
  readonly activeAttemptStartedAt: Date | null;
  readonly activeCurrentSecretVersion: number | null;
  readonly activePreviousSecretVersion: number | null;
  readonly activeSignatureTimestamp: bigint | null;
  readonly attemptCount: number;
  readonly endpointStatus: string;
  readonly leaseExpiresAt: Date;
  readonly selectedCurrentSecretVersion: number | null;
  readonly selectedPreviousSecretVersion: number | null;
  readonly status: string;
}

interface RecoveryRow {
  readonly activeAttemptNumber: number | null;
  readonly activeAttemptStartedAt: Date | null;
  readonly activeCurrentSecretVersion: number | null;
  readonly activePreviousSecretVersion: number | null;
  readonly activeSignatureTimestamp: bigint | null;
  readonly attemptCount: number;
  readonly deliveryId: string;
  readonly leaseExpiresAt: Date;
  readonly recoveredAt: Date;
}

interface ReadinessRow {
  readonly ready: boolean;
}

export interface PrismaWebhookDeliveryRepositoryOptions {
  readonly leaseDurationMs?: number;
  readonly retryAttempts?: number;
  readonly transactionTimeoutMs: number;
}

function toSecret(value: {
  readonly algorithm: string;
  readonly authenticationTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly encryptionKeyId: string;
  readonly lifecycle: string;
  readonly nonce: Uint8Array;
  readonly overlapExpiresAt: Date | null;
  readonly secretVersion: number;
}): StoredWebhookSecret {
  if (
    value.algorithm !== 'aes-256-gcm' ||
    (value.lifecycle !== 'CURRENT' && value.lifecycle !== 'PREVIOUS')
  ) {
    throw new Error('Persisted webhook signing material is invalid');
  }
  return {
    algorithm: 'aes-256-gcm',
    authenticationTag: Uint8Array.from(value.authenticationTag),
    ciphertext: Uint8Array.from(value.ciphertext),
    encryptionKeyId: value.encryptionKeyId,
    lifecycle: value.lifecycle === 'CURRENT' ? 'current' : 'previous',
    nonce: Uint8Array.from(value.nonce),
    overlapExpiresAt: value.overlapExpiresAt ?? undefined,
    secretVersion: value.secretVersion,
  };
}

function toAttemptOutcome(
  value: WebhookDeliveryAttemptEvidence['outcome'],
): 'DELIVERED' | 'NON_RETRYABLE_FAILURE' | 'RETRYABLE_FAILURE' {
  if (value === 'delivered') return 'DELIVERED';
  if (value === 'retryable_failure') return 'RETRYABLE_FAILURE';
  return 'NON_RETRYABLE_FAILURE';
}

function toDeliveryStatus(
  value: WebhookDeliveryFinalizationResult['status'],
): 'DEAD_LETTERED' | 'DELIVERED' | 'RETRYING' {
  if (value === 'delivered') return 'DELIVERED';
  if (value === 'retrying') return 'RETRYING';
  return 'DEAD_LETTERED';
}

export class PrismaWebhookDeliveryRepository implements WebhookDeliveryRepository {
  private readonly leaseDurationMs: number;
  private readonly retryAttempts: number;

  public constructor(
    private readonly database: PrismaDatabase,
    private readonly options: PrismaWebhookDeliveryRepositoryOptions,
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.retryAttempts = options.retryAttempts ?? 3;
    if (this.leaseDurationMs !== 30_000 || this.retryAttempts !== 3) {
      throw new Error('Webhook delivery persistence bounds must match ADR-0019');
    }
  }

  public async checkReadiness(): Promise<boolean> {
    try {
      const rows = await this.database.getClient().$queryRaw<ReadinessRow[]>`
        SELECT (
          to_regclass('public.webhook_deliveries') IS NOT NULL
          AND to_regclass('public.webhook_delivery_attempts') IS NOT NULL
          AND has_table_privilege(current_user, 'webhook_deliveries', 'SELECT,INSERT,UPDATE')
          AND has_table_privilege(current_user, 'webhook_delivery_attempts', 'SELECT,INSERT')
          AND NOT has_table_privilege(current_user, 'webhook_delivery_attempts', 'UPDATE')
          AND NOT has_table_privilege(current_user, 'webhook_delivery_attempts', 'DELETE')
          AND NOT has_table_privilege(current_user, 'webhook_delivery_attempts', 'TRUNCATE')
        ) AS "ready"
      `;
      return rows[0]?.ready === true;
    } catch {
      return false;
    }
  }

  public async claimDue(
    workerId: string,
    batchSize: number,
  ): Promise<readonly ClaimedWebhookDelivery[]> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(workerId) || batchSize < 1 || batchSize > 4) {
      throw new Error('Webhook delivery claim input is invalid');
    }
    return this.withTransaction(async (transaction) => {
      const rows = await transaction.$queryRaw<ClaimRow[]>`
        WITH delivery_clock AS MATERIALIZED (
          SELECT clock_timestamp() AS now_at
        ),
        candidates AS (
          SELECT delivery."id"
          FROM "webhook_deliveries" AS delivery
          CROSS JOIN delivery_clock
          WHERE delivery."status" IN ('pending', 'retrying')
            AND delivery."next_attempt_at" <= delivery_clock.now_at
            AND delivery."claim_token" IS NULL
          ORDER BY delivery."next_attempt_at", delivery."id"
          FOR UPDATE OF delivery SKIP LOCKED
          LIMIT ${batchSize}
        )
        UPDATE "webhook_deliveries" AS delivery
        SET
          "locked_by" = ${workerId},
          "claim_token" = gen_random_uuid(),
          "locked_at" = delivery_clock.now_at,
          "lease_expires_at" = delivery_clock.now_at
            + (${this.leaseDurationMs} * INTERVAL '1 millisecond'),
          "updated_at" = delivery_clock.now_at
        FROM candidates
        CROSS JOIN delivery_clock
        WHERE delivery."id" = candidates."id"
        RETURNING
          delivery."id" AS "deliveryId",
          delivery."public_id" AS "publicId",
          delivery."merchant_id" AS "merchantId",
          delivery."endpoint_id" AS "endpointId",
          delivery."event_id" AS "eventId",
          delivery."attempt_count" AS "attemptCount",
          delivery."claim_token" AS "claimToken"
      `;
      return rows;
    });
  }

  public async loadContext(
    claim: ClaimedWebhookDelivery,
  ): Promise<WebhookDeliveryContext | undefined> {
    try {
      const record = await this.database.getClient().webhookDelivery.findFirst({
        select: {
          endpoint: {
            select: {
              normalizedUrl: true,
              secrets: {
                orderBy: { secretVersion: 'desc' },
                select: {
                  algorithm: true,
                  authenticationTag: true,
                  ciphertext: true,
                  encryptionKeyId: true,
                  lifecycle: true,
                  nonce: true,
                  overlapExpiresAt: true,
                  secretVersion: true,
                },
                where: { lifecycle: { in: ['CURRENT', 'PREVIOUS'] } },
              },
              status: true,
            },
          },
          event: {
            select: { eventType: true, payloadBytes: true, schemaVersion: true },
          },
        },
        where: { claimToken: claim.claimToken, id: claim.deliveryId },
      });
      if (record === null) return undefined;
      if (record.event.eventType !== 'payment.created.v1' || record.event.schemaVersion !== 1) {
        throw new Error('Persisted webhook event contract is invalid');
      }
      const current = record.endpoint.secrets.find((secret) => secret.lifecycle === 'CURRENT');
      if (current === undefined) throw new Error('Webhook endpoint has no current signing secret');
      const previous = record.endpoint.secrets.find((secret) => secret.lifecycle === 'PREVIOUS');
      return {
        body: Uint8Array.from(record.event.payloadBytes),
        claim,
        currentSecret: toSecret(current),
        endpointStatus: record.endpoint.status === 'ACTIVE' ? 'active' : 'inactive',
        eventType: 'payment.created.v1',
        normalizedUrl: record.endpoint.normalizedUrl,
        previousSecret: previous === undefined ? undefined : toSecret(previous),
        schemaVersion: 1,
      };
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async startAttempt(
    context: WebhookDeliveryContext,
    retryDelayMs: number | undefined,
  ): Promise<StartWebhookDeliveryAttemptResult> {
    const expectedAttempt = context.claim.attemptCount + 1;
    if (
      expectedAttempt < 1 ||
      expectedAttempt > 7 ||
      (expectedAttempt < 7 && retryDelayMs === undefined) ||
      (expectedAttempt === 7 && retryDelayMs !== undefined)
    ) {
      throw new Error('Webhook attempt start input is invalid');
    }

    return this.withTransaction(async (transaction) => {
      const rows = await transaction.$queryRaw<LockedDeliveryRow[]>`
        WITH delivery_clock AS MATERIALIZED (
          SELECT clock_timestamp() AS now_at
        )
        SELECT
          delivery."attempt_count" AS "attemptCount",
          delivery."status"::text AS "status",
          delivery."lease_expires_at" AS "leaseExpiresAt",
          delivery."active_attempt_number" AS "activeAttemptNumber",
          delivery."active_attempt_started_at" AS "activeAttemptStartedAt",
          delivery."active_signature_timestamp" AS "activeSignatureTimestamp",
          delivery."active_current_secret_version" AS "activeCurrentSecretVersion",
          delivery."active_previous_secret_version" AS "activePreviousSecretVersion",
          endpoint."status"::text AS "endpointStatus",
          (
            SELECT secret."secret_version"
            FROM "webhook_endpoint_secrets" AS secret
            WHERE secret."endpoint_id" = delivery."endpoint_id"
              AND secret."lifecycle" = 'current'
          ) AS "selectedCurrentSecretVersion",
          (
            SELECT secret."secret_version"
            FROM "webhook_endpoint_secrets" AS secret
            CROSS JOIN delivery_clock
            WHERE secret."endpoint_id" = delivery."endpoint_id"
              AND secret."lifecycle" = 'previous'
              AND secret."overlap_expires_at" > delivery_clock.now_at
          ) AS "selectedPreviousSecretVersion"
        FROM "webhook_deliveries" AS delivery
        JOIN "webhook_endpoints" AS endpoint ON endpoint."id" = delivery."endpoint_id"
        CROSS JOIN delivery_clock
        WHERE delivery."id" = ${context.claim.deliveryId}::uuid
          AND delivery."claim_token" = ${context.claim.claimToken}::uuid
          AND delivery."lease_expires_at" > delivery_clock.now_at
          AND delivery."status" IN ('pending', 'retrying')
          AND delivery."active_attempt_number" IS NULL
        FOR UPDATE OF delivery
      `;
      const row = rows[0];
      if (row?.attemptCount !== context.claim.attemptCount) {
        return { kind: 'ownership_lost' };
      }
      if (row.endpointStatus === 'inactive') {
        await this.persistInactiveAttempt(transaction, context.claim, expectedAttempt);
        return { attemptNumber: expectedAttempt, kind: 'inactive' };
      }
      if (context.endpointStatus === 'inactive') {
        await this.clearClaim(transaction, context.claim);
        return { kind: 'ownership_lost' };
      }
      const selectedPrevious = row.selectedPreviousSecretVersion ?? undefined;
      if (
        row.selectedCurrentSecretVersion !== context.currentSecret.secretVersion ||
        (selectedPrevious !== undefined &&
          selectedPrevious !== context.previousSecret?.secretVersion)
      ) {
        await this.clearClaim(transaction, context.claim);
        return { kind: 'ownership_lost' };
      }

      const started = await transaction.$queryRaw<
        {
          readonly attemptNumber: number;
          readonly currentSecretVersion: number;
          readonly nextAttemptAt: Date | null;
          readonly previousSecretVersion: number | null;
          readonly signatureTimestamp: bigint;
          readonly startedAt: Date;
        }[]
      >`
        WITH delivery_clock AS MATERIALIZED (
          SELECT clock_timestamp() AS now_at
        )
        UPDATE "webhook_deliveries" AS delivery
        SET
          "attempt_count" = ${expectedAttempt},
          "active_attempt_number" = ${expectedAttempt},
          "active_attempt_started_at" = delivery_clock.now_at,
          "active_signature_timestamp" = floor(extract(epoch FROM delivery_clock.now_at))::bigint,
          "active_current_secret_version" = ${context.currentSecret.secretVersion},
          "active_previous_secret_version" = ${selectedPrevious ?? null},
          "next_attempt_at" = CASE
            WHEN ${retryDelayMs ?? null}::integer IS NULL THEN NULL
            ELSE delivery_clock.now_at + (${retryDelayMs ?? 0} * INTERVAL '1 millisecond')
          END,
          "updated_at" = delivery_clock.now_at
        FROM delivery_clock
        WHERE delivery."id" = ${context.claim.deliveryId}::uuid
          AND delivery."claim_token" = ${context.claim.claimToken}::uuid
          AND delivery."lease_expires_at" > delivery_clock.now_at
        RETURNING
          delivery."attempt_count" AS "attemptNumber",
          delivery."active_attempt_started_at" AS "startedAt",
          delivery."active_signature_timestamp" AS "signatureTimestamp",
          delivery."active_current_secret_version" AS "currentSecretVersion",
          delivery."active_previous_secret_version" AS "previousSecretVersion",
          delivery."next_attempt_at" AS "nextAttemptAt"
      `;
      const attempt = started[0];
      if (attempt === undefined) return { kind: 'ownership_lost' };
      return {
        attempt: {
          attemptNumber: attempt.attemptNumber,
          currentSecretVersion: attempt.currentSecretVersion,
          nextAttemptAt: attempt.nextAttemptAt ?? undefined,
          previousSecretVersion: attempt.previousSecretVersion ?? undefined,
          signatureTimestamp: attempt.signatureTimestamp,
          startedAt: attempt.startedAt,
        },
        kind: 'started',
      };
    });
  }

  public async finalizeAttempt(
    claim: ClaimedWebhookDelivery,
    attempt: {
      readonly attemptNumber: number;
      readonly currentSecretVersion: number;
      readonly nextAttemptAt: Date | undefined;
      readonly previousSecretVersion: number | undefined;
      readonly signatureTimestamp: bigint;
      readonly startedAt: Date;
    },
    evidence: WebhookDeliveryAttemptEvidence,
  ): Promise<WebhookDeliveryFinalizationResult> {
    return this.withTransaction(async (transaction) => {
      const rows = await transaction.$queryRaw<LockedDeliveryRow[]>`
        WITH delivery_clock AS MATERIALIZED (SELECT clock_timestamp() AS now_at)
        SELECT
          delivery."attempt_count" AS "attemptCount",
          delivery."status"::text AS "status",
          delivery."lease_expires_at" AS "leaseExpiresAt",
          delivery."active_attempt_number" AS "activeAttemptNumber",
          delivery."active_attempt_started_at" AS "activeAttemptStartedAt",
          delivery."active_signature_timestamp" AS "activeSignatureTimestamp",
          delivery."active_current_secret_version" AS "activeCurrentSecretVersion",
          delivery."active_previous_secret_version" AS "activePreviousSecretVersion",
          '' AS "endpointStatus",
          NULL::integer AS "selectedCurrentSecretVersion",
          NULL::integer AS "selectedPreviousSecretVersion"
        FROM "webhook_deliveries" AS delivery
        CROSS JOIN delivery_clock
        WHERE delivery."id" = ${claim.deliveryId}::uuid
          AND delivery."claim_token" = ${claim.claimToken}::uuid
          AND delivery."active_attempt_number" = ${attempt.attemptNumber}
          AND delivery."lease_expires_at" > delivery_clock.now_at
        FOR UPDATE OF delivery
      `;
      const row = rows[0];
      if (
        row?.activeAttemptStartedAt === null ||
        row?.activeAttemptStartedAt === undefined ||
        row.activeSignatureTimestamp === null ||
        row.activeCurrentSecretVersion === null ||
        row.attemptCount !== attempt.attemptNumber ||
        row.activeAttemptStartedAt.getTime() !== attempt.startedAt.getTime() ||
        row.activeSignatureTimestamp !== attempt.signatureTimestamp ||
        row.activeCurrentSecretVersion !== attempt.currentSecretVersion ||
        (row.activePreviousSecretVersion ?? undefined) !== attempt.previousSecretVersion
      ) {
        return { status: 'dead_lettered', updated: false };
      }
      const clock = await transaction.$queryRaw<{ readonly nowAt: Date }[]>`
        SELECT clock_timestamp() AS "nowAt"
      `;
      const completedAt = clock[0]?.nowAt;
      if (completedAt === undefined) throw new Error('Database clock is unavailable');
      const durationMs = Math.min(
        30_000,
        Math.max(0, completedAt.getTime() - row.activeAttemptStartedAt.getTime()),
      );
      const status: WebhookDeliveryFinalizationResult['status'] =
        evidence.outcome === 'delivered'
          ? 'delivered'
          : evidence.outcome === 'retryable_failure' && attempt.attemptNumber < 7
            ? 'retrying'
            : 'dead_lettered';
      if (status === 'retrying' && attempt.nextAttemptAt === undefined) {
        throw new Error('Retrying webhook delivery has no next attempt time');
      }

      await transaction.webhookDeliveryAttempt.create({
        data: {
          attemptNumber: attempt.attemptNumber,
          completedAt,
          createdAt: completedAt,
          currentSecretVersion: row.activeCurrentSecretVersion,
          deliveryId: claim.deliveryId,
          durationMs,
          errorCode: evidence.errorCode ?? null,
          httpStatus: evidence.httpStatus ?? null,
          id: randomUUID(),
          outcome: toAttemptOutcome(evidence.outcome),
          previousSecretVersion: row.activePreviousSecretVersion,
          responseBodySha256:
            evidence.responseBodySha256 === undefined
              ? null
              : Uint8Array.from(evidence.responseBodySha256),
          responseBodyTruncated: evidence.responseBodyTruncated,
          signatureTimestamp: row.activeSignatureTimestamp,
          signatureVersion: 'v1',
          startedAt: row.activeAttemptStartedAt,
        },
        select: { id: true },
      });
      await transaction.webhookDelivery.update({
        data: {
          activeAttemptNumber: null,
          activeAttemptStartedAt: null,
          activeCurrentSecretVersion: null,
          activePreviousSecretVersion: null,
          activeSignatureTimestamp: null,
          claimToken: null,
          deadLetteredAt: status === 'dead_lettered' ? completedAt : null,
          deliveredAt: status === 'delivered' ? completedAt : null,
          leaseExpiresAt: null,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: status === 'retrying' ? (attempt.nextAttemptAt ?? null) : null,
          status: toDeliveryStatus(status),
          updatedAt: completedAt,
        },
        select: { id: true },
        where: { id: claim.deliveryId },
      });
      return { status, updated: true };
    });
  }

  public async releaseUnstarted(claim: ClaimedWebhookDelivery): Promise<boolean> {
    return this.withTransaction(async (transaction) => this.clearClaim(transaction, claim));
  }

  public async recoverExpired(limit: number): Promise<WebhookDeliveryRecoveryResult> {
    if (limit < 1 || limit > 4) throw new Error('Webhook recovery limit is invalid');
    return this.withTransaction(async (transaction) => {
      const rows = await transaction.$queryRaw<RecoveryRow[]>`
        WITH delivery_clock AS MATERIALIZED (SELECT clock_timestamp() AS now_at)
        SELECT
          delivery."id" AS "deliveryId",
          delivery."attempt_count" AS "attemptCount",
          delivery."lease_expires_at" AS "leaseExpiresAt",
          delivery."active_attempt_number" AS "activeAttemptNumber",
          delivery."active_attempt_started_at" AS "activeAttemptStartedAt",
          delivery."active_signature_timestamp" AS "activeSignatureTimestamp",
          delivery."active_current_secret_version" AS "activeCurrentSecretVersion",
          delivery."active_previous_secret_version" AS "activePreviousSecretVersion",
          delivery_clock.now_at AS "recoveredAt"
        FROM "webhook_deliveries" AS delivery
        CROSS JOIN delivery_clock
        WHERE delivery."claim_token" IS NOT NULL
          AND delivery."lease_expires_at" <= delivery_clock.now_at
        ORDER BY delivery."lease_expires_at", delivery."id"
        FOR UPDATE OF delivery SKIP LOCKED
        LIMIT ${limit}
      `;
      let clearedUnstarted = 0;
      let deadLettered = 0;
      let recoveredUnknown = 0;
      for (const row of rows) {
        if (row.activeAttemptNumber === null) {
          await this.clearClaimById(transaction, row.deliveryId);
          clearedUnstarted += 1;
          continue;
        }
        if (
          row.activeAttemptStartedAt === null ||
          row.activeSignatureTimestamp === null ||
          row.activeCurrentSecretVersion === null
        ) {
          throw new Error('Persisted active webhook attempt is incomplete');
        }
        const completedAt =
          row.leaseExpiresAt < row.activeAttemptStartedAt
            ? row.activeAttemptStartedAt
            : row.leaseExpiresAt;
        const durationMs = Math.min(
          30_000,
          Math.max(0, completedAt.getTime() - row.activeAttemptStartedAt.getTime()),
        );
        await transaction.webhookDeliveryAttempt.create({
          data: {
            attemptNumber: row.activeAttemptNumber,
            completedAt,
            createdAt: row.recoveredAt,
            currentSecretVersion: row.activeCurrentSecretVersion,
            deliveryId: row.deliveryId,
            durationMs,
            errorCode: 'lease_expired_unknown',
            id: randomUUID(),
            outcome: 'UNKNOWN',
            previousSecretVersion: row.activePreviousSecretVersion,
            responseBodyTruncated: false,
            signatureTimestamp: row.activeSignatureTimestamp,
            signatureVersion: 'v1',
            startedAt: row.activeAttemptStartedAt,
          },
          select: { id: true },
        });
        const terminal = row.activeAttemptNumber >= 7;
        await transaction.webhookDelivery.update({
          data: {
            activeAttemptNumber: null,
            activeAttemptStartedAt: null,
            activeCurrentSecretVersion: null,
            activePreviousSecretVersion: null,
            activeSignatureTimestamp: null,
            claimToken: null,
            deadLetteredAt: terminal ? completedAt : null,
            leaseExpiresAt: null,
            lockedAt: null,
            lockedBy: null,
            ...(terminal ? { nextAttemptAt: null } : {}),
            status: terminal ? 'DEAD_LETTERED' : 'RETRYING',
            updatedAt: completedAt,
          },
          select: { id: true },
          where: { id: row.deliveryId },
        });
        recoveredUnknown += 1;
        if (terminal) deadLettered += 1;
      }
      return { clearedUnstarted, deadLettered, recoveredUnknown };
    });
  }

  private async persistInactiveAttempt(
    transaction: PrismaTransactionClient,
    claim: ClaimedWebhookDelivery,
    attemptNumber: number,
  ): Promise<void> {
    const clock = await transaction.$queryRaw<{ readonly nowAt: Date }[]>`
      SELECT clock_timestamp() AS "nowAt"
    `;
    const now = clock[0]?.nowAt;
    if (now === undefined) throw new Error('Database clock is unavailable');
    await transaction.webhookDeliveryAttempt.create({
      data: {
        attemptNumber,
        completedAt: now,
        createdAt: now,
        deliveryId: claim.deliveryId,
        durationMs: 0,
        errorCode: 'endpoint_inactive',
        id: randomUUID(),
        outcome: 'NON_RETRYABLE_FAILURE',
        responseBodyTruncated: false,
        startedAt: now,
      },
      select: { id: true },
    });
    await transaction.webhookDelivery.update({
      data: {
        attemptCount: attemptNumber,
        claimToken: null,
        deadLetteredAt: now,
        leaseExpiresAt: null,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
        status: 'DEAD_LETTERED',
        updatedAt: now,
      },
      select: { id: true },
      where: { id: claim.deliveryId },
    });
  }

  private async clearClaim(
    transaction: PrismaTransactionClient,
    claim: ClaimedWebhookDelivery,
  ): Promise<boolean> {
    const updated = await transaction.$executeRaw`
      UPDATE "webhook_deliveries"
      SET
        "locked_by" = NULL,
        "claim_token" = NULL,
        "locked_at" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = clock_timestamp()
      WHERE "id" = ${claim.deliveryId}::uuid
        AND "claim_token" = ${claim.claimToken}::uuid
        AND "active_attempt_number" IS NULL
    `;
    return updated === 1;
  }

  private async clearClaimById(
    transaction: PrismaTransactionClient,
    deliveryId: string,
  ): Promise<void> {
    await transaction.$executeRaw`
      UPDATE "webhook_deliveries"
      SET
        "locked_by" = NULL,
        "claim_token" = NULL,
        "locked_at" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = clock_timestamp()
      WHERE "id" = ${deliveryId}::uuid
        AND "active_attempt_number" IS NULL
    `;
  }

  private async withTransaction<T>(
    operation: (transaction: PrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        return await this.database.getClient().$transaction(
          async (transaction) => {
            await transaction.$queryRaw`SELECT set_config('lock_timeout', ${`${this.options.transactionTimeoutMs}ms`}, true)`;
            await transaction.$queryRaw`SELECT set_config('statement_timeout', ${`${this.options.transactionTimeoutMs}ms`}, true)`;
            return operation(transaction);
          },
          {
            maxWait: this.options.transactionTimeoutMs,
            timeout: this.options.transactionTimeoutMs + 1_000,
          },
        );
      } catch (error: unknown) {
        lastError = error;
        if (!isTransientTransactionError(error) || attempt === this.retryAttempts) break;
      }
    }
    return this.database.rethrowDatabaseError(lastError);
  }
}

export const prismaWebhookDeliveryRepositoryInternals = {
  toAttemptOutcome,
  toDeliveryStatus,
  toSecret,
};
