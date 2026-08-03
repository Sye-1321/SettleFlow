import { findDatabaseConstraint, type PrismaTransactionClient } from '@settleflow/infrastructure';

import { EventIdentifierCollisionError } from './eventing.errors';
import type { DomainEvent, OutboxRepository, PaymentDomainEvent } from './eventing.types';

function toPayload(event: DomainEvent): Readonly<Record<string, unknown>> {
  if (event.eventType === 'settlement.finalized.v1') {
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt.toISOString(),
      requestId: event.requestId,
      merchantId: event.merchantId,
      batchId: event.batchId,
      cutoffAt: event.cutoffAt.toISOString(),
      grossAmountMinor: event.grossAmountMinor,
      feeAmountMinor: event.feeAmountMinor,
      netAmountMinor: event.netAmountMinor,
      currency: event.currency,
      itemCount: event.itemCount,
    };
  }
  if (event.eventType === 'reconciliation.completed.v1') {
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt.toISOString(),
      requestId: event.requestId,
      merchantId: event.merchantId,
      importId: event.importId,
      matchedExactCount: event.matchedExactCount,
      mismatchCount: event.mismatchCount,
      unexplainedDifferenceMinorByCurrency: event.unexplainedDifferenceMinorByCurrency,
    };
  }
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
    return this.insertDomainEvent(transaction, event);
  }

  public async insertDomainEvent(
    transaction: PrismaTransactionClient,
    event: DomainEvent,
  ): Promise<void> {
    try {
      const aggregate =
        event.eventType === 'settlement.finalized.v1'
          ? { id: event.batchId, type: 'settlement_batch' }
          : event.eventType === 'reconciliation.completed.v1'
            ? { id: event.importId, type: 'reconciliation_import' }
            : { id: event.paymentId, type: 'payment_intent' };
      await transaction.outboxEvent.create({
        data: {
          aggregateId: aggregate.id,
          aggregateType: aggregate.type,
          eventId: event.eventId,
          eventType: event.eventType,
          merchantId: event.merchantId,
          occurredAt: event.occurredAt,
          payload: toPayload(event) as never,
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
