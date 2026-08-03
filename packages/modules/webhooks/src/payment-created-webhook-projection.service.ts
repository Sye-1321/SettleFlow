import { randomUUID } from 'node:crypto';

import {
  InboxService,
  type InboxProcessingResult,
  type ValidatedDomainEventMessage,
  type ValidatedPaymentEventMessage,
} from '@settleflow/eventing';
import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  WebhookDeliveryIdentifierCollisionError,
  WebhookDeliveryIdentifierGenerationExhaustedError,
  WebhookEventProjectionConflictError,
} from './webhook.errors';
import type {
  CreateWebhookEventProjectionInput,
  WebhookEventProjectionRecord,
  WebhookProjectionRepository,
} from './webhook.types';

const MAX_IDENTIFIER_ATTEMPTS = 3;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function eventMatches(
  existing: WebhookEventProjectionRecord,
  message: ValidatedDomainEventMessage,
): boolean {
  const event = message.event;
  const common =
    existing.eventId === event.eventId &&
    existing.eventType === event.eventType &&
    existing.schemaVersion === message.schemaVersion &&
    existing.merchantId === event.merchantId &&
    (existing.aggregateId ?? existing.paymentId) ===
      ('paymentId' in event
        ? String(event.paymentId)
        : event.eventType === 'settlement.finalized.v1'
          ? String(event['batchId'])
          : String(event['importId'])) &&
    existing.occurredAt.getTime() === event.occurredAt.getTime() &&
    existing.requestId === event.requestId &&
    bytesEqual(existing.payloadBytes, message.payloadBytes) &&
    bytesEqual(existing.payloadSha256, message.payloadSha256);
  if (!common) return false;
  if (
    event.eventType === 'settlement.finalized.v1' ||
    event.eventType === 'reconciliation.completed.v1'
  )
    return true;
  const paymentEvent = (message as ValidatedPaymentEventMessage).event;
  if (existing.paymentId !== paymentEvent.paymentId || existing.currency !== paymentEvent.currency)
    return false;
  if (paymentEvent.eventType === 'payment.created.v1') {
    return (
      existing.amountMinor === BigInt(paymentEvent.amountMinor) &&
      existing.paymentStatus === 'CREATED'
    );
  }
  if (paymentEvent.eventType === 'payment.captured.v1') {
    return (
      existing.amountMinor === BigInt(paymentEvent.capturedAmountMinor) &&
      existing.availableOn?.getTime() === paymentEvent.availableOn.getTime() &&
      existing.ledgerTransactionId === paymentEvent.ledgerTransactionId
    );
  }
  return (
    existing.amountMinor === BigInt(paymentEvent.amountMinor) &&
    existing.cumulativeRefundedAmountMinor === BigInt(paymentEvent.cumulativeRefundedAmountMinor) &&
    existing.refundId === paymentEvent.refundId &&
    existing.ledgerTransactionId === paymentEvent.ledgerTransactionId
  );
}

