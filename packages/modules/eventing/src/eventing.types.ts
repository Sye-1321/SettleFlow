import type { PrismaTransactionClient } from '@settleflow/infrastructure';

export interface PaymentCreatedEvent {
  readonly amountMinor: number;
  readonly currency: 'ETB' | 'USD';
  readonly eventId: string;
  readonly eventType: 'payment.created.v1';
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly paymentId: string;
  readonly requestId: string;
  readonly status: 'CREATED';
}

export interface PaymentCreatedEventInput {
  readonly amountMinor: number;
  readonly currency: 'ETB' | 'USD';
  readonly merchantId: string;
  readonly paymentId: string;
  readonly requestId: string;
}

export interface OutboxRepository {
  insertPaymentCreated(
    transaction: PrismaTransactionClient,
    event: PaymentCreatedEvent,
  ): Promise<void>;
}
