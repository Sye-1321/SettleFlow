import type { ClaimedOutboxEvent } from './outbox-relay.types';
import type { ConsumeMessage } from 'amqplib';
import {
  OperationalEventContractError,
  serializeOperationalEvent,
  validateOperationalEventMessage,
} from './settlement-reconciliation-event.contract';

describe('settlement and reconciliation event contracts', () => {
  const base = {
    aggregateId: 'stb_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    aggregateType: 'settlement_batch',
    attemptCount: 1,
    eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    eventType: 'settlement.finalized.v1',
    id: '00000000-0000-4000-8000-000000000001',
    merchantId: '00000000-0000-4000-8000-000000000002',
    occurredAt: new Date('2026-08-03T10:00:00.000Z'),
    requestId: 'req_settlement',
  } as const;

  it('serializes the exact approved twelve-field settlement event', () => {
    const event: ClaimedOutboxEvent = {
      ...base,
      payload: {
        eventId: base.eventId,
        eventType: base.eventType,
        occurredAt: base.occurredAt.toISOString(),
        requestId: base.requestId,
        merchantId: base.merchantId,
        batchId: base.aggregateId,
        cutoffAt: '2026-08-02T21:00:00.000Z',
        grossAmountMinor: 117000,
        feeAmountMinor: 3000,
        netAmountMinor: 114000,
        currency: 'ETB',
        itemCount: 1,
      },
    };
    expect(JSON.parse(serializeOperationalEvent(event).content.toString('utf8'))).toEqual(
      event.payload,
    );
  });

  it('rejects extra event fields', () => {
    expect(() =>
      serializeOperationalEvent({
        ...base,
        payload: {
          eventId: base.eventId,
          eventType: base.eventType,
          occurredAt: base.occurredAt.toISOString(),
          requestId: base.requestId,
          merchantId: base.merchantId,
          batchId: base.aggregateId,
          cutoffAt: '2026-08-02T21:00:00.000Z',
          grossAmountMinor: 117000,
          feeAmountMinor: 3000,
          netAmountMinor: 114000,
          currency: 'ETB',
          itemCount: 1,
          extra: true,
        },
      }),
    ).toThrow(OperationalEventContractError);
  });

  it.each([
    [{ aggregateId: 'invalid' }, {}],
    [{ aggregateType: 'reconciliation_import' }, {}],
    [{}, { currency: 'EUR' }],
    [{}, { grossAmountMinor: 0 }],
    [{}, { feeAmountMinor: -1 }],
    [{}, { netAmountMinor: 0 }],
    [{}, { itemCount: 0 }],
    [{}, { itemCount: 501 }],
    [{}, { grossAmountMinor: 117001 }],
    [{}, { cutoffAt: '2026-08-02T21:00:00Z' }],
  ] as const)('rejects invalid settlement contract %#', (eventMutation, payloadMutation) => {
    expect(() =>
      serializeOperationalEvent({
        ...base,
        ...eventMutation,
        payload: {
          eventId: base.eventId,
          eventType: base.eventType,
          occurredAt: base.occurredAt.toISOString(),
          requestId: base.requestId,
          merchantId: base.merchantId,
          batchId: base.aggregateId,
          cutoffAt: '2026-08-02T21:00:00.000Z',
          grossAmountMinor: 117000,
          feeAmountMinor: 3000,
          netAmountMinor: 114000,
          currency: 'ETB',
          itemCount: 1,
          ...payloadMutation,
        },
      }),
    ).toThrow(OperationalEventContractError);
  });

  it('serializes the exact approved reconciliation body and signed currency differences', () => {
    const event: ClaimedOutboxEvent = {
      ...base,
      aggregateId: 'rec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      aggregateType: 'reconciliation_import',
      eventType: 'reconciliation.completed.v1',
      payload: {
        eventId: base.eventId,
        eventType: 'reconciliation.completed.v1',
        occurredAt: base.occurredAt.toISOString(),
        requestId: base.requestId,
        merchantId: base.merchantId,
        importId: 'rec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        matchedExactCount: 4,
        mismatchCount: 1,
        unexplainedDifferenceMinorByCurrency: { ETB: -500, USD: 0 },
      },
    };
    expect(JSON.parse(serializeOperationalEvent(event).content.toString('utf8'))).toEqual(
      event.payload,
    );
  });

  it.each([
    [{ aggregateId: 'invalid' }, {}],
    [{ aggregateType: 'settlement_batch' }, {}],
    [{}, { matchedExactCount: -1 }],
    [{}, { mismatchCount: -1 }],
    [{}, { unexplainedDifferenceMinorByCurrency: null }],
    [{}, { unexplainedDifferenceMinorByCurrency: { ETB: 0 } }],
    [{}, { unexplainedDifferenceMinorByCurrency: { ETB: 1.5, USD: 0 } }],
    [{}, { unexplainedDifferenceMinorByCurrency: { ETB: 0, USD: 1.5 } }],
  ] as const)('rejects invalid reconciliation contract %#', (eventMutation, payloadMutation) => {
    expect(() =>
      serializeOperationalEvent({
        ...base,
        aggregateId: 'rec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        aggregateType: 'reconciliation_import',
        eventType: 'reconciliation.completed.v1',
        ...eventMutation,
        payload: {
          eventId: base.eventId,
          eventType: 'reconciliation.completed.v1',
          occurredAt: base.occurredAt.toISOString(),
          requestId: base.requestId,
          merchantId: base.merchantId,
          importId: 'rec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          matchedExactCount: 4,
          mismatchCount: 1,
          unexplainedDifferenceMinorByCurrency: { ETB: -500, USD: 0 },
          ...payloadMutation,
        },
      }),
    ).toThrow(OperationalEventContractError);
  });

  it('requires the exact AMQP metadata mapping', () => {
    const payload = {
      eventId: base.eventId,
      eventType: base.eventType,
      occurredAt: base.occurredAt.toISOString(),
      requestId: base.requestId,
      merchantId: base.merchantId,
      batchId: base.aggregateId,
      cutoffAt: '2026-08-02T21:00:00.000Z',
      grossAmountMinor: 117000,
      feeAmountMinor: 3000,
      netAmountMinor: 114000,
      currency: 'ETB',
      itemCount: 1,
    };
    const message = {
      content: Buffer.from(JSON.stringify(payload)),
      fields: {
        consumerTag: 'consumer',
        deliveryTag: 1,
        exchange: 'settleflow.domain-events',
        redelivered: false,
        routingKey: base.eventType,
      },
      properties: {
        appId: 'settleflow-worker',
        clusterId: undefined,
        contentEncoding: 'utf-8',
        contentType: 'application/json',
        correlationId: base.requestId,
        deliveryMode: 2,
        expiration: undefined,
        headers: {
          'x-settleflow-aggregate-id': base.aggregateId,
          'x-settleflow-aggregate-type': base.aggregateType,
          'x-settleflow-merchant-id': base.merchantId,
          'x-settleflow-publish-attempt': 1,
          'x-settleflow-schema-version': 1,
        },
        messageId: base.eventId,
        priority: undefined,
        replyTo: undefined,
        timestamp: Math.floor(base.occurredAt.getTime() / 1_000),
        type: base.eventType,
        userId: undefined,
      },
    } satisfies ConsumeMessage;
    expect(validateOperationalEventMessage(message, 16_384).event.eventId).toBe(base.eventId);
    expect(() =>
      validateOperationalEventMessage(
        { ...message, properties: { ...message.properties, appId: 'other' } },
        16_384,
      ),
    ).toThrow(OperationalEventContractError);

    for (const invalid of [
      { ...message, content: Buffer.alloc(16_385) },
      { ...message, content: Buffer.from('{') },
      { ...message, content: Buffer.from('[]') },
      { ...message, properties: { ...message.properties, type: 'unsupported.v1' } },
      {
        ...message,
        properties: {
          ...message.properties,
          headers: { ...message.properties.headers, 'x-settleflow-schema-version': 2 },
        },
      },
      { ...message, properties: { ...message.properties, timestamp: 1 } },
    ]) {
      expect(() => validateOperationalEventMessage(invalid as ConsumeMessage, 16_384)).toThrow(
        OperationalEventContractError,
      );
    }
  });
});