function projectionInput(
  message: ValidatedDomainEventMessage,
  projectedAt: Date,
): CreateWebhookEventProjectionInput {
  const event = message.event;
  if (
    event.eventType === 'settlement.finalized.v1' ||
    event.eventType === 'reconciliation.completed.v1'
  ) {
    const aggregateId =
      event.eventType === 'settlement.finalized.v1'
        ? String(event['batchId'])
        : String(event['importId']);
    return {
      aggregateId,
      aggregateType:
        event.eventType === 'settlement.finalized.v1'
          ? 'settlement_batch'
          : 'reconciliation_import',
      eventId: event.eventId,
      eventType: event.eventType,
      merchantId: event.merchantId,
      occurredAt: event.occurredAt,
      payloadBytes: message.payloadBytes,
      payloadSha256: message.payloadSha256,
      projectedAt,
      requestId: event.requestId,
      schemaVersion: 1,
    };
  }
  const paymentEvent = (message as ValidatedPaymentEventMessage).event;
  const common = {
    aggregateId: paymentEvent.paymentId,
    aggregateType: 'payment_intent' as const,
    currency: paymentEvent.currency,
    eventId: paymentEvent.eventId,
    eventType: paymentEvent.eventType,
    merchantId: paymentEvent.merchantId,
    occurredAt: paymentEvent.occurredAt,
    payloadBytes: message.payloadBytes,
    payloadSha256: message.payloadSha256,
    paymentId: paymentEvent.paymentId,
    projectedAt,
    requestId: paymentEvent.requestId,
    schemaVersion: 1 as const,
  };
  if (paymentEvent.eventType === 'payment.created.v1') {
    return {
      ...common,
      amountMinor: BigInt(paymentEvent.amountMinor),
      paymentStatus: 'CREATED',
    };
  }
  if (paymentEvent.eventType === 'payment.captured.v1') {
    return {
      ...common,
      amountMinor: BigInt(paymentEvent.capturedAmountMinor),
      availableOn: paymentEvent.availableOn,
      ledgerTransactionId: paymentEvent.ledgerTransactionId,
    };
  }
  return {
    ...common,
    amountMinor: BigInt(paymentEvent.amountMinor),
    cumulativeRefundedAmountMinor: BigInt(paymentEvent.cumulativeRefundedAmountMinor),
    ledgerTransactionId: paymentEvent.ledgerTransactionId,
    refundId: paymentEvent.refundId,
  };
}

export interface WebhookProjectionResult {
  readonly alreadyProjected: boolean;
  readonly deliveryCount: number;
}

export type WebhookProjectionProcessingResult = InboxProcessingResult<WebhookProjectionResult>;

/** Handles the created/captured/refunded payment event family. */
export class PaymentCreatedWebhookProjectionService {
  public constructor(
    private readonly inbox: InboxService,
    private readonly repository: WebhookProjectionRepository,
    private readonly identifiers: MonotonicUlidGenerator,
    private readonly uuid: () => string = randomUUID,
  ) {}

  public async handle(
    message: ValidatedDomainEventMessage,
  ): Promise<WebhookProjectionProcessingResult> {
    for (let attempt = 1; attempt <= MAX_IDENTIFIER_ATTEMPTS; attempt += 1) {
      try {
        return await this.inbox.process(message, (context, validated) =>
          this.project(context.transaction, context.processedAt, validated),
        );
      } catch (error: unknown) {
        if (error instanceof WebhookDeliveryIdentifierCollisionError) {
          if (attempt < MAX_IDENTIFIER_ATTEMPTS) continue;
          throw new WebhookDeliveryIdentifierGenerationExhaustedError();
        }
        throw error;
      }
    }
    throw new WebhookDeliveryIdentifierGenerationExhaustedError();
  }

  private async project(
    transaction: PrismaTransactionClient,
    projectedAt: Date,
    message: ValidatedDomainEventMessage,
  ): Promise<WebhookProjectionResult> {
    const existing = await this.repository.findEvent(transaction, message.event.eventId);
    if (existing !== undefined) {
      if (!eventMatches(existing, message)) throw new WebhookEventProjectionConflictError();
      return { alreadyProjected: true, deliveryCount: 0 };
    }

    const endpointIds = await this.repository.findEligibleEndpointIds(
      transaction,
      message.event.merchantId,
      message.event.eventType,
    );
    const deliveries = endpointIds.map((endpointId) => ({
      endpointId,
      eventId: message.event.eventId,
      id: this.uuid(),
      merchantId: message.event.merchantId,
      projectedAt,
      publicId: `whd_${this.identifiers.generate(projectedAt.getTime())}`,
    }));
    await this.repository.create(transaction, projectionInput(message, projectedAt), deliveries);
    return { alreadyProjected: false, deliveryCount: deliveries.length };
  }
}

export const paymentCreatedWebhookProjectionServiceInternals = {
  MAX_IDENTIFIER_ATTEMPTS,
  bytesEqual,
  eventMatches,
  projectionInput,
};
