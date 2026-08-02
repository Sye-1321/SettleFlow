import type { ConsumeMessage } from 'amqplib';

import type { ClaimedOutboxEvent } from './outbox-relay.types';
import {
  PaymentCreatedEventContractError,
  PaymentCreatedMessageContractError,
  serializePaymentCreatedEvent,
  validatePaymentCreatedMessage,
} from './payment-created-event.contract';
import { OUTBOX_RABBITMQ_TOPOLOGY } from './rabbitmq-topology';

const EVENT_ID = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PAYMENT_ID = 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const OCCURRED_AT = new Date('2026-08-01T10:20:12.345Z');

function createEvent(overrides: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent {
  return {
    aggregateId: PAYMENT_ID,
    aggregateType: 'payment_intent',
    attemptCount: 1,
    eventId: EVENT_ID,
    eventType: 'payment.created.v1',
    id: '22222222-2222-4222-8222-222222222222',
    merchantId: MERCHANT_ID,
    occurredAt: OCCURRED_AT,
    payload: {
      amountMinor: 125_000,
      currency: 'ETB',
      eventId: EVENT_ID,
      eventType: 'payment.created.v1',
      merchantId: MERCHANT_ID,
      occurredAt: OCCURRED_AT.toISOString(),
      paymentId: PAYMENT_ID,
      requestId: 'req_contract_test',
      status: 'CREATED',
    },
    requestId: 'req_contract_test',
    ...overrides,
  };
}

function createMessage(
  overrides: {
    readonly content?: Buffer;
    readonly fields?: Readonly<Record<string, unknown>>;
    readonly properties?: Readonly<Record<string, unknown>>;
  } = {},
): ConsumeMessage {
  const serialized = serializePaymentCreatedEvent(createEvent());
  return {
    content: overrides.content ?? serialized.content,
    fields: {
      consumerTag: 'consumer',
      deliveryTag: 1,
      exchange: OUTBOX_RABBITMQ_TOPOLOGY.exchange,
      redelivered: false,
      routingKey: OUTBOX_RABBITMQ_TOPOLOGY.routingKey,
      ...overrides.fields,
    },
    properties: {
      appId: 'settleflow-worker',
      contentEncoding: 'utf-8',
      contentType: 'application/json',
      correlationId: 'req_contract_test',
      deliveryMode: 2,
      headers: {
        'x-settleflow-aggregate-id': PAYMENT_ID,
        'x-settleflow-aggregate-type': 'payment_intent',
        'x-settleflow-merchant-id': MERCHANT_ID,
        'x-settleflow-publish-attempt': 1,
        'x-settleflow-schema-version': 1,
      },
      messageId: EVENT_ID,
      timestamp: Math.floor(OCCURRED_AT.getTime() / 1_000),
      type: 'payment.created.v1',
      ...overrides.properties,
    },
  } as unknown as ConsumeMessage;
}

describe('payment.created.v1 relay contract', () => {
  it('serializes the exact approved nine-field body in a fixed order', () => {
    const serialized = serializePaymentCreatedEvent(createEvent());

    expect(serialized.content.toString('utf8')).toBe(
      '{"eventId":"evt_01ARZ3NDEKTSV4RRFFQ69G5FAV","eventType":"payment.created.v1","occurredAt":"2026-08-01T10:20:12.345Z","requestId":"req_contract_test","merchantId":"11111111-1111-4111-8111-111111111111","paymentId":"pi_01ARZ3NDEKTSV4RRFFQ69G5FAV","amountMinor":125000,"currency":"ETB","status":"CREATED"}',
    );
  });

  it('rejects payload additions, unsafe amounts, and column mismatches', () => {
    const base = createEvent();
    const payload = base.payload as Readonly<Record<string, unknown>>;

    expect(() =>
      serializePaymentCreatedEvent({ ...base, payload: { ...payload, apiKey: 'prohibited' } }),
    ).toThrow(PaymentCreatedEventContractError);
    expect(() =>
      serializePaymentCreatedEvent({
        ...base,
        payload: { ...payload, amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow(PaymentCreatedEventContractError);
    expect(() => serializePaymentCreatedEvent({ ...base, requestId: 'req_other' })).toThrow(
      PaymentCreatedEventContractError,
    );
  });

  it('accepts the exact publisher bytes and AMQP metadata and fingerprints the bytes', () => {
    const validated = validatePaymentCreatedMessage(createMessage());

    expect(validated.event).toEqual({
      amountMinor: 125_000,
      currency: 'ETB',
      eventId: EVENT_ID,
      eventType: 'payment.created.v1',
      merchantId: MERCHANT_ID,
      occurredAt: OCCURRED_AT,
      paymentId: PAYMENT_ID,
      requestId: 'req_contract_test',
      status: 'CREATED',
    });
    expect(validated.payloadSha256).toHaveLength(32);
    expect(validated.schemaVersion).toBe(1);
  });

  it.each([
    [{ properties: { messageId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW' } }, 'amqp_metadata_invalid'],
    [
      { properties: { headers: { 'x-settleflow-schema-version': 2 } } },
      'message_schema_unsupported',
    ],
    [{ content: Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]) }, 'message_encoding_invalid'],
    [{ content: Buffer.from('{"eventId":', 'utf8') }, 'message_body_invalid'],
    [{ content: Buffer.alloc(16_385, 0x20) }, 'message_body_too_large'],
  ] as const)('rejects invalid consumer input as %s', (overrides, code) => {
    let thrown: unknown;
    try {
      validatePaymentCreatedMessage(createMessage(overrides));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PaymentCreatedMessageContractError);
    expect((thrown as PaymentCreatedMessageContractError).code).toBe(code);
  });

  it('rejects fractional, unsafe, unsupported, and extra payload values', () => {
    const base = JSON.parse(createMessage().content.toString('utf8')) as Record<string, unknown>;
    for (const mutation of [
      { amountMinor: 1.5 },
      { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      { currency: 'EUR' },
      { status: 'CAPTURED' },
      { prohibited: true },
    ]) {
      expect(() =>
        validatePaymentCreatedMessage(
          createMessage({ content: Buffer.from(JSON.stringify({ ...base, ...mutation }), 'utf8') }),
        ),
      ).toThrow(PaymentCreatedMessageContractError);
    }

    expect(() =>
      validatePaymentCreatedMessage(
        createMessage({
          content: Buffer.from(
            createMessage().content.toString('utf8').replace('125000', '9007199254740991.1'),
          ),
        }),
      ),
    ).toThrow(PaymentCreatedMessageContractError);

    expect(() =>
      validatePaymentCreatedMessage(
        createMessage({
          content: Buffer.from(
            createMessage()
              .content.toString('utf8')
              .replace('"amountMinor":125000', '"amountMinor":125000,"amountMinor":125000'),
          ),
        }),
      ),
    ).toThrow(PaymentCreatedMessageContractError);
  });
});
