import { Prisma, type PrismaTransactionClient } from '@settleflow/infrastructure';

import type {
  PaymentCurrency,
  PaymentSettlementCandidateFact,
  PaymentSettlementCandidateInput,
  PaymentSettlementProjectionIdentity,
  PaymentSettlementReadPort,
} from './payments.types';

interface LockedPaymentRow {
  readonly available_at: Date | null;
  readonly captured_amount_minor: bigint;
  readonly currency: PaymentCurrency;
  readonly id: string;
  readonly public_id: string;
  readonly refunded_amount_minor: bigint;
}

export class PrismaPaymentSettlementReader implements PaymentSettlementReadPort {
  public async lockSettlementCandidates(
    transaction: PrismaTransactionClient,
    merchantId: string,
    candidates: readonly PaymentSettlementCandidateInput[],
  ): Promise<readonly PaymentSettlementCandidateFact[]> {
    if (candidates.length === 0) return [];
    const identifiers = candidates.map(
      (candidate) => Prisma.sql`${candidate.paymentIntentId}::uuid`,
    );
    const rows = await transaction.$queryRaw<LockedPaymentRow[]>(Prisma.sql`
      SELECT "id", "public_id", "currency", "captured_amount_minor",
        "refunded_amount_minor", "available_at"
      FROM "payment_intents"
      WHERE "merchant_id" = ${merchantId}::uuid
        AND "id" IN (${Prisma.join(identifiers)})
      ORDER BY "id"
      FOR UPDATE
    `);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return candidates.flatMap((candidate) => {
      const row = byId.get(candidate.paymentIntentId);
      if (row?.public_id !== candidate.paymentPublicId) return [];
      return [
        {
          availableAt: row.available_at ?? undefined,
          capturedAmountMinor: row.captured_amount_minor,
          currency: row.currency,
          paymentIntentId: row.id,
          paymentPublicId: row.public_id,
          refundedAmountMinor: row.refunded_amount_minor,
          settlementPositionId: candidate.settlementPositionId,
        },
      ];
    });
  }

  public async readSettlementProjectionIdentity(
    transaction: PrismaTransactionClient,
    merchantId: string,
    paymentPublicId: string,
    refundPublicId?: string,
  ): Promise<PaymentSettlementProjectionIdentity | undefined> {
    const payment = await transaction.paymentIntent.findFirst({
      select: { currency: true, id: true, publicId: true },
      where: { merchantId, publicId: paymentPublicId },
    });
    if (payment === null) return undefined;
    if (refundPublicId === undefined) {
      return {
        currency: payment.currency as PaymentCurrency,
        paymentIntentId: payment.id,
        paymentPublicId: payment.publicId,
      };
    }
    const refund = await transaction.refund.findFirst({
      select: { id: true, publicId: true },
      where: { merchantId, paymentIntentId: payment.id, publicId: refundPublicId },
    });
    if (refund === null) return undefined;
    return {
      currency: payment.currency as PaymentCurrency,
      paymentIntentId: payment.id,
      paymentPublicId: payment.publicId,
      refundRecordId: refund.id,
      refundPublicId: refund.publicId,
    };
  }
}
