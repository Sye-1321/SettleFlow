import { createHash } from 'node:crypto';

import { PrismaDatabase, type PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  InvalidSettlementRequestError,
  SettlementFeePolicyInvalidError,
} from './settlement.errors';

import type {
  PendingSettlementAdjustment,
  PersistSettlementInput,
  SettlementBatchRepresentation,
  SettlementCurrency,
  SettlementDerivedStatus,
  SettlementFeePolicy,
  SettlementPositionCandidate,
  ResolvedSettlementProjectionEvent,
  SettlementRepository,
  SettlementRunRepresentation,
} from './settlement.types';

interface CandidateRow {
  readonly available_at: Date;
  readonly captured_amount_minor: bigint;
  readonly currency: SettlementCurrency;
  readonly id: string;
  readonly payment_intent_id: string;
  readonly payment_public_id: string;
  readonly refunded_amount_minor: bigint;
}

interface AdjustmentRow {
  readonly amount_minor: bigint;
  readonly id: string;
}

export interface SettlementBacklogRow {
  readonly currency: SettlementCurrency;
  readonly pending: number;
}

function number(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Settlement aggregate exceeds JSON range');
  return result;
}

function pageToken(batchPublicId: string, kind: 'adjustment' | 'item', internalId: string): string {
  return createHash('sha256')
    .update(`${batchPublicId}\0${kind}\0${internalId}`, 'utf8')
    .digest('base64url');
}

export class PrismaSettlementRepository implements SettlementRepository {
  public constructor(private readonly database: PrismaDatabase) {}

