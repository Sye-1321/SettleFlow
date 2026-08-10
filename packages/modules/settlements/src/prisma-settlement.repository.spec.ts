import { PrismaDatabase, type PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  InvalidSettlementRequestError,
  SettlementFeePolicyInvalidError,
} from './settlement.errors';
import { PrismaSettlementRepository } from './prisma-settlement.repository';
import type { PersistSettlementInput, ResolvedSettlementProjectionEvent } from './settlement.types';

interface SettlementRepositoryHarness {
  readonly client: {
    readonly $transaction: jest.Mock;
    readonly settlementBatch: { readonly findFirst: jest.Mock };
    readonly settlementPosition: { readonly findFirst: jest.Mock };
  };
  readonly database: PrismaDatabase;
  readonly repository: PrismaSettlementRepository;
  readonly transaction: {
    readonly $executeRaw: jest.Mock;
    readonly $queryRaw: jest.Mock;
    readonly settlementAdjustment: { readonly create: jest.Mock; readonly updateMany: jest.Mock };
    readonly settlementBatch: { readonly create: jest.Mock };
    readonly settlementBatchItem: { readonly createMany: jest.Mock };
    readonly settlementFeePolicy: { readonly findUnique: jest.Mock };
    readonly settlementPosition: {
      readonly findUnique: jest.Mock;
      readonly update: jest.Mock;
      readonly upsert: jest.Mock;
    };
    readonly settlementRun: { readonly create: jest.Mock };
    readonly settlementStream: { readonly createMany: jest.Mock };
  };
  readonly tx: PrismaTransactionClient;
}

