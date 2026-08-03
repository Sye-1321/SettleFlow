import type { PrismaTransactionClient } from '@settleflow/infrastructure';

export type SettlementCurrency = 'ETB' | 'USD';
export type SettlementDerivedStatus =
  'ADJUSTMENT_PENDING' | 'BATCHED' | 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'SETTLED';

export interface RunSettlementCommand {
  readonly actorApiKeyId: string;
  readonly currency: SettlementCurrency;
  readonly cutoffDate: string;
  readonly idempotencyKey: string;
  readonly merchantId: string;
  readonly requestId: string;
}

export interface SettlementPositionCandidate {
  readonly availableAt: Date;
  readonly capturedAmountMinor: bigint;
  readonly currency: SettlementCurrency;
  readonly id: string;
  readonly paymentIntentId: string;
  readonly paymentPublicId: string;
  readonly refundedAmountMinor: bigint;
}

export interface PendingSettlementAdjustment {
  readonly amountMinor: bigint;
  readonly id: string;
}

export interface SettlementFeePolicy {
  readonly basisPoints: number;
  readonly currency: SettlementCurrency;
  readonly flatFeeMinor: bigint;
  readonly version: 'settlement_fee_v1';
}

export interface SettlementItemRepresentation {
  readonly feeAmountMinor: number;
  readonly grossAmountMinor: number;
  readonly netAmountMinor: number;
  readonly paymentId: string;
}

export interface SettlementAdjustmentRepresentation {
  readonly adjustmentId: string;
  readonly amountMinor: number;
  readonly refundId: string;
}

export interface SettlementBatchRepresentation {
  readonly adjustmentAmountMinor: number;
  readonly adjustmentCount: number;
  readonly adjustments: readonly SettlementAdjustmentRepresentation[];
  readonly createdAt: string;
  readonly currency: SettlementCurrency;
  readonly cutoffAt: string;
  readonly feeAmountMinor: number;
  readonly grossAmountMinor: number;
  readonly id: string;
  readonly itemCount: number;
  readonly items: readonly SettlementItemRepresentation[];
  readonly ledgerTransactionId: string;
  readonly netAmountMinor: number;
  readonly nextCursor?: string;
  readonly paymentGrossAmountMinor: number;
  readonly settledAt: string;
  readonly status: 'SETTLED';
}

export interface SettlementRunRepresentation {
  readonly batchId?: string;
  readonly completedAt: string;
  readonly currency: SettlementCurrency;
  readonly cutoffAt: string;
  readonly cutoffDate: string;
  readonly id: string;
  readonly moreEligible: boolean;
  readonly status: 'COMPLETED' | 'NO_ELIGIBLE_ITEMS';
}

export interface PersistSettlementInput {
  readonly actorApiKeyId: string;
  readonly adjustments: readonly PendingSettlementAdjustment[];
  readonly batchId: string;
  readonly currency: SettlementCurrency;
  readonly cutoffAt: Date;
  readonly cutoffDate: string;
  readonly feeMinor: bigint;
  readonly grossMinor: bigint;
  readonly items: readonly (SettlementPositionCandidate & {
    readonly feeMinor: bigint;
    readonly flatFeeMinor: bigint;
    readonly netMinor: bigint;
    readonly basisPoints: number;
  })[];
  readonly ledgerTransactionInternalId: string;
  readonly ledgerTransactionId: string;
  readonly merchantId: string;
  readonly moreEligible: boolean;
  readonly netMinor: bigint;
  readonly occurredAt: Date;
  readonly paymentGrossMinor: bigint;
  readonly adjustmentMinor: bigint;
  readonly requestId: string;
  readonly runId: string;
}

export interface SettlementProjectionEvent {
  readonly amountMinor: number;
  readonly availableOn?: Date;
  readonly cumulativeRefundedAmountMinor?: number;
  readonly currency: SettlementCurrency;
  readonly eventId: string;
  readonly eventType: 'payment.captured.v1' | 'payment.refunded.v1';
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly paymentId: string;
  readonly refundId?: string;
}

export interface ResolvedSettlementProjectionEvent extends SettlementProjectionEvent {
  readonly paymentIntentId: string;
  readonly refundRecordId?: string;
}

export interface SettlementReconciliationEvidence {
  readonly businessReference: string;
  readonly currency: SettlementCurrency;
  readonly eventType: 'adjustment' | 'settlement';
  readonly externalRef: string;
  readonly feeMinor: bigint;
  readonly grossMinor: bigint;
  readonly netMinor: bigint;
  readonly occurredAt: Date;
  readonly publicRef: string;
}

export interface SettlementReconciliationReadPort {
  readSettlementEvidence(
    transaction: PrismaTransactionClient,
    merchantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<readonly SettlementReconciliationEvidence[]>;
}

export interface SettlementRepository {
  createNoopRun(
    transaction: PrismaTransactionClient,
    input: Omit<
      PersistSettlementInput,
      | 'adjustments'
      | 'batchId'
      | 'feeMinor'
      | 'grossMinor'
      | 'items'
      | 'ledgerTransactionId'
      | 'ledgerTransactionInternalId'
      | 'netMinor'
      | 'paymentGrossMinor'
      | 'adjustmentMinor'
    >,
  ): Promise<SettlementRunRepresentation>;
  findBatch(
    merchantId: string,
    publicId: string,
    limit: number,
    cursor?: string,
  ): Promise<SettlementBatchRepresentation | undefined>;
  getDerivedStatus(merchantId: string, paymentPublicId: string): Promise<SettlementDerivedStatus>;
  getFeePolicy(
    transaction: PrismaTransactionClient,
    currency: SettlementCurrency,
  ): Promise<SettlementFeePolicy>;
  lockCandidates(
    transaction: PrismaTransactionClient,
    merchantId: string,
    currency: SettlementCurrency,
    cutoffAt: Date,
  ): Promise<{
    readonly candidates: readonly SettlementPositionCandidate[];
    readonly moreEligible: boolean;
  }>;
  lockPendingAdjustments(
    transaction: PrismaTransactionClient,
    merchantId: string,
    currency: SettlementCurrency,
  ): Promise<{
    readonly adjustments: readonly PendingSettlementAdjustment[];
    readonly moreEligible: boolean;
  }>;
  persistSettlement(
    transaction: PrismaTransactionClient,
    input: PersistSettlementInput,
  ): Promise<{
    readonly batch: SettlementBatchRepresentation;
    readonly run: SettlementRunRepresentation;
  }>;
  projectLifecycle(
    transaction: PrismaTransactionClient,
    event: ResolvedSettlementProjectionEvent,
    adjustmentId?: string,
  ): Promise<void>;
  transactionTime(transaction: PrismaTransactionClient): Promise<Date>;
}
