import type {
  InboxEffect,
  InboxProcessingResult,
  InboxService,
  ValidatedOperationalEventMessage,
  ValidatedPaymentCreatedMessage,
} from '@settleflow/eventing';
import type { MonotonicUlidGenerator, PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  WebhookDeliveryIdentifierCollisionError,
  WebhookDeliveryIdentifierGenerationExhaustedError,
  WebhookEventProjectionConflictError,
} from './webhook.errors';
import { PaymentCreatedWebhookProjectionService } from './payment-created-webhook-projection.service';
import type { WebhookProjectionRepository } from './webhook.types';

const PROJECTED_AT = new Date('2026-08-02T12:00:00.000Z');
const PAYLOAD = Buffer.from(
  '{"eventId":"evt_01ARZ3NDEKTSV4RRFFQ69G5FAV","eventType":"payment.created.v1"}',
);
const HASH = Buffer.alloc(32, 9);

function createMessage(): ValidatedPaymentCreatedMessage {
  return {
    event: {
      amountMinor: 25_000,
      currency: 'ETB',
      eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      eventType: 'payment.created.v1',
      merchantId: '11111111-1111-4111-8111-111111111111',
      occurredAt: new Date('2026-08-02T11:59:00.000Z'),
      paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_projection_test',
      status: 'CREATED',
    },
    payloadBytes: PAYLOAD,
    payloadSha256: HASH,
    publishAttempt: 1,
    redelivered: false,
    schemaVersion: 1,
  };
}

function createOperationalMessage(
  eventType: 'reconciliation.completed.v1' | 'settlement.finalized.v1',
): ValidatedOperationalEventMessage {
  const common = {
    eventId:
      eventType === 'settlement.finalized.v1'
        ? 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAA'
        : 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAB',
    eventType,
    merchantId: '11111111-1111-4111-8111-111111111111',
    occurredAt: new Date('2026-08-02T11:59:00.000Z'),
    requestId: 'req_projection_test',
  } as const;
  const event =
    eventType === 'settlement.finalized.v1'
      ? {
          ...common,
          batchId: 'stb_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          currency: 'ETB',
          cutoffAt: new Date('2026-08-02T08:00:00.000Z'),
          feeAmountMinor: 1_100,
          grossAmountMinor: 25_000,
          itemCount: 1,
          netAmountMinor: 23_900,
        }
      : {
          ...common,
          importId: 'rec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          matchedExactCount: 1,
          mismatchCount: 0,
          unexplainedDifferenceMinorByCurrency: { ETB: 0, USD: 0 },
        };
  const payloadBytes = Buffer.from(JSON.stringify(event));
  return {
    event,
    payloadBytes,
    payloadSha256: Buffer.alloc(32, eventType === 'settlement.finalized.v1' ? 7 : 8),
    redelivered: false,
    schemaVersion: 1,
  };
}

function createInbox(): InboxService {
  const process = async <T>(
    message: ValidatedPaymentCreatedMessage,
    effect: InboxEffect<T>,
  ): Promise<InboxProcessingResult<T>> => ({
    kind: 'processed',
    value: await effect(
      { processedAt: PROJECTED_AT, transaction: {} as PrismaTransactionClient },
      message,
    ),
  });
  return { process: jest.fn(process) } as unknown as InboxService;
}