describe('PrismaSettlementRepository', () => {
  const now = new Date('2026-08-03T10:00:00.000Z');

  function harness(): SettlementRepositoryHarness {
    const transaction = {
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(),
      settlementAdjustment: { create: jest.fn(), updateMany: jest.fn() },
      settlementBatch: { create: jest.fn() },
      settlementBatchItem: { createMany: jest.fn() },
      settlementFeePolicy: { findUnique: jest.fn() },
      settlementPosition: { findUnique: jest.fn(), update: jest.fn(), upsert: jest.fn() },
      settlementRun: { create: jest.fn() },
      settlementStream: { createMany: jest.fn() },
    };
    const client = {
      $transaction: jest
        .fn()
        .mockImplementation(
          (operation: (value: typeof transaction) => Promise<unknown>): Promise<unknown> =>
            operation(transaction),
        ),
      settlementBatch: { findFirst: jest.fn() },
      settlementPosition: { findFirst: jest.fn() },
    };
    const database = {
      getClient: jest.fn().mockReturnValue(client),
      rethrowDatabaseError: jest.fn().mockImplementation((error: unknown) => {
        throw error;
      }),
    } as unknown as PrismaDatabase;
    return {
      client,
      database,
      repository: new PrismaSettlementRepository(database),
      transaction,
      tx: transaction as unknown as PrismaTransactionClient,
    };
  }

  it('reads bounded backlog metrics and maps database failures', async () => {
    const h = harness();
    h.transaction.$queryRaw
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ currency: 'ETB', pending: 2n }]);
    await expect(h.repository.readBacklogMetrics(250)).resolves.toEqual([
      { currency: 'ETB', pending: 2 },
    ]);
    const failure = new Error('timeout');
    h.client.$transaction.mockRejectedValueOnce(failure);
    await expect(h.repository.readBacklogMetrics(250)).rejects.toBe(failure);
  });

  it('uses transaction time and the closed fee-policy version', async () => {
    const h = harness();
    h.transaction.$queryRaw.mockResolvedValue([{ transaction_time: now }]);
    await expect(h.repository.transactionTime(h.tx)).resolves.toEqual(now);
    h.transaction.settlementFeePolicy.findUnique.mockResolvedValue({
      basisPoints: 200,
      flatFeeMinor: 600n,
    });
    await expect(h.repository.getFeePolicy(h.tx, 'ETB')).resolves.toEqual({
      basisPoints: 200,
      currency: 'ETB',
      flatFeeMinor: 600n,
      version: 'settlement_fee_v1',
    });
    h.transaction.settlementFeePolicy.findUnique.mockResolvedValue(null);
    await expect(h.repository.getFeePolicy(h.tx, 'USD')).rejects.toBeInstanceOf(
      SettlementFeePolicyInvalidError,
    );
  });

  it('locks and bounds candidate and adjustment batches', async () => {
    const h = harness();
    const rows = Array.from({ length: 501 }, (_, index) => ({
      available_at: now,
      captured_amount_minor: 1_000n,
      currency: 'ETB',
      id: `position-${index}`,
      payment_intent_id: `payment-${index}`,
      payment_public_id: `pi-${index}`,
      refunded_amount_minor: 100n,
    }));
    h.transaction.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
    const candidates = await h.repository.lockCandidates(h.tx, 'merchant', 'ETB', now);
    expect(candidates.moreEligible).toBe(true);
    expect(candidates.candidates[0]).toMatchObject({
      capturedAmountMinor: 1_000n,
      refundedAmountMinor: 100n,
    });
    h.transaction.$queryRaw.mockResolvedValue(
      rows.map((row) => ({ amount_minor: row.captured_amount_minor, id: row.id })),
    );
    const adjustments = await h.repository.lockPendingAdjustments(h.tx, 'merchant', 'ETB');
    expect(adjustments.moreEligible).toBe(true);
    expect(adjustments.adjustments[0]).toMatchObject({ amountMinor: 1_000n });
  });

  it('persists no-op and finalized settlement snapshots with guarded finalization', async () => {
    const h = harness();
    h.transaction.settlementRun.create.mockResolvedValue({ completedAt: now, publicId: 'str-id' });
    await expect(
      h.repository.createNoopRun(h.tx, {
        actorApiKeyId: 'key',
        currency: 'ETB',
        cutoffAt: now,
        cutoffDate: '2026-08-02',
        ledgerTransactionInternalId: 'unused-for-noop',
        merchantId: 'merchant',
        moreEligible: true,
        occurredAt: now,
        requestId: 'request',
        runId: 'str-id',
      }),
    ).resolves.toMatchObject({ id: 'str-id', status: 'NO_ELIGIBLE_ITEMS' });

    const input = {
      actorApiKeyId: 'key',
      adjustmentMinor: 100n,
      adjustments: [{ amountMinor: 100n, id: 'adjustment' }],
      batchId: 'stb-id',
      currency: 'ETB',
      cutoffAt: now,
      cutoffDate: '2026-08-02',
      feeMinor: 600n,
      grossMinor: 900n,
      items: [
        {
          availableAt: now,
          basisPoints: 200,
          capturedAmountMinor: 1_000n,
          currency: 'ETB',
          feeMinor: 600n,
          flatFeeMinor: 600n,
          id: 'position',
          netMinor: 300n,
          paymentIntentId: 'payment',
          paymentPublicId: 'pi-id',
          refundedAmountMinor: 0n,
        },
      ],
      ledgerTransactionId: 'ltx-id',
      ledgerTransactionInternalId: 'ledger-internal',
      merchantId: 'merchant',
      moreEligible: false,
      netMinor: 300n,
      occurredAt: now,
      paymentGrossMinor: 1_000n,
      requestId: 'request',
      runId: 'str-id',
    } satisfies PersistSettlementInput;
    h.transaction.settlementBatch.create.mockResolvedValue({ id: 'batch-internal' });
    h.transaction.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    await expect(h.repository.persistSettlement(h.tx, input)).resolves.toMatchObject({
      batch: { id: 'stb-id', status: 'SETTLED' },
      run: { id: 'str-id', status: 'COMPLETED' },
    });
    expect(h.transaction.settlementAdjustment.updateMany).toHaveBeenCalledTimes(1);

    const conflict = harness();
    conflict.transaction.settlementBatch.create.mockResolvedValue({ id: 'batch-internal' });
    conflict.transaction.$executeRaw.mockResolvedValue(0);
    await expect(
      conflict.repository.persistSettlement(conflict.tx, {
        ...input,
        adjustments: [],
        adjustmentMinor: 0n,
      }),
    ).rejects.toThrow('settlement_batch_finalization_conflict');

    const adjustmentConflict = harness();
    adjustmentConflict.transaction.settlementBatch.create.mockResolvedValue({
      id: 'batch-internal',
    });
    adjustmentConflict.transaction.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(
      adjustmentConflict.repository.persistSettlement(adjustmentConflict.tx, input),
    ).rejects.toThrow('settlement_adjustment_finalization_conflict');
  });

  it.each([
    [null, 'NOT_ELIGIBLE'],
    [
      { adjustments: [{}], batchItem: null, capturedAmountMinor: 1n, refundedAmountMinor: 0n },
      'ADJUSTMENT_PENDING',
    ],
    [
      {
        adjustments: [],
        batchItem: { batch: { status: 'SETTLED' } },
        capturedAmountMinor: 1n,
        refundedAmountMinor: 0n,
      },
      'SETTLED',
    ],
    [
      {
        adjustments: [],
        batchItem: { batch: { status: 'BATCHED' } },
        capturedAmountMinor: 1n,
        refundedAmountMinor: 0n,
      },
      'BATCHED',
    ],
    [
      { adjustments: [], batchItem: null, capturedAmountMinor: 1n, refundedAmountMinor: 0n },
      'ELIGIBLE',
    ],
    [
      { adjustments: [], batchItem: null, capturedAmountMinor: 1n, refundedAmountMinor: 1n },
      'NOT_ELIGIBLE',
    ],
  ])('derives status from authoritative position %#', async (position, expected) => {
    const h = harness();
    h.client.settlementPosition.findFirst.mockResolvedValue(position);
    await expect(h.repository.getDerivedStatus('merchant', 'pi-id')).resolves.toBe(expected);
  });

  it('returns tenant-scoped mixed batch pages and rejects unknown cursors', async () => {
    const h = harness();
    const row = {
      adjustmentCount: 1,
      adjustmentMinor: 100n,
      adjustments: [
        { amountMinor: 100n, id: 'adjustment-id', publicId: 'sta-id', refundPublicId: 'rf-id' },
      ],
      createdAt: now,
      currency: 'ETB',
      cutoffAt: now,
      feeMinor: 600n,
      grossMinor: 900n,
      itemCount: 1,
      items: [
        {
          availableAt: now,
          feeMinor: 600n,
          grossMinor: 1_000n,
          id: 'item-id',
          netMinor: 400n,
          paymentIntentId: 'payment',
          position: { paymentPublicId: 'pi-id' },
        },
      ],
      ledgerTransactionPublicId: 'ltx-id',
      netMinor: 300n,
      paymentGrossMinor: 1_000n,
      publicId: 'stb-id',
      settledAt: now,
    };
    h.client.settlementBatch.findFirst.mockResolvedValue(row);
    const first = await h.repository.findBatch('merchant', 'stb-id', 1);
    expect(first?.id).toBe('stb-id');
    expect(first?.items[0]).toMatchObject({ paymentId: 'pi-id' });
    expect(typeof first?.nextCursor).toBe('string');
    const second = await h.repository.findBatch('merchant', 'stb-id', 2, first?.nextCursor);
    expect(second).toMatchObject({ adjustments: [expect.objectContaining({ refundId: 'rf-id' })] });
    await expect(h.repository.findBatch('merchant', 'stb-id', 1, 'unknown')).rejects.toBeInstanceOf(
      InvalidSettlementRequestError,
    );
    h.client.settlementBatch.findFirst.mockResolvedValue(null);
    await expect(h.repository.findBatch('merchant', 'missing', 20)).resolves.toBeUndefined();
  });

  it('projects captures, refunds, late adjustments, and missing positions safely', async () => {
    const capture = harness();
    const captured: ResolvedSettlementProjectionEvent = {
      amountMinor: 1_000,
      availableOn: now,
      currency: 'ETB',
      eventId: 'evt-capture',
      eventType: 'payment.captured.v1',
      merchantId: 'merchant',
      occurredAt: now,
      paymentId: 'pi-id',
      paymentIntentId: 'payment-internal',
    };
    await capture.repository.projectLifecycle(capture.tx, captured);
    expect(capture.transaction.settlementStream.createMany).toHaveBeenCalled();
    expect(capture.transaction.settlementPosition.upsert).toHaveBeenCalled();

    const missing = harness();
    missing.transaction.settlementPosition.findUnique.mockResolvedValue(null);
    await expect(
      missing.repository.projectLifecycle(
        missing.tx,
        {
          ...captured,
          amountMinor: 100,
          cumulativeRefundedAmountMinor: 100,
          eventType: 'payment.refunded.v1',
          refundId: 'rf-id',
        },
        'sta-id',
      ),
    ).resolves.toBeUndefined();

    const refund = harness();
    refund.transaction.settlementPosition.findUnique.mockResolvedValue({
      batchItem: { id: 'item-id' },
      id: 'position-id',
    });
    const refunded = {
      ...captured,
      amountMinor: 100,
      cumulativeRefundedAmountMinor: 100,
      eventType: 'payment.refunded.v1' as const,
      refundId: 'rf-id',
      refundRecordId: 'refund-internal',
    };
    await refund.repository.projectLifecycle(refund.tx, refunded, 'sta-id');
    const adjustmentCalls = refund.transaction.settlementAdjustment.create.mock
      .calls as readonly (readonly unknown[])[];
    const adjustmentInput = adjustmentCalls[0]?.[0] as {
      readonly data?: { readonly publicId?: unknown; readonly sourceEventId?: unknown };
    };
    expect(adjustmentInput.data).toMatchObject({
      publicId: 'sta-id',
      sourceEventId: 'evt-capture',
    });
    const { refundRecordId, ...missingRefundIdentity } = refunded;
    expect(refundRecordId).toBe('refund-internal');
    await expect(
      refund.repository.projectLifecycle(refund.tx, missingRefundIdentity, 'sta-id'),
    ).rejects.toThrow('refund_projection_identity_missing');
  });
});
