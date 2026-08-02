import { randomUUID } from 'node:crypto';

import {
  InboxService,
  type InboxProcessingResult,
  type ValidatedPaymentCreatedMessage,
} from '@settleflow/eventing';
import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  WebhookDeliveryIdentifierCollisionError,
  WebhookDeliveryIdentifierGenerationExhaustedError,
  WebhookEventProjectionConflictError,
} from './webhook.errors';
import type { WebhookEventProjectionRecord, WebhookProjectionRepository } from './webhook.types';

const MAX_IDENTIFIER_ATTEMPTS = 3;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function eventMatches(
  existing: WebhookEventProjectionRecord,
  message: ValidatedPaymentCreatedMessage,
): boolean {
  const event = message.event;
  return (
    existing.eventId === event.eventId &&
    existing.eventType === event.eventType &&
    existing.schemaVersion === message.schemaVersion &&
    existing.merchantId === event.merchantId &&
    existing.paymentId === event.paymentId &&
    existing.occurredAt.getTime() === event.occurredAt.getTime() &&
    existing.requestId === event.requestId &&
    existing.amountMinor === BigInt(event.amountMinor) &&
    existing.currency === event.currency &&
    existing.paymentStatus === event.status &&
    bytesEqual(existing.payloadBytes, message.payloadBytes) &&
    bytesEqual(existing.payloadSha256, message.payloadSha256)
  );
}

export interface WebhookProjectionResult {
  readonly alreadyProjected: boolean;
  readonly deliveryCount: number;
}

export type WebhookProjectionProcessingResult = InboxProcessingResult<WebhookProjectionResult>;

export class PaymentCreatedWebhookProjectionService {
  public constructor(
    private readonly inbox: InboxService,
    private readonly repository: WebhookProjectionRepository,
    private readonly identifiers: MonotonicUlidGenerator,
    private readonly uuid: () => string = randomUUID,
  ) {}

  public async handle(
    message: ValidatedPaymentCreatedMessage,
  ): Promise<WebhookProjectionProcessingResult> {
    for (let attempt = 1; attempt <= MAX_IDENTIFIER_ATTEMPTS; attempt += 1) {
      try {
        return await this.inbox.process(message, (context, validated) =>
          this.project(context.transaction, context.processedAt, validated),
        );
      } catch (error: unknown) {
        if (error instanceof WebhookDeliveryIdentifierCollisionError) {
          if (attempt < MAX_IDENTIFIER_ATTEMPTS) {
            continue;
          }
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
    message: ValidatedPaymentCreatedMessage,
  ): Promise<WebhookProjectionResult> {
    const existing = await this.repository.findEvent(transaction, message.event.eventId);
    if (existing !== undefined) {
      if (!eventMatches(existing, message)) {
        throw new WebhookEventProjectionConflictError();
      }
      return { alreadyProjected: true, deliveryCount: 0 };
    }

    const endpointIds = await this.repository.findEligibleEndpointIds(
      transaction,
      message.event.merchantId,
    );
    const deliveries = endpointIds.map((endpointId) => ({
      endpointId,
      eventId: message.event.eventId,
      id: this.uuid(),
      merchantId: message.event.merchantId,
      projectedAt,
      publicId: `whd_${this.identifiers.generate(projectedAt.getTime())}`,
    }));
    await this.repository.create(
      transaction,
      {
        amountMinor: BigInt(message.event.amountMinor),
        currency: message.event.currency,
        eventId: message.event.eventId,
        eventType: message.event.eventType,
        merchantId: message.event.merchantId,
        occurredAt: message.event.occurredAt,
        payloadBytes: message.payloadBytes,
        payloadSha256: message.payloadSha256,
        paymentId: message.event.paymentId,
        paymentStatus: message.event.status,
        projectedAt,
        requestId: message.event.requestId,
        schemaVersion: message.schemaVersion,
      },
      deliveries,
    );
    return { alreadyProjected: false, deliveryCount: deliveries.length };
  }
}

export const paymentCreatedWebhookProjectionServiceInternals = {
  MAX_IDENTIFIER_ATTEMPTS,
  bytesEqual,
  eventMatches,
};
