import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';

import type {
  OutboxRepository,
  PaymentCreatedEvent,
  PaymentCreatedEventInput,
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
      eventId: `evt_${this.identifiers.generate(occurredAt.getTime())}`,
      eventType: 'payment.created.v1',
      merchantId: input.merchantId,
      occurredAt,
      paymentId: input.paymentId,
      requestId: input.requestId,
      status: 'CREATED',
    };
  }

  public persistPaymentCreated(
    transaction: PrismaTransactionClient,
    event: PaymentCreatedEvent,
  ): Promise<void> {
    return this.repository.insertPaymentCreated(transaction, event);
  }
}
