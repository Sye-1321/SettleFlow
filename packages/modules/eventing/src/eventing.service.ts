import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';

import type {
  OutboxRepository,
  PaymentCapturedEvent,
  PaymentCapturedEventInput,
  PaymentCreatedEvent,
  PaymentCreatedEventInput,
  PaymentDomainEvent,
  PaymentRefundedEvent,
  PaymentRefundedEventInput,
  ReconciliationCompletedEvent,
  SettlementFinalizedEvent,
} from './eventing.types';

export class EventingService {
  public constructor(
    private readonly repository: OutboxRepository,
    private readonly identifiers: MonotonicUlidGenerator,
  ) {}

  public createPaymentCreatedEvent(
    input: PaymentCreatedEventInput,
    occurredAt: Date,
  ): PaymentCreatedEvent {
    return {
      amountMinor: input.amountMinor,
      currency: input.currency,
      eventId: this.eventId(occurredAt),
      eventType: 'payment.created.v1',
      merchantId: input.merchantId,
      occurredAt,
      paymentId: input.paymentId,
      requestId: input.requestId,
      status: 'CREATED',
    };
  }

  public createPaymentCapturedEvent(
    input: PaymentCapturedEventInput,
    occurredAt: Date,
  ): PaymentCapturedEvent {
    return {
      availableOn: input.availableOn,
      capturedAmountMinor: input.capturedAmountMinor,
      currency: input.currency,
      eventId: this.eventId(occurredAt),
      eventType: 'payment.captured.v1',
      ledgerTransactionId: input.ledgerTransactionId,
      merchantId: input.merchantId,
      occurredAt,
      paymentId: input.paymentId,
      requestId: input.requestId,
    };
  }

  public createPaymentRefundedEvent(
    input: PaymentRefundedEventInput,
    occurredAt: Date,
  ): PaymentRefundedEvent {
    return {
      amountMinor: input.amountMinor,
      cumulativeRefundedAmountMinor: input.cumulativeRefundedAmountMinor,
      currency: input.currency,
      eventId: this.eventId(occurredAt),
      eventType: 'payment.refunded.v1',
      ledgerTransactionId: input.ledgerTransactionId,
      merchantId: input.merchantId,
      occurredAt,
      paymentId: input.paymentId,
      refundId: input.refundId,
      requestId: input.requestId,
    };
  }

  public persistPaymentCreated(
    transaction: PrismaTransactionClient,
    event: PaymentCreatedEvent,
  ): Promise<void> {
    return this.persistPaymentEvent(transaction, event);
  }

  public persistPaymentEvent(
    transaction: PrismaTransactionClient,
    event: PaymentDomainEvent,
  ): Promise<void> {
    return this.repository.insertPaymentEvent(transaction, event);
  }

  public createSettlementFinalizedEvent(
    input: Omit<SettlementFinalizedEvent, 'eventId' | 'eventType' | 'occurredAt'>,
    occurredAt: Date,
  ): SettlementFinalizedEvent {
    return {
      ...input,
      eventId: this.eventId(occurredAt),
      eventType: 'settlement.finalized.v1',
      occurredAt,
    };
  }

  public createReconciliationCompletedEvent(
    input: Omit<ReconciliationCompletedEvent, 'eventId' | 'eventType' | 'occurredAt'>,
    occurredAt: Date,
  ): ReconciliationCompletedEvent {
    return {
      ...input,
      eventId: this.eventId(occurredAt),
      eventType: 'reconciliation.completed.v1',
      occurredAt,
    };
  }

  public persistDomainEvent(
    transaction: PrismaTransactionClient,
    event: ReconciliationCompletedEvent | SettlementFinalizedEvent,
  ): Promise<void> {
    return this.repository.insertDomainEvent(transaction, event);
  }

  private eventId(occurredAt: Date): string {
    return `evt_${this.identifiers.generate(occurredAt.getTime())}`;
  }
}
