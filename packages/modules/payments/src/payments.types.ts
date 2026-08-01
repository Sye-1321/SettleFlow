import type { PrismaTransactionClient } from '@settleflow/infrastructure';

export type PaymentCurrency = 'ETB' | 'USD';

export interface ValidatedPaymentIntentFields {
  readonly amountMinor: number;
  readonly captureMethod: 'manual';
  readonly currency: PaymentCurrency;
  readonly externalRef: string;
}

export interface CreatePaymentIntentCommand extends ValidatedPaymentIntentFields {
  readonly idempotencyKey: string;
  readonly merchantId: string;
  readonly requestId: string;
}

export interface PaymentIntentRecord {
  readonly amountMinor: number;
  readonly captureMethod: 'manual';
  readonly capturedAmountMinor: number;
  readonly createdAt: Date;
  readonly currency: PaymentCurrency;
  readonly externalRef: string;
  readonly merchantId: string;
  readonly paymentStatus: 'created';
  readonly publicId: string;
  readonly refundedAmountMinor: number;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface PaymentIntentRepresentation {
  readonly amountMinor: number;
  readonly captureMethod: 'manual';
  readonly capturedAmountMinor: number;
  readonly createdAt: string;
  readonly currency: PaymentCurrency;
  readonly externalRef: string;
  readonly id: string;
  readonly paymentStatus: 'created';
  readonly refundedAmountMinor: number;
  readonly settlementStatus: 'NOT_ELIGIBLE';
  readonly updatedAt: string;
  readonly version: number;
}

export interface CreatePaymentIntentRecord {
  readonly amountMinor: number;
  readonly currency: PaymentCurrency;
  readonly externalRef: string;
  readonly merchantId: string;
  readonly publicId: string;
}

export interface PaymentIntentRepository {
  create(
    transaction: PrismaTransactionClient,
    input: CreatePaymentIntentRecord,
  ): Promise<PaymentIntentRecord>;
  findByPublicId(merchantId: string, publicId: string): Promise<PaymentIntentRecord | undefined>;
}