function createRepository(
  overrides: Partial<WebhookProjectionRepository> = {},
): WebhookProjectionRepository {
  return {
    create: jest.fn().mockResolvedValue(undefined),
    findEligibleEndpointIds: jest.fn().mockResolvedValue(['endpoint-a', 'endpoint-b']),
    findEvent: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createIdentifiers(): MonotonicUlidGenerator {
  return {
    generate: jest.fn().mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  } as unknown as MonotonicUlidGenerator;
}

describe('PaymentCreatedWebhookProjectionService', () => {
  it('creates one pending projection per eligible endpoint with one database timestamp', async () => {
    const repository = createRepository();
    const uuid = jest
      .fn()
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333');
    const service = new PaymentCreatedWebhookProjectionService(
      createInbox(),
      repository,
      createIdentifiers(),
      uuid,
    );

    await expect(service.handle(createMessage())).resolves.toEqual({
      kind: 'processed',
      value: { alreadyProjected: false, deliveryCount: 2 },
    });
    expect((repository.findEligibleEndpointIds as jest.Mock).mock.calls).toEqual([
      [expect.anything(), '11111111-1111-4111-8111-111111111111', 'payment.created.v1'],
    ]);
    expect((repository.create as jest.Mock).mock.calls).toEqual([
      [
        expect.anything(),
        expect.objectContaining({
          amountMinor: 25_000n,
          payloadBytes: PAYLOAD,
          payloadSha256: HASH,
          projectedAt: PROJECTED_AT,
        }),
        [
          expect.objectContaining({ endpointId: 'endpoint-a', projectedAt: PROJECTED_AT }),
          expect.objectContaining({ endpointId: 'endpoint-b', projectedAt: PROJECTED_AT }),
        ],
      ],
    ]);
  });

  it('persists the event marker when no endpoint is eligible', async () => {
    const repository = createRepository({
      findEligibleEndpointIds: jest.fn().mockResolvedValue([]),
    });

    await expect(
      new PaymentCreatedWebhookProjectionService(
        createInbox(),
        repository,
        createIdentifiers(),
      ).handle(createMessage()),
    ).resolves.toEqual({
      kind: 'processed',
      value: { alreadyProjected: false, deliveryCount: 0 },
    });
    expect((repository.create as jest.Mock).mock.calls).toEqual([
      [expect.anything(), expect.anything(), []],
    ]);
  });

  it.each([
    ['settlement.finalized.v1', 'stb_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'settlement_batch'],
    ['reconciliation.completed.v1', 'rec_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'reconciliation_import'],
  ] as const)(
    'projects %s using its operational aggregate and exact validated bytes',
    async (eventType, aggregateId, aggregateType) => {
      const repository = createRepository();
      const message = createOperationalMessage(eventType);
      const service = new PaymentCreatedWebhookProjectionService(
        createInbox(),
        repository,
        createIdentifiers(),
      );

      await expect(service.handle(message)).resolves.toEqual({
        kind: 'processed',
        value: { alreadyProjected: false, deliveryCount: 2 },
      });
      expect((repository.findEligibleEndpointIds as jest.Mock).mock.calls).toEqual([
        [expect.anything(), message.event.merchantId, eventType],
      ]);
      expect((repository.create as jest.Mock).mock.calls).toEqual([
        [
          expect.anything(),
          expect.objectContaining({
            aggregateId,
            aggregateType,
            eventType,
            payloadBytes: message.payloadBytes,
            payloadSha256: message.payloadSha256,
          }),
          expect.any(Array),
        ],
      ]);
    },
  );

  it('uses the retained marker as a matching fallback and rejects a conflicting marker', async () => {
    const message = createMessage();
    const matching = {
      amountMinor: 25_000n,
      currency: 'ETB',
      eventId: message.event.eventId,
      eventType: message.event.eventType,
      merchantId: message.event.merchantId,
      occurredAt: message.event.occurredAt,
      payloadBytes: PAYLOAD,
      payloadSha256: HASH,
      paymentId: message.event.paymentId,
      paymentStatus: message.event.status,
      requestId: message.event.requestId,
      schemaVersion: 1,
    };
    const repository = createRepository({ findEvent: jest.fn().mockResolvedValue(matching) });
    const service = new PaymentCreatedWebhookProjectionService(
      createInbox(),
      repository,
      createIdentifiers(),
    );

    await expect(service.handle(message)).resolves.toEqual({
      kind: 'processed',
      value: { alreadyProjected: true, deliveryCount: 0 },
    });
    expect((repository.create as jest.Mock).mock.calls).toHaveLength(0);

    (repository.findEvent as jest.Mock).mockResolvedValue({ ...matching, currency: 'USD' });
    await expect(service.handle(message)).rejects.toBeInstanceOf(
      WebhookEventProjectionConflictError,
    );
  });

  it('regenerates the complete delivery batch at most three times on public-ID collision', async () => {
    const repository = createRepository({
      create: jest.fn().mockRejectedValue(new WebhookDeliveryIdentifierCollisionError()),
    });
    const identifiers = createIdentifiers();
    const service = new PaymentCreatedWebhookProjectionService(
      createInbox(),
      repository,
      identifiers,
    );

    await expect(service.handle(createMessage())).rejects.toBeInstanceOf(
      WebhookDeliveryIdentifierGenerationExhaustedError,
    );
    expect((repository.create as jest.Mock).mock.calls).toHaveLength(3);
    expect((identifiers.generate as jest.Mock).mock.calls).toHaveLength(6);
  });
});
