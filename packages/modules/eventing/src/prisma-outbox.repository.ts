import { findDatabaseConstraint, type PrismaTransactionClient } from '@settleflow/infrastructure';

import { EventIdentifierCollisionError } from './eventing.errors';
import type { OutboxRepository, PaymentDomainEvent } from './eventing.types';

function toPayload(event: PaymentDomainEvent): Readonly<Record<string, string | number>> {
  const common = {
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt.toISOString(),
    requestId: event.requestId,
    merchantId: event.merchantId,
    paymentId: event.paymentId,
  };
  if (event.eventType === 'payment.created.v1') {
    return {
      ...common,
      amountMinor: event.amountMinor,
      currency: event.currency,
      status: event.status,
    };
  }
  if (event.eventType === 'payment.captured.v1') {
    return {
      ...common,
      capturedAmountMinor: event.capturedAmountMinor,
      currency: event.currency,
      availableOn: event.availableOn.toISOString(),
      ledgerTransactionId: event.ledgerTransactionId,
    };
  }
  return {
    ...common,
    refundId: event.refundId,
    amountMinor: event.amountMinor,
    currency: event.currency,
    cumulativeRefundedAmountMinor: event.cumulativeRefundedAmountMinor,
    ledgerTransactionId: event.ledgerTransactionId,
  };
}

export class PrismaOutboxRepository implements OutboxRepository {
  public async insertPaymentEvent(
    transaction: PrismaTransactionClient,
    event: PaymentDomainEvent,
  ): Promise<void> {
    try {
      await transaction.outboxEvent.create({
        data: {
          aggregateId: event.paymentId,
          aggregateType: 'payment_intent',
          eventId: event.eventId,
          eventType: event.eventType,
          merchantId: event.merchantId,
          occurredAt: event.occurredAt,
          payload: toPayload(event),
          requestId: event.requestId,
        },
      });
    } catch (error: unknown) {
      const constraint = findDatabaseConstraint(error);
      if (
        constraint === 'outbox_events_event_id_key' ||
        constraint === 'event_id' ||
        constraint === 'eventId'
      ) {
        throw new EventIdentifierCollisionError();
      }
      throw error;
    }
  }
}

export const prismaOutboxRepositoryInternals = { toPayload };
