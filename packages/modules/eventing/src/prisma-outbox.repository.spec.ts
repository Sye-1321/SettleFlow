import type { PrismaTransactionClient } from '@settleflow/infrastructure';

import { EventIdentifierCollisionError } from './eventing.errors';
import type { PaymentCreatedEvent } from './eventing.types';
import { PrismaOutboxRepository } from './prisma-outbox.repository';

describe('PrismaOutboxRepository', () => {
  const event: PaymentCreatedEvent = {
    amountMinor: 1_000,
    currency: 'ETB',
    eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    eventType: 'payment.created.v1',
    merchantId: '00000000-0000-4000-8000-000000000001',
    occurredAt: new Date('2026-08-03T10:00:00.000Z'),
    paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    requestId: 'req_outbox_repository',
    status: 'CREATED',
  };

  function transaction(error?: unknown): PrismaTransactionClient {
    return {
      outboxEvent: {
        create:
          error === undefined
            ? jest.fn().mockResolvedValue({})
            : jest.fn().mockRejectedValue(error),
      },
    } as unknown as PrismaTransactionClient;
  }

  it('persists payment events through the stable payment port', async () => {
    await expect(
      new PrismaOutboxRepository().insertPaymentEvent(transaction(), event),
    ).resolves.toBeUndefined();
  });

  it.each(['outbox_events_event_id_key', 'event_id', 'eventId'])(
    'maps duplicate event identifier constraint %s',
    async (constraint) => {
      await expect(
        new PrismaOutboxRepository().insertDomainEvent(transaction({ constraint }), event),
      ).rejects.toBeInstanceOf(EventIdentifierCollisionError);
    },
  );

  it('preserves unrelated persistence failures', async () => {
    const failure = { constraint: 'other_constraint' };
    await expect(
      new PrismaOutboxRepository().insertDomainEvent(transaction(failure), event),
    ).rejects.toBe(failure);
  });
});
