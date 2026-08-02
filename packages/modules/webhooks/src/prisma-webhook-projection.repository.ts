import { findDatabaseConstraint, type PrismaTransactionClient } from '@settleflow/infrastructure';

import { WebhookDeliveryIdentifierCollisionError } from './webhook.errors';
import type {
  CreateWebhookDeliveryProjectionInput,
  CreateWebhookEventProjectionInput,
  WebhookEventProjectionRecord,
  WebhookProjectionRepository,
  WebhookSubscription,
} from './webhook.types';

const projectionSelection = {
  amountMinor: true,
  availableOn: true,
  cumulativeRefundedAmountMinor: true,
  currency: true,
  eventId: true,
  eventType: true,
  ledgerTransactionId: true,
  merchantId: true,
  occurredAt: true,
  payloadBytes: true,
  payloadSha256: true,
  paymentId: true,
  paymentStatus: true,
  refundId: true,
  requestId: true,
  schemaVersion: true,
} as const;

export class PrismaWebhookProjectionRepository implements WebhookProjectionRepository {
  public async findEvent(
    transaction: PrismaTransactionClient,
    eventId: string,
  ): Promise<WebhookEventProjectionRecord | undefined> {
    const record = await transaction.webhookEventProjection.findUnique({
      select: projectionSelection,
      where: { eventId },
    });
    return record === null
      ? undefined
      : {
          ...record,
          availableOn: record.availableOn ?? undefined,
          cumulativeRefundedAmountMinor: record.cumulativeRefundedAmountMinor ?? undefined,
          ledgerTransactionId: record.ledgerTransactionId ?? undefined,
          paymentStatus: record.paymentStatus ?? undefined,
          refundId: record.refundId ?? undefined,
        };
  }

  public async findEligibleEndpointIds(
    transaction: PrismaTransactionClient,
    merchantId: string,
    eventType: WebhookSubscription,
  ): Promise<readonly string[]> {
    const endpoints = await transaction.webhookEndpoint.findMany({
      orderBy: { id: 'asc' },
      select: { id: true },
      where: {
        merchantId,
        status: 'ACTIVE',
        subscriptions: { some: { eventType } },
      },
    });
    return endpoints.map((endpoint) => endpoint.id);
  }

  public async create(
    transaction: PrismaTransactionClient,
    event: CreateWebhookEventProjectionInput,
    deliveries: readonly CreateWebhookDeliveryProjectionInput[],
  ): Promise<void> {
    try {
      await transaction.webhookEventProjection.create({
        data: {
          amountMinor: event.amountMinor,
          availableOn: event.availableOn ?? null,
          cumulativeRefundedAmountMinor: event.cumulativeRefundedAmountMinor ?? null,
          currency: event.currency,
          eventId: event.eventId,
          eventType: event.eventType,
          ledgerTransactionId: event.ledgerTransactionId ?? null,
          merchantId: event.merchantId,
          occurredAt: event.occurredAt,
          payloadBytes: Uint8Array.from(event.payloadBytes),
          payloadSha256: Uint8Array.from(event.payloadSha256),
          paymentId: event.paymentId,
          paymentStatus: event.paymentStatus ?? null,
          projectedAt: event.projectedAt,
          refundId: event.refundId ?? null,
          requestId: event.requestId,
          schemaVersion: event.schemaVersion,
        },
        select: { eventId: true },
      });
      if (deliveries.length > 0) {
        await transaction.webhookDelivery.createMany({
          data: deliveries.map((delivery) => ({
            attemptCount: 0,
            createdAt: delivery.projectedAt,
            endpointId: delivery.endpointId,
            eventId: delivery.eventId,
            id: delivery.id,
            merchantId: delivery.merchantId,
            nextAttemptAt: delivery.projectedAt,
            publicId: delivery.publicId,
            status: 'PENDING',
            updatedAt: delivery.projectedAt,
          })),
        });
      }
    } catch (error: unknown) {
      const constraint = findDatabaseConstraint(error);
      if (
        constraint === 'webhook_deliveries_public_id_key' ||
        constraint === 'public_id' ||
        constraint === 'publicId'
      ) {
        throw new WebhookDeliveryIdentifierCollisionError();
      }
      throw error;
    }
  }
}

export const prismaWebhookProjectionRepositoryInternals = { projectionSelection };
