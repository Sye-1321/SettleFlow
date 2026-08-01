import { findDatabaseConstraint, type PrismaTransactionClient } from '@settleflow/infrastructure';

import { EventIdentifierCollisionError } from './eventing.errors';
import type { OutboxRepository, PaymentCreatedEvent } from './eventing.types';

function toPayload(event: PaymentCreatedEvent): Readonly<Record<string, string | number>> {
  return {
    amountMinor: event.amountMinor,
    currency: event.currency,
    eventId: event.eventId,
    eventType: event.eventType,
    merchantId: event.merchantId,
    occurredAt: event.occurredAt.toISOString(),
    paymentId: event.paymentId,
    requestId: event.requestId,
    status: event.status,
  };
}

export class PrismaOutboxRepository implements OutboxRepository {
  public async insertPaymentCreated(
    transaction: PrismaTransactionClient,
    event: PaymentCreatedEvent,
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
