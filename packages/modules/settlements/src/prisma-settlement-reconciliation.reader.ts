import type { PrismaTransactionClient } from '@settleflow/infrastructure';

import type {
  SettlementCurrency,
  SettlementReconciliationEvidence,
  SettlementReconciliationReadPort,
} from './settlement.types';

export class PrismaSettlementReconciliationReader implements SettlementReconciliationReadPort {
  public async readSettlementEvidence(
    transaction: PrismaTransactionClient,
    merchantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<readonly SettlementReconciliationEvidence[]> {
    const [batches, adjustments] = await Promise.all([
      transaction.settlementBatch.findMany({
        orderBy: [{ settledAt: 'asc' }, { id: 'asc' }],
        select: {
          currency: true,
          feeMinor: true,
          grossMinor: true,
          netMinor: true,
          publicId: true,
          settledAt: true,
        },
        where: {
          merchantId,
          settledAt: { gte: periodStart, lt: periodEnd },
          status: 'SETTLED',
        },
      }),
      transaction.settlementAdjustment.findMany({
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: {
          amountMinor: true,
          batch: { select: { publicId: true } },
          currency: true,
          occurredAt: true,
          publicId: true,
        },
        where: {
          merchantId,
          occurredAt: { gte: periodStart, lt: periodEnd },
          status: 'SETTLED',
        },
      }),
    ]);
    return [
      ...batches.map((batch) => ({
        businessReference: batch.publicId,
        currency: batch.currency as SettlementCurrency,
        eventType: 'settlement' as const,
        externalRef: batch.publicId,
        feeMinor: batch.feeMinor,
        grossMinor: batch.grossMinor,
        netMinor: batch.netMinor,
        occurredAt: batch.settledAt!,
        publicRef: batch.publicId,
      })),
      ...adjustments.map((adjustment) => ({
        businessReference: adjustment.batch!.publicId,
        currency: adjustment.currency as SettlementCurrency,
        eventType: 'adjustment' as const,
        externalRef: adjustment.publicId,
        feeMinor: 0n,
        grossMinor: adjustment.amountMinor,
        netMinor: adjustment.amountMinor,
        occurredAt: adjustment.occurredAt,
        publicRef: adjustment.publicId,
      })),
    ];
  }
}