  public async readBacklogMetrics(timeoutMs: number): Promise<readonly SettlementBacklogRow[]> {
    try {
      return await this.database.getClient().$transaction(
        async (transaction) => {
          await transaction.$queryRaw`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`;
          const rows = await transaction.$queryRaw<
            { currency: SettlementCurrency; pending: bigint }[]
          >`
            SELECT adjustment."currency", COUNT(*) AS "pending"
            FROM "settlement_adjustments" AS adjustment
            WHERE adjustment."status" = 'pending'
              AND adjustment."currency" IN ('ETB', 'USD')
            GROUP BY adjustment."currency"
          `;
          return rows.map((row) => ({ currency: row.currency, pending: Number(row.pending) }));
        },
        { maxWait: timeoutMs, timeout: timeoutMs + 1_000 },
      );
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async transactionTime(transaction: PrismaTransactionClient): Promise<Date> {
    const rows = await transaction.$queryRaw<{ transaction_time: Date }[]>`
      SELECT transaction_timestamp() AS "transaction_time"
    `;
    return rows[0]!.transaction_time;
  }

  public async getFeePolicy(
    transaction: PrismaTransactionClient,
    currency: SettlementCurrency,
  ): Promise<SettlementFeePolicy> {
    const row = await transaction.settlementFeePolicy.findUnique({
      where: { version_currency: { currency, version: 'settlement_fee_v1' } },
    });
    if (row === null) throw new SettlementFeePolicyInvalidError();
    return {
      basisPoints: row.basisPoints,
      currency,
      flatFeeMinor: row.flatFeeMinor,
      version: 'settlement_fee_v1',
    };
  }

  public async lockCandidates(
    transaction: PrismaTransactionClient,
    merchantId: string,
    currency: SettlementCurrency,
    cutoffAt: Date,
  ): Promise<{
    readonly candidates: readonly SettlementPositionCandidate[];
    readonly moreEligible: boolean;
  }> {
    await transaction.$queryRaw`
      SELECT "id" FROM "settlement_streams"
      WHERE "merchant_id" = ${merchantId}::uuid AND "currency" = ${currency}
      FOR UPDATE
    `;
    const rows = await transaction.$queryRaw<CandidateRow[]>`
      SELECT sp."id", sp."payment_intent_id", sp."payment_public_id", sp."currency",
        sp."captured_amount_minor", sp."refunded_amount_minor", sp."available_at"
      FROM "settlement_positions" sp
      LEFT JOIN "settlement_batch_items" bi ON bi."settlement_position_id" = sp."id"
      WHERE sp."merchant_id" = ${merchantId}::uuid AND sp."currency" = ${currency}
        AND sp."available_at" < ${cutoffAt}
        AND sp."captured_amount_minor" > sp."refunded_amount_minor"
        AND bi."id" IS NULL
      ORDER BY sp."available_at", sp."payment_intent_id"
      LIMIT 501 FOR UPDATE OF sp SKIP LOCKED
    `;
    const selected = rows.slice(0, 500);
    return {
      candidates: selected.map((row) => ({
        availableAt: row.available_at,
        capturedAmountMinor: row.captured_amount_minor,
        currency: row.currency,
        id: row.id,
        paymentIntentId: row.payment_intent_id,
        paymentPublicId: row.payment_public_id,
        refundedAmountMinor: row.refunded_amount_minor,
      })),
      moreEligible: rows.length > 500,
    };
  }

  public async lockPendingAdjustments(
    transaction: PrismaTransactionClient,
    merchantId: string,
    currency: SettlementCurrency,
  ): Promise<{
    readonly adjustments: readonly PendingSettlementAdjustment[];
    readonly moreEligible: boolean;
  }> {
    const rows = await transaction.$queryRaw<AdjustmentRow[]>`
      SELECT "id", "amount_minor" FROM "settlement_adjustments"
      WHERE "merchant_id" = ${merchantId}::uuid AND "currency" = ${currency}
        AND "status" = 'pending'
      ORDER BY "occurred_at", "id" LIMIT 501 FOR UPDATE
    `;
    return {
      adjustments: rows.slice(0, 500).map((row) => ({ amountMinor: row.amount_minor, id: row.id })),
      moreEligible: rows.length > 500,
    };
  }

  public async createNoopRun(
    transaction: PrismaTransactionClient,
    input: Omit<
      PersistSettlementInput,
      | 'adjustments'
      | 'batchId'
      | 'feeMinor'
      | 'grossMinor'
      | 'items'
      | 'ledgerTransactionId'
      | 'netMinor'
      | 'paymentGrossMinor'
      | 'adjustmentMinor'
    >,
  ): Promise<SettlementRunRepresentation> {
    const row = await transaction.settlementRun.create({
      data: {
        completedAt: input.occurredAt,
        currency: input.currency,
        cutoffAt: input.cutoffAt,
        cutoffDate: new Date(`${input.cutoffDate}T00:00:00.000Z`),
        cutoffTimezone: 'Africa/Addis_Ababa',
        merchantId: input.merchantId,
        moreEligible: input.moreEligible,
        publicId: input.runId,
        requestId: input.requestId,
        requestedByApiKeyId: input.actorApiKeyId,
        status: 'NO_ELIGIBLE_ITEMS',
      },
    });
    return {
      completedAt: row.completedAt.toISOString(),
      currency: input.currency,
      cutoffAt: input.cutoffAt.toISOString(),
      cutoffDate: input.cutoffDate,
      id: row.publicId,
      moreEligible: input.moreEligible,
      status: 'NO_ELIGIBLE_ITEMS',
    };
  }

  public async persistSettlement(
    transaction: PrismaTransactionClient,
    input: PersistSettlementInput,
  ): Promise<{
    readonly batch: SettlementBatchRepresentation;
    readonly run: SettlementRunRepresentation;
  }> {
    const batch = await transaction.settlementBatch.create({
      data: {
        adjustmentCount: input.adjustments.length,
        adjustmentMinor: input.adjustmentMinor,
        currency: input.currency,
        cutoffAt: input.cutoffAt,
        cutoffDate: new Date(`${input.cutoffDate}T00:00:00.000Z`),
        cutoffTimezone: 'Africa/Addis_Ababa',
        feeMinor: input.feeMinor,
        grossMinor: input.grossMinor,
        itemCount: input.items.length,
        ledgerTransactionId: input.ledgerTransactionInternalId,
        ledgerTransactionPublicId: input.ledgerTransactionId,
        merchantId: input.merchantId,
        netMinor: input.netMinor,
        paymentGrossMinor: input.paymentGrossMinor,
        publicId: input.batchId,
        status: 'BATCHED',
      },
    });
    await transaction.settlementBatchItem.createMany({
      data: input.items.map((item) => ({
        availableAt: item.availableAt,
        basisPoints: item.basisPoints,
        batchId: batch.id,
        capturedAmountMinor: item.capturedAmountMinor,
        currency: input.currency,
        feeMinor: item.feeMinor,
        feePolicyVersion: 'settlement_fee_v1',
        flatFeeMinor: item.flatFeeMinor,
        grossMinor: item.capturedAmountMinor - item.refundedAmountMinor,
        merchantId: input.merchantId,
        netMinor: item.netMinor,
        paymentIntentId: item.paymentIntentId,
        refundedAmountMinor: item.refundedAmountMinor,
        settlementPositionId: item.id,
      })),
    });
    if (input.adjustments.length > 0) {
      await transaction.settlementAdjustment.updateMany({
        data: { batchId: batch.id, status: 'BATCHED' },
        where: {
          id: { in: input.adjustments.map((adjustment) => adjustment.id) },
          merchantId: input.merchantId,
          status: 'PENDING',
        },
      });
    }
    const finalizedBatches = await transaction.$executeRaw`
      UPDATE "settlement_batches"
      SET "status" = 'settled', "settled_at" = transaction_timestamp()
      WHERE "id" = ${batch.id}::uuid AND "status" = 'batched'
    `;
    if (finalizedBatches !== 1) throw new Error('settlement_batch_finalization_conflict');
    if (input.adjustments.length > 0) {
      const finalizedAdjustments = await transaction.$executeRaw`
        UPDATE "settlement_adjustments"
        SET "status" = 'settled', "settled_at" = transaction_timestamp()
        WHERE "batch_id" = ${batch.id}::uuid AND "status" = 'batched'
      `;
      if (finalizedAdjustments !== input.adjustments.length)
        throw new Error('settlement_adjustment_finalization_conflict');
    }
    await transaction.settlementRun.create({
      data: {
        batchId: batch.id,
        completedAt: input.occurredAt,
        currency: input.currency,
        cutoffAt: input.cutoffAt,
        cutoffDate: new Date(`${input.cutoffDate}T00:00:00.000Z`),
        cutoffTimezone: 'Africa/Addis_Ababa',
        merchantId: input.merchantId,
        moreEligible: input.moreEligible,
        publicId: input.runId,
        requestId: input.requestId,
        requestedByApiKeyId: input.actorApiKeyId,
        status: 'COMPLETED',
      },
    });
    const items: SettlementBatchRepresentation['items'] = input.items.map((item) => ({
      feeAmountMinor: number(item.feeMinor),
      grossAmountMinor: number(item.capturedAmountMinor - item.refundedAmountMinor),
      netAmountMinor: number(item.netMinor),
      paymentId: item.paymentPublicId,
    }));
    const representation: SettlementBatchRepresentation = {
      adjustmentAmountMinor: number(input.adjustmentMinor),
      adjustmentCount: input.adjustments.length,
      adjustments: [],
      createdAt: input.occurredAt.toISOString(),
      currency: input.currency,
      cutoffAt: input.cutoffAt.toISOString(),
      feeAmountMinor: number(input.feeMinor),
      grossAmountMinor: number(input.grossMinor),
      id: input.batchId,
      itemCount: input.items.length,
      items,
      ledgerTransactionId: input.ledgerTransactionId,
      netAmountMinor: number(input.netMinor),
      paymentGrossAmountMinor: number(input.paymentGrossMinor),
      settledAt: input.occurredAt.toISOString(),
      status: 'SETTLED',
    };
    return {
      batch: representation,
      run: {
        batchId: input.batchId,
        completedAt: input.occurredAt.toISOString(),
        currency: input.currency,
        cutoffAt: input.cutoffAt.toISOString(),
        cutoffDate: input.cutoffDate,
        id: input.runId,
        moreEligible: input.moreEligible,
        status: 'COMPLETED',
      },
    };
  }

  public async getDerivedStatus(
    merchantId: string,
    paymentPublicId: string,
  ): Promise<SettlementDerivedStatus> {
    const position = await this.database.getClient().settlementPosition.findFirst({
      include: {
        adjustments: { where: { status: 'PENDING' }, take: 1 },
        batchItem: { include: { batch: true } },
      },
      where: { merchantId, paymentPublicId },
    });
    if (position === null) return 'NOT_ELIGIBLE';
    if (position.adjustments.length > 0) return 'ADJUSTMENT_PENDING';
    if (position.batchItem?.batch.status === 'SETTLED') return 'SETTLED';
    if (position.batchItem !== null && position.batchItem !== undefined) return 'BATCHED';
    return position.capturedAmountMinor > position.refundedAmountMinor
      ? 'ELIGIBLE'
      : 'NOT_ELIGIBLE';
  }

  public async findBatch(
    merchantId: string,
    publicId: string,
    limit: number,
    cursor?: string,
  ): Promise<SettlementBatchRepresentation | undefined> {
    const row = await this.database.getClient().settlementBatch.findFirst({
      include: {
        adjustments: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
        items: {
          orderBy: [{ availableAt: 'asc' }, { paymentIntentId: 'asc' }],
          include: { position: { select: { paymentPublicId: true } } },
        },
      },
      where: { merchantId, publicId },
    });
    if (row === null) return undefined;
    const entries = [
      ...row.items.map((value) => ({ id: value.id, kind: 'item' as const, value })),
      ...row.adjustments.map((value) => ({ id: value.id, kind: 'adjustment' as const, value })),
    ];
    const start =
      cursor === undefined
        ? 0
        : entries.findIndex((entry) => pageToken(row.publicId, entry.kind, entry.id) === cursor) +
          1;
    if (cursor !== undefined && start === 0) throw new InvalidSettlementRequestError();
    const page = entries.slice(start, start + limit);
    const last = page.at(-1);
    const nextCursor =
      start + page.length < entries.length && last !== undefined
        ? pageToken(row.publicId, last.kind, last.id)
        : undefined;
    const items = page
      .filter(
        (entry): entry is Extract<(typeof page)[number], { kind: 'item' }> => entry.kind === 'item',
      )
      .map(({ value }) => ({
        feeAmountMinor: number(value.feeMinor),
        grossAmountMinor: number(value.grossMinor),
        netAmountMinor: number(value.netMinor),
        paymentId: value.position.paymentPublicId,
      }));
    const adjustments = page
      .filter(
        (entry): entry is Extract<(typeof page)[number], { kind: 'adjustment' }> =>
          entry.kind === 'adjustment',
      )
      .map(({ value }) => ({
        adjustmentId: value.publicId,
        amountMinor: number(value.amountMinor),
        refundId: value.refundPublicId,
      }));
    return {
      adjustmentAmountMinor: number(row.adjustmentMinor),
      adjustmentCount: row.adjustmentCount,
      adjustments,
      createdAt: row.createdAt.toISOString(),
      currency: row.currency as SettlementCurrency,
      cutoffAt: row.cutoffAt.toISOString(),
      feeAmountMinor: number(row.feeMinor),
      grossAmountMinor: number(row.grossMinor),
      id: row.publicId,
      itemCount: row.itemCount,
      items,
      ledgerTransactionId: row.ledgerTransactionPublicId,
      netAmountMinor: number(row.netMinor),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      paymentGrossAmountMinor: number(row.paymentGrossMinor),
      settledAt: row.settledAt!.toISOString(),
      status: 'SETTLED',
    };
  }

  public async projectLifecycle(
    transaction: PrismaTransactionClient,
    event: ResolvedSettlementProjectionEvent,
    adjustmentId?: string,
  ): Promise<void> {
    if (event.eventType === 'payment.captured.v1') {
      await transaction.settlementStream.createMany({
        data: [{ currency: event.currency, merchantId: event.merchantId }],
        skipDuplicates: true,
      });
      await transaction.settlementPosition.upsert({
        create: {
          availableAt: event.availableOn!,
          capturedAmountMinor: BigInt(event.amountMinor),
          capturedAt: event.occurredAt,
          currency: event.currency,
          lastEventId: event.eventId,
          lastEventOccurredAt: event.occurredAt,
          merchantId: event.merchantId,
          paymentIntentId: event.paymentIntentId,
          paymentPublicId: event.paymentId,
          refundedAmountMinor: 0n,
        },
        update: {
          availableAt: event.availableOn!,
          capturedAmountMinor: BigInt(event.amountMinor),
          lastEventId: event.eventId,
          lastEventOccurredAt: event.occurredAt,
        },
        where: { paymentIntentId: event.paymentIntentId },
      });
      return;
    }
    const position = await transaction.settlementPosition.findUnique({
      include: { batchItem: true },
      where: { paymentIntentId: event.paymentIntentId },
    });
    if (position === null) return;
    await transaction.settlementPosition.update({
      data: {
        lastEventId: event.eventId,
        lastEventOccurredAt: event.occurredAt,
        refundedAmountMinor: BigInt(event.cumulativeRefundedAmountMinor!),
      },
      where: { id: position.id },
    });
    if (position.batchItem !== null) {
      if (event.refundRecordId === undefined) throw new Error('refund_projection_identity_missing');
      await transaction.settlementAdjustment.create({
        data: {
          amountMinor: BigInt(event.amountMinor),
          currency: event.currency,
          merchantId: event.merchantId,
          occurredAt: event.occurredAt,
          originalBatchItemId: position.batchItem.id,
          paymentIntentId: event.paymentIntentId,
          publicId: adjustmentId!,
          refundId: event.refundRecordId,
          refundPublicId: event.refundId!,
          settlementPositionId: position.id,
          sourceEventId: event.eventId,
        },
      });
    }
  }
}
