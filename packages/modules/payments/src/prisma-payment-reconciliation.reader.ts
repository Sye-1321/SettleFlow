import type { PrismaTransactionClient } from '@settleflow/infrastructure';

import type {
  PaymentCurrency,
  PaymentReconciliationEvidence,
  PaymentReconciliationReadPort,
} from './payments.types';

export class PrismaPaymentReconciliationReader implements PaymentReconciliationReadPort {
  public async readPaymentEvidence(
    transaction: PrismaTransactionClient,
    merchantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<readonly PaymentReconciliationEvidence[]> {
    const [captures, refunds] = await Promise.all([
      transaction.paymentIntent.findMany({
        orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
        select: {
          capturedAmountMinor: true,
          capturedAt: true,
          currency: true,
          externalRef: true,
          publicId: true,
        },
        where: {
          capturedAt: { gte: periodStart, lt: periodEnd },
          merchantId,
        },
      }),
      transaction.refund.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          amountMinor: true,
          createdAt: true,
          currency: true,
          externalRef: true,
          publicId: true,
        },
        where: {
          createdAt: { gte: periodStart, lt: periodEnd },
          merchantId,
        },
      }),
    ]);
    return [
      ...captures.map((capture) => ({
        businessReference: capture.publicId,
        currency: capture.currency as PaymentCurrency,
        eventType: 'capture' as const,
        externalRef: capture.externalRef,
        grossMinor: capture.capturedAmountMinor,
        occurredAt: capture.capturedAt!,
        publicRef: capture.publicId,
      })),
      ...refunds.map((refund) => ({
        businessReference: refund.publicId,
        currency: refund.currency as PaymentCurrency,
        eventType: 'refund' as const,
        externalRef: refund.externalRef,
        grossMinor: refund.amountMinor,
        occurredAt: refund.createdAt,
        publicRef: refund.publicId,
      })),
    ];
  }
}
