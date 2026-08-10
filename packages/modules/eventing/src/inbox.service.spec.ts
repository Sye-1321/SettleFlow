import type { PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  InboxMessageConflictError,
  MessageTransactionRetryExhaustedError,
} from './eventing.errors';
import { InboxService, inboxServiceInternals } from './inbox.service';
import type { InboxRepository, InboxTransactionContext } from './inbox.types';
import type {
  ValidatedPaymentCreatedMessage,
  ValidatedPaymentEventMessage,
} from './payment-created-event.contract';

const EVENT_ID = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const HASH = Buffer.alloc(32, 7);

function createMessage(): ValidatedPaymentCreatedMessage {
  return {
    event: {
      amountMinor: 1_000,
      currency: 'USD',
      eventId: EVENT_ID,
      eventType: 'payment.created.v1',
      merchantId: '11111111-1111-4111-8111-111111111111',
      occurredAt: new Date('2026-08-02T10:00:00.000Z'),
      paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_inbox_test',
      status: 'CREATED',
    },
    payloadBytes: Buffer.from('{}'),
    payloadSha256: HASH,
    publishAttempt: 1,
    redelivered: false,
    schemaVersion: 1,
  };
}

function createRepository(
  reserve: InboxRepository['reserve'],
  transactionBehavior?: (
    operation: (context: InboxTransactionContext) => Promise<unknown>,
  ) => Promise<unknown>,
): InboxRepository {
  const context = {
    processedAt: new Date('2026-08-02T10:01:00.000Z'),
    transaction: {} as PrismaTransactionClient,
  };
  return {
    reserve,
    withSerializableTransaction: jest.fn((operation) =>
      transactionBehavior === undefined ? operation(context) : transactionBehavior(operation),
    ) as InboxRepository['withSerializableTransaction'],
  };
}

describe('InboxService', () => {
  it('uses one stable durable consumer identity per supported event contract', () => {
    const created = createMessage();
    const captured: ValidatedPaymentEventMessage = {
      ...created,
      event: {
        availableOn: created.event.occurredAt,
        capturedAmountMinor: created.event.amountMinor,
        currency: created.event.currency,
        eventId: created.event.eventId,
        eventType: 'payment.captured.v1',
        ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        merchantId: created.event.merchantId,
        occurredAt: created.event.occurredAt,
        paymentId: created.event.paymentId,
        requestId: created.event.requestId,
      },
    };
    const refunded: ValidatedPaymentEventMessage = {
      ...created,
      event: {
        amountMinor: 250,
        cumulativeRefundedAmountMinor: 250,
        currency: created.event.currency,
        eventId: created.event.eventId,
        eventType: 'payment.refunded.v1',
        ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAW',
        merchantId: created.event.merchantId,
        occurredAt: created.event.occurredAt,
        paymentId: created.event.paymentId,
        refundId: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        requestId: created.event.requestId,
      },
    };

    expect(inboxServiceInternals.consumerName(created)).toBe(
      'webhook-projection.payment-created.v1',
    );
    expect(inboxServiceInternals.consumerName(captured)).toBe(
      'webhook-projection.payment-captured.v1',
    );
    expect(inboxServiceInternals.consumerName(refunded)).toBe(
      'webhook-projection.payment-refunded.v1',
    );
  });

  it('reserves a new message and runs the effect inside the same transaction', async () => {
    const reserve = jest.fn().mockResolvedValue({ kind: 'reserved' });
    const repository = createRepository(reserve);
    const effect = jest.fn().mockResolvedValue({ deliveryCount: 2 });
    const service = new InboxService(repository, { retryAttempts: 3 });

    await expect(service.process(createMessage(), effect)).resolves.toEqual({
      kind: 'processed',
      value: { deliveryCount: 2 },
    });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        consumerName: 'webhook-projection.payment-created.v1',
        messageId: EVENT_ID,
        payloadSha256: HASH,
      }),
    );
  });

  it('returns a matching duplicate without invoking the effect', async () => {
    const message = createMessage();
    const repository = createRepository(
      jest.fn().mockResolvedValue({
        kind: 'existing',
        record: {
          consumerName: 'webhook-projection.payment-created.v1',
          correlationId: message.event.requestId,
          eventType: message.event.eventType,
          messageId: message.event.eventId,
          payloadSha256: HASH,
          schemaVersion: 1,
        },
      }),
    );
    const effect = jest.fn();

    await expect(
      new InboxService(repository, { retryAttempts: 3 }).process(message, effect),
    ).resolves.toEqual({ kind: 'duplicate' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('rejects a duplicate event ID whose immutable fingerprint differs', async () => {
    const message = createMessage();
    const repository = createRepository(
      jest.fn().mockResolvedValue({
        kind: 'existing',
        record: {
          consumerName: 'webhook-projection.payment-created.v1',
          correlationId: message.event.requestId,
          eventType: message.event.eventType,
          messageId: message.event.eventId,
          payloadSha256: Buffer.alloc(32, 8),
          schemaVersion: 1,
        },
      }),
    );

    await expect(
      new InboxService(repository, { retryAttempts: 3 }).process(message, jest.fn()),
    ).rejects.toBeInstanceOf(InboxMessageConflictError);
  });

  it('retries a complete serializable transaction three times and then fails permanently', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const serializationFailure = Object.assign(new Error('serialization failure'), {
      code: '40001',
    });
    const repository = createRepository(jest.fn(), () => Promise.reject(serializationFailure));
    const service = new InboxService(repository, {
      random: (): number => 0.5,
      retryAttempts: 3,
      sleep,
    });

    await expect(service.process(createMessage(), jest.fn())).rejects.toBeInstanceOf(
      MessageTransactionRetryExhaustedError,
    );
    expect((repository.withSerializableTransaction as jest.Mock).mock.calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('uses bounded default retry timing and then commits the whole transaction', async () => {
    let attempt = 0;
    const serializationFailure = Object.assign(new Error('serialization failure'), {
      code: '40001',
    });
    const repository = createRepository(
      jest.fn().mockResolvedValue({ kind: 'reserved' }),
      async (operation) => {
        attempt += 1;
        if (attempt === 1) throw serializationFailure;
        return operation({
          processedAt: new Date('2026-08-02T10:01:00.000Z'),
          transaction: {} as PrismaTransactionClient,
        });
      },
    );
    await expect(
      new InboxService(repository, { retryAttempts: 2 }).process(
        createMessage(),
        jest.fn().mockResolvedValue('committed'),
      ),
    ).resolves.toEqual({ kind: 'processed', value: 'committed' });
    expect(attempt).toBe(2);
  });
});
