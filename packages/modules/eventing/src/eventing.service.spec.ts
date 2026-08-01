import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';

import { EventingService } from './eventing.service';
import type { OutboxRepository } from './eventing.types';
import { prismaOutboxRepositoryInternals } from './prisma-outbox.repository';

describe('EventingService', () => {
  it('builds the approved flat nine-field payment.created.v1 contract', async () => {
    const repository: jest.Mocked<OutboxRepository> = {
      insertPaymentCreated: jest.fn().mockResolvedValue(undefined),
    };
    const identifiers = {
      generate: jest.fn().mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    } as unknown as MonotonicUlidGenerator;
    const service = new EventingService(repository, identifiers);
    const occurredAt = new Date('2026-08-01T10:20:12.345Z');

    const event = service.createPaymentCreatedEvent(
      {
        amountMinor: 125_000,
        currency: 'ETB',
        merchantId: 'merchant-id',
        paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        requestId: 'req_test',
      },
      occurredAt,
    );

    expect(event.eventId).toBe('evt_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(prismaOutboxRepositoryInternals.toPayload(event)).toEqual({
      amountMinor: 125_000,
      currency: 'ETB',
      eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      eventType: 'payment.created.v1',
      merchantId: 'merchant-id',
      occurredAt: '2026-08-01T10:20:12.345Z',
      paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_test',
      status: 'CREATED',
    });

    const transaction = {} as PrismaTransactionClient;
    await service.persistPaymentCreated(transaction, event);
    expect(repository.insertPaymentCreated.mock.calls[0]).toEqual([transaction, event]);
  });
});
