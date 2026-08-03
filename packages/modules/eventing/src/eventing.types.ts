import type { PrismaTransactionClient } from '@settleflow/infrastructure';

interface PaymentEventBase {
  readonly currency: 'ETB' | 'USD';
  readonly eventId: string;
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly paymentId: string;
  readonly requestId: string;
}

export interface PaymentCreatedEvent extends PaymentEventBase {
  readonly amountMinor: number;
  readonly eventType: 'payment.created.v1';
  readonly status: 'CREATED';
}

export interface PaymentCapturedEvent extends PaymentEventBase {
  readonly availableOn: Date;
  readonly capturedAmountMinor: number;
  readonly eventType: 'payment.captured.v1';
  readonly ledgerTransactionId: string;
}

export interface PaymentRefundedEvent extends PaymentEventBase {
  readonly amountMinor: number;
  readonly cumulativeRefundedAmountMinor: number;
  readonly eventType: 'payment.refunded.v1';
  readonly ledgerTransactionId: string;
  readonly refundId: string;
}

export type PaymentDomainEvent = PaymentCapturedEvent | PaymentCreatedEvent | PaymentRefundedEvent;
export type PaymentDomainEventType = PaymentDomainEvent['eventType'];

interface OperationalEventBase {
  readonly eventId: string;
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly requestId: string;
}

export interface SettlementFinalizedEvent extends OperationalEventBase {
  readonly batchId: string;
  readonly currency: 'ETB' | 'USD';
  readonly cutoffAt: Date;
  readonly eventType: 'settlement.finalized.v1';
  readonly feeAmountMinor: number;
  readonly grossAmountMinor: number;
  readonly itemCount: number;
  readonly netAmountMinor: number;
}

export interface ReconciliationCompletedEvent extends OperationalEventBase {
  readonly eventType: 'reconciliation.completed.v1';
  readonly importId: string;
  readonly matchedExactCount: number;
  readonly mismatchCount: number;
  readonly unexplainedDifferenceMinorByCurrency: Readonly<{ ETB: number; USD: number }>;
}

export type DomainEvent =
  PaymentDomainEvent | ReconciliationCompletedEvent | SettlementFinalizedEvent;
export type DomainEventType = DomainEvent['eventType'];

export interface PaymentCreatedEventInput {
  readonly amountMinor: number;
  readonly currency: 'ETB' | 'USD';
  readonly merchantId: string;
  readonly paymentId: string;
  readonly requestId: string;
}

export interface PaymentCapturedEventInput {
  readonly availableOn: Date;
  readonly capturedAmountMinor: number;
  readonly currency: 'ETB' | 'USD';
  readonly ledgerTransactionId: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly requestId: string;
}

export interface PaymentRefundedEventInput {
  readonly amountMinor: number;
  readonly cumulativeRefundedAmountMinor: number;
  readonly currency: 'ETB' | 'USD';
  readonly ledgerTransactionId: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly refundId: string;
  readonly requestId: string;
}

export interface OutboxRepository {
  insertDomainEvent(transaction: PrismaTransactionClient, event: DomainEvent): Promise<void>;
  insertPaymentEvent(
    transaction: PrismaTransactionClient,
    event: PaymentDomainEvent,
  ): Promise<void>;
}
