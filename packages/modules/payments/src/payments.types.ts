import type { PrismaTransactionClient } from '@settleflow/infrastructure';

export type PaymentCurrency = 'ETB' | 'USD';
export type PaymentStatus = 'captured' | 'created' | 'partially_refunded' | 'refunded';

export interface ValidatedPaymentIntentFields {
  readonly amountMinor: number;
  readonly captureMethod: 'manual';
  readonly currency: PaymentCurrency;
  readonly externalRef: string;
}

export interface ValidatedCaptureFields {
  readonly amountMinor: number;
  readonly currency: PaymentCurrency;
}

export interface ValidatedRefundFields extends ValidatedCaptureFields {
  readonly externalRef: string;
}

export interface CreatePaymentIntentCommand extends ValidatedPaymentIntentFields {
  readonly idempotencyKey: string;
  readonly merchantId: string;
  readonly requestId: string;
}

export interface CapturePaymentIntentCommand extends ValidatedCaptureFields {
  readonly idempotencyKey: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly requestId: string;
}

export interface RefundPaymentIntentCommand extends ValidatedRefundFields {
  readonly idempotencyKey: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly requestId: string;
}

export interface PaymentIntentRecord {
  readonly amountMinor: number;
  readonly availableAt: Date | undefined;
  readonly captureMethod: 'manual';
  readonly capturedAmountMinor: number;
  readonly capturedAt: Date | undefined;
  readonly createdAt: Date;
  readonly currency: PaymentCurrency;
  readonly externalRef: string;
  readonly id: string;
  readonly merchantId: string;
  readonly paymentStatus: PaymentStatus;
  readonly publicId: string;
  readonly refundedAmountMinor: number;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface LockedPaymentIntentRecord {
  readonly payment: PaymentIntentRecord;
  readonly transactionTime: Date;
}

export interface PaymentIntentRepresentation {
  readonly amountMinor: number;
  readonly captureMethod: 'manual';
  readonly capturedAmountMinor: number;
  readonly createdAt: string;
  readonly currency: PaymentCurrency;
  readonly externalRef: string;
  readonly id: string;
  readonly paymentStatus: PaymentStatus;
  readonly refundedAmountMinor: number;
  readonly settlementStatus:
    'ADJUSTMENT_PENDING' | 'BATCHED' | 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'SETTLED';
  readonly updatedAt: string;
  readonly version: number;
}

export interface CapturedPaymentIntentRepresentation extends PaymentIntentRepresentation {
  readonly ledgerTransactionId: string;
  readonly paymentStatus: 'captured';
}

export interface RefundRepresentation {
  readonly amountMinor: number;
  readonly createdAt: string;
  readonly cumulativeRefundedAmountMinor: number;
  readonly currency: PaymentCurrency;
  readonly externalRef: string;
  readonly id: string;
  readonly ledgerTransactionId: string;
  readonly paymentId: string;
  readonly paymentStatus: 'partially_refunded' | 'refunded';
}

export interface RefundRecord {
  readonly amountMinor: number;
  readonly createdAt: Date;
  readonly currency: PaymentCurrency;
  readonly externalRef: string;
  readonly id: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly publicId: string;
}

export interface PaymentReconciliationEvidence {
  readonly businessReference: string;
  readonly currency: PaymentCurrency;
  readonly eventType: 'capture' | 'refund';
  readonly externalRef: string;
  readonly grossMinor: bigint;
  readonly occurredAt: Date;
  readonly publicRef: string;
}

export interface PaymentReconciliationReadPort {
  readPaymentEvidence(
    transaction: PrismaTransactionClient,
    merchantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<readonly PaymentReconciliationEvidence[]>;
}

export interface PaymentSettlementCandidateInput {
  readonly paymentIntentId: string;
  readonly paymentPublicId: string;
  readonly settlementPositionId: string;
}

export interface PaymentSettlementCandidateFact extends PaymentSettlementCandidateInput {
  readonly availableAt: Date | undefined;
  readonly capturedAmountMinor: bigint;
  readonly currency: PaymentCurrency;
  readonly refundedAmountMinor: bigint;
}

export interface PaymentSettlementProjectionIdentity {
  readonly currency: PaymentCurrency;
  readonly paymentIntentId: string;
  readonly paymentPublicId: string;
  readonly refundRecordId?: string;
  readonly refundPublicId?: string;
}

export interface PaymentSettlementReadPort {
  lockSettlementCandidates(
    transaction: PrismaTransactionClient,
    merchantId: string,
    candidates: readonly PaymentSettlementCandidateInput[],
  ): Promise<readonly PaymentSettlementCandidateFact[]>;
  readSettlementProjectionIdentity(
    transaction: PrismaTransactionClient,
    merchantId: string,
    paymentPublicId: string,
    refundPublicId?: string,
  ): Promise<PaymentSettlementProjectionIdentity | undefined>;
}

export interface PaymentCommandObservation {
  readonly code?: string;
  readonly ledgerTransactionId?: string;
  readonly merchantId: string;
  readonly operation: 'capture' | 'refund';
  readonly outcome: 'committed' | 'rejected' | 'replayed';
  readonly paymentId: string;
  readonly refundId?: string;
  readonly requestId: string;
}

export interface PaymentCommandObserver {
  record(observation: PaymentCommandObservation): void;
}

export interface CreatePaymentIntentRecord {
  readonly amountMinor: number;
  readonly currency: PaymentCurrency;
  readonly externalRef: string;
  readonly merchantId: string;
  readonly publicId: string;
}

export interface CreateRefundRecord {
  readonly amountMinor: number;
  readonly createdAt: Date;
  readonly currency: PaymentCurrency;
  readonly externalRef: string;
  readonly id: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly publicId: string;
}

export interface PaymentIntentRepository {
  applyRefund(
    transaction: PrismaTransactionClient,
    payment: PaymentIntentRecord,
    amountMinor: number,
    occurredAt: Date,
  ): Promise<PaymentIntentRecord>;
  capture(
    transaction: PrismaTransactionClient,
    payment: PaymentIntentRecord,
    occurredAt: Date,
  ): Promise<PaymentIntentRecord>;
  create(
    transaction: PrismaTransactionClient,
    input: CreatePaymentIntentRecord,
  ): Promise<PaymentIntentRecord>;
  createRefund(
    transaction: PrismaTransactionClient,
    input: CreateRefundRecord,
  ): Promise<RefundRecord>;
  findByPublicId(merchantId: string, publicId: string): Promise<PaymentIntentRecord | undefined>;
  lockByPublicId(
    transaction: PrismaTransactionClient,
    merchantId: string,
    publicId: string,
  ): Promise<LockedPaymentIntentRecord | undefined>;
}
