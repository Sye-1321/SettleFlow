import {
  EventIdentifierCollisionError,
  EventingService,
  type PaymentCreatedEvent,
} from '@settleflow/eventing';
import {
  IdempotencyService,
  type IdempotencyOwnership,
  type IdempotentOperation,
} from '@settleflow/idempotency';
import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  ExternalReferenceConflictError,
  IdentifierGenerationExhaustedError,
  PaymentIdentifierCollisionError,
  PaymentIntentNotFoundError,
} from './payments.errors';
import { PaymentIntentService, paymentIntentServiceInternals } from './payment-intent.service';
import type {
  CreatePaymentIntentCommand,
  PaymentIntentRecord,
  PaymentIntentRepository,
} from './payments.types';

describe('PaymentIntentService', () => {
  const now = new Date('2026-08-01T10:20:12.345Z');
  const command: CreatePaymentIntentCommand = {
    amountMinor: 125_000,
    captureMethod: 'manual',
    currency: 'ETB',
    externalRef: 'order_1001',
    idempotencyKey: 'command-key',
    merchantId: 'merchant-id',
    requestId: 'req_test',
  };
  const paymentId = 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const record: PaymentIntentRecord = {
    amountMinor: 125_000,
    captureMethod: 'manual',
    capturedAmountMinor: 0,
    createdAt: now,
    currency: 'ETB',
    externalRef: 'order_1001',
    merchantId: 'merchant-id',
    paymentStatus: 'created',
    publicId: paymentId,
    refundedAmountMinor: 0,
    updatedAt: now,
    version: 0,
  };

  function createHarness(): {
    readonly eventing: jest.Mocked<EventingService>;
    readonly idempotency: jest.Mocked<IdempotencyService>;
    readonly identifiers: jest.Mocked<MonotonicUlidGenerator>;
    readonly repository: jest.Mocked<PaymentIntentRepository>;
    readonly service: PaymentIntentService;
    readonly transaction: PrismaTransactionClient;
  } {
    const transaction = {} as PrismaTransactionClient;
    const repository: jest.Mocked<PaymentIntentRepository> = {
      create: jest.fn().mockResolvedValue(record),
      findByPublicId: jest.fn().mockResolvedValue(record),
    };
    const event: PaymentCreatedEvent = {
      amountMinor: 125_000,
      currency: 'ETB',
      eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      eventType: 'payment.created.v1',
      merchantId: 'merchant-id',
      occurredAt: now,
      paymentId,
      requestId: 'req_test',
      status: 'CREATED',
    };
    const eventing = {
      createPaymentCreatedEvent: jest.fn().mockReturnValue(event),
      persistPaymentCreated: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<EventingService>;
    const idempotency = {
      acquire: jest.fn().mockResolvedValue({
        kind: 'acquired',
        ownership: { ownerToken: 'owner', recordId: 'record' },
      }),
      complete: jest
        .fn()
        .mockImplementation(
          async <T>(_ownership: IdempotencyOwnership, operation: IdempotentOperation<T>) =>
            (await operation(transaction)).value,
        ),
    } as unknown as jest.Mocked<IdempotencyService>;
    const identifiers = {
      generate: jest.fn().mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    } as unknown as jest.Mocked<MonotonicUlidGenerator>;

    return {
      eventing,
      idempotency,
      identifiers,
      repository,
      service: new PaymentIntentService(repository, idempotency, eventing, identifiers, () => now),
      transaction,
    };
  }

  it('uses the approved canonical fingerprint and one shared completion transaction', async () => {
    const harness = createHarness();

    await expect(harness.service.create(command)).resolves.toEqual({
      amountMinor: 125_000,
      captureMethod: 'manual',
      capturedAmountMinor: 0,
      createdAt: now.toISOString(),
      currency: 'ETB',
      externalRef: 'order_1001',
      id: paymentId,
      paymentStatus: 'created',
      refundedAmountMinor: 0,
      settlementStatus: 'NOT_ELIGIBLE',
      updatedAt: now.toISOString(),
      version: 0,
    });

    expect(harness.idempotency.acquire.mock.calls[0]?.[0]).toEqual({
      canonicalRequest:
        '{"v":1,"externalRef":"order_1001","amountMinor":"125000","currency":"ETB","captureMethod":"manual"}',
      key: 'command-key',
      merchantId: 'merchant-id',
      method: 'POST',
      normalizedRoute: '/v1/payment-intents',
      now,
    });
    expect(harness.repository.create.mock.calls[0]).toEqual([
      harness.transaction,
      expect.objectContaining({ merchantId: 'merchant-id', publicId: paymentId }),
    ]);
    expect(harness.eventing.persistPaymentCreated.mock.calls[0]).toEqual([
      harness.transaction,
      expect.objectContaining({ eventType: 'payment.created.v1', paymentId }),
    ]);
  });

  it('returns a completed stored response without reading or writing payment state', async () => {
    const harness = createHarness();
    const response = paymentIntentServiceInternals.toRepresentation(record);
    harness.idempotency.acquire.mockResolvedValue({
      kind: 'replay',
      response: {
        body: response,
        contentType: 'application/json',
        headers: {},
        resultReference: paymentId,
        status: 201,
      },
    });

    await expect(harness.service.create(command)).resolves.toEqual(response);
    expect(harness.idempotency.complete.mock.calls).toHaveLength(0);
    expect(harness.repository.create.mock.calls).toHaveLength(0);
    expect(harness.eventing.persistPaymentCreated.mock.calls).toHaveLength(0);
  });

  it('durably completes an external-reference conflict for later replay', async () => {
    const harness = createHarness();
    harness.repository.create.mockRejectedValue(new ExternalReferenceConflictError());

    await expect(harness.service.create(command)).rejects.toBeInstanceOf(
      ExternalReferenceConflictError,
    );
    expect(harness.idempotency.complete.mock.calls).toHaveLength(2);
  });

  it.each([
    ['payment', new PaymentIdentifierCollisionError()],
    ['event', new EventIdentifierCollisionError()],
  ])('bounds %s identifier collision recovery at three attempts', async (kind, collision) => {
    const harness = createHarness();
    if (kind === 'payment') {
      harness.repository.create.mockRejectedValue(collision);
    } else {
      harness.eventing.persistPaymentCreated.mockRejectedValue(collision);
    }

    await expect(harness.service.create(command)).rejects.toBeInstanceOf(
      IdentifierGenerationExhaustedError,
    );
    expect(harness.identifiers.generate.mock.calls).toHaveLength(3);
    expect(harness.eventing.createPaymentCreatedEvent.mock.calls).toHaveLength(3);
  });

  it('queries by both authenticated merchant and public ID and hides missing records', async () => {
    const harness = createHarness();
    await expect(harness.service.get('merchant-id', paymentId)).resolves.toEqual(
      paymentIntentServiceInternals.toRepresentation(record),
    );
    expect(harness.repository.findByPublicId.mock.calls[0]).toEqual(['merchant-id', paymentId]);

    harness.repository.findByPublicId.mockResolvedValue(undefined);
    await expect(harness.service.get('merchant-id', paymentId)).rejects.toBeInstanceOf(
      PaymentIntentNotFoundError,
    );
  });

  it('keeps equivalent safe-number forms in the same canonical fingerprint', () => {
    const first = paymentIntentServiceInternals.canonicalCreateCommand(command);
    const second = paymentIntentServiceInternals.canonicalCreateCommand({
      ...command,
      amountMinor: Number('1.25e5'),
    });
    expect(second).toBe(first);
  });
});
