import type { PrismaTransactionClient } from '@settleflow/infrastructure';

import { WebhookDeliveryIdentifierCollisionError } from './webhook.errors';
import { PrismaWebhookProjectionRepository } from './prisma-webhook-projection.repository';
import type {
  CreateWebhookDeliveryProjectionInput,
  CreateWebhookEventProjectionInput,
} from './webhook.types';

interface ProjectionRepositoryHarness {
  readonly repository: PrismaWebhookProjectionRepository;
  readonly transaction: {
    readonly webhookDelivery: { readonly createMany: jest.Mock };
    readonly webhookEndpoint: { readonly findMany: jest.Mock };
    readonly webhookEventProjection: {
      readonly create: jest.Mock;
      readonly findUnique: jest.Mock;
    };
  };
  readonly tx: PrismaTransactionClient;
}

describe('PrismaWebhookProjectionRepository', () => {
  const occurredAt = new Date('2026-08-03T10:00:00.000Z');
  const event: CreateWebhookEventProjectionInput = {
    aggregateId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    aggregateType: 'payment_intent',
    amountMinor: 1_000n,
    currency: 'ETB',
    eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    eventType: 'payment.created.v1',
    merchantId: '00000000-0000-4000-8000-000000000001',
    occurredAt,
    payloadBytes: Buffer.from('{}'),
    payloadSha256: Buffer.alloc(32, 7),
    paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    paymentStatus: 'CREATED',
    projectedAt: occurredAt,
    requestId: 'req_projection',
    schemaVersion: 1,
  };
  const delivery: CreateWebhookDeliveryProjectionInput = {
    endpointId: '00000000-0000-4000-8000-000000000002',
    eventId: event.eventId,
    id: '00000000-0000-4000-8000-000000000003',
    merchantId: event.merchantId,
    projectedAt: occurredAt,
    publicId: 'whd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  };

  function harness(): ProjectionRepositoryHarness {
    const transaction = {
      webhookDelivery: { createMany: jest.fn() },
      webhookEndpoint: { findMany: jest.fn() },
      webhookEventProjection: { create: jest.fn(), findUnique: jest.fn() },
    };
    return {
      repository: new PrismaWebhookProjectionRepository(),
      transaction,
      tx: transaction as unknown as PrismaTransactionClient,
    };
  }

  it('returns absent events and losslessly maps nullable and populated projections', async () => {
    const h = harness();
    h.transaction.webhookEventProjection.findUnique.mockResolvedValueOnce(null);
    await expect(h.repository.findEvent(h.tx, event.eventId)).resolves.toBeUndefined();

    const base = {
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      eventId: event.eventId,
      eventType: event.eventType,
      merchantId: event.merchantId,
      occurredAt,
      payloadBytes: event.payloadBytes,
      payloadSha256: event.payloadSha256,
      requestId: event.requestId,
      schemaVersion: 1,
    };
    h.transaction.webhookEventProjection.findUnique
      .mockResolvedValueOnce({
        ...base,
        amountMinor: null,
        availableOn: null,
        cumulativeRefundedAmountMinor: null,
        currency: null,
        ledgerTransactionId: null,
        paymentId: null,
        paymentStatus: null,
        refundId: null,
      })
      .mockResolvedValueOnce({
        ...base,
        amountMinor: 1_000n,
        availableOn: occurredAt,
        cumulativeRefundedAmountMinor: 500n,
        currency: 'ETB',
        ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        paymentId: event.paymentId,
        paymentStatus: 'CREATED',
        refundId: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      });
    await expect(h.repository.findEvent(h.tx, event.eventId)).resolves.toMatchObject({
      amountMinor: undefined,
      paymentId: undefined,
    });
    await expect(h.repository.findEvent(h.tx, event.eventId)).resolves.toMatchObject({
      amountMinor: 1_000n,
      paymentId: event.paymentId,
    });
  });

  it('selects only eligible endpoint IDs in stable order', async () => {
    const h = harness();
    h.transaction.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'endpoint-1' },
      { id: 'endpoint-2' },
    ]);
    await expect(
      h.repository.findEligibleEndpointIds(h.tx, event.merchantId, event.eventType),
    ).resolves.toEqual(['endpoint-1', 'endpoint-2']);
    const findCalls = h.transaction.webhookEndpoint.findMany.mock
      .calls as readonly (readonly unknown[])[];
    const findInput = findCalls[0]?.[0] as {
      readonly orderBy?: unknown;
      readonly where?: { readonly merchantId?: unknown; readonly status?: unknown };
    };
    expect(findInput.orderBy).toEqual({ id: 'asc' });
    expect(findInput.where).toMatchObject({ merchantId: event.merchantId, status: 'ACTIVE' });
  });

  it('persists exact event bytes and conditionally creates pending deliveries', async () => {
    const h = harness();
    h.transaction.webhookEventProjection.create.mockResolvedValue({ eventId: event.eventId });
    await h.repository.create(h.tx, event, []);
    expect(h.transaction.webhookDelivery.createMany).not.toHaveBeenCalled();

    await h.repository.create(h.tx, event, [delivery]);
    const eventCalls = h.transaction.webhookEventProjection.create.mock
      .calls as readonly (readonly unknown[])[];
    const eventInput = eventCalls.at(-1)?.[0] as {
      readonly data?: {
        readonly amountMinor?: unknown;
        readonly payloadBytes?: unknown;
        readonly payloadSha256?: unknown;
      };
    };
    expect(eventInput.data).toMatchObject({
      amountMinor: 1_000n,
      payloadBytes: Uint8Array.from(event.payloadBytes),
      payloadSha256: Uint8Array.from(event.payloadSha256),
    });
    const deliveryCalls = h.transaction.webhookDelivery.createMany.mock
      .calls as readonly (readonly unknown[])[];
    const deliveryInput = deliveryCalls[0]?.[0] as {
      readonly data?: readonly {
        readonly attemptCount?: unknown;
        readonly publicId?: unknown;
        readonly status?: unknown;
      }[];
    };
    expect(deliveryInput.data?.[0]).toMatchObject({
      attemptCount: 0,
      publicId: delivery.publicId,
      status: 'PENDING',
    });
  });

  it.each(['webhook_deliveries_public_id_key', 'public_id', 'publicId'])(
    'maps public delivery identifier constraint %s',
    async (constraint) => {
      const h = harness();
      h.transaction.webhookEventProjection.create.mockRejectedValue({ constraint });
      await expect(h.repository.create(h.tx, event, [delivery])).rejects.toBeInstanceOf(
        WebhookDeliveryIdentifierCollisionError,
      );
    },
  );

  it('preserves unrelated database failures', async () => {
    const h = harness();
    const failure = { constraint: 'other_constraint' };
    h.transaction.webhookEventProjection.create.mockRejectedValue(failure);
    await expect(h.repository.create(h.tx, event, [delivery])).rejects.toBe(failure);
  });
});
