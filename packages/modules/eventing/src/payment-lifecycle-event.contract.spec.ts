import type { ConsumeMessage } from 'amqplib';

import type { ClaimedOutboxEvent } from './outbox-relay.types';
import {
  PaymentLifecycleEventContractError,
  PaymentLifecycleMessageContractError,
  serializePaymentLifecycleEvent,
  validatePaymentLifecycleMessage,
} from './payment-lifecycle-event.contract';
import { paymentEventRoute } from './rabbitmq-topology';

const EVENT_ID = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PAYMENT_ID = 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const REFUND_ID = 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const LEDGER_ID = 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const OCCURRED_AT = new Date('2026-08-02T10:20:12.345Z');

function claimed(eventType: 'payment.captured.v1' | 'payment.refunded.v1'): ClaimedOutboxEvent {
  const common = {
    eventId: EVENT_ID,
    eventType,
    occurredAt: OCCURRED_AT.toISOString(),
    requestId: 'req_lifecycle_contract',
    merchantId: MERCHANT_ID,
    paymentId: PAYMENT_ID,
  };
  return {
    aggregateId: PAYMENT_ID,
    aggregateType: 'payment_intent',
    attemptCount: 1,
    eventId: EVENT_ID,
    eventType,
    id: '22222222-2222-4222-8222-222222222222',
    merchantId: MERCHANT_ID,
    occurredAt: OCCURRED_AT,
    payload:
      eventType === 'payment.captured.v1'
        ? {
            ...common,
            capturedAmountMinor: 1_000,
            currency: 'ETB',
            availableOn: OCCURRED_AT.toISOString(),
            ledgerTransactionId: LEDGER_ID,
          }
        : {
            ...common,
            refundId: REFUND_ID,
            amountMinor: 400,
            currency: 'ETB',
            cumulativeRefundedAmountMinor: 400,
            ledgerTransactionId: LEDGER_ID,
          },
    requestId: 'req_lifecycle_contract',
  };
}

function message(eventType: 'payment.captured.v1' | 'payment.refunded.v1'): ConsumeMessage {
  const serialized = serializePaymentLifecycleEvent(claimed(eventType));
  const route = paymentEventRoute(eventType);
  return {
    content: serialized.content,
    fields: {
      consumerTag: 'consumer',
      deliveryTag: 1,
      exchange: route.exchange,
      redelivered: false,
      routingKey: route.routingKey,
    },
    properties: {
      appId: 'settleflow-worker',
      contentEncoding: 'utf-8',
      contentType: 'application/json',
      correlationId: 'req_lifecycle_contract',
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
      type: eventType,
    },
  } as unknown as ConsumeMessage;
}

describe('payment capture/refund event contracts', () => {
  it('serializes the exact approved captured and refunded bodies', () => {
    expect(serializePaymentLifecycleEvent(claimed('payment.captured.v1')).content.toString()).toBe(
      '{"eventId":"evt_01ARZ3NDEKTSV4RRFFQ69G5FAV","eventType":"payment.captured.v1","occurredAt":"2026-08-02T10:20:12.345Z","requestId":"req_lifecycle_contract","merchantId":"11111111-1111-4111-8111-111111111111","paymentId":"pi_01ARZ3NDEKTSV4RRFFQ69G5FAV","capturedAmountMinor":1000,"currency":"ETB","availableOn":"2026-08-02T10:20:12.345Z","ledgerTransactionId":"ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
    );
    expect(serializePaymentLifecycleEvent(claimed('payment.refunded.v1')).content.toString()).toBe(
      '{"eventId":"evt_01ARZ3NDEKTSV4RRFFQ69G5FAV","eventType":"payment.refunded.v1","occurredAt":"2026-08-02T10:20:12.345Z","requestId":"req_lifecycle_contract","merchantId":"11111111-1111-4111-8111-111111111111","paymentId":"pi_01ARZ3NDEKTSV4RRFFQ69G5FAV","refundId":"rf_01ARZ3NDEKTSV4RRFFQ69G5FAV","amountMinor":400,"currency":"ETB","cumulativeRefundedAmountMinor":400,"ledgerTransactionId":"ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
    );
  });

  it.each(['payment.captured.v1', 'payment.refunded.v1'] as const)(
    'validates exact %s bytes and AMQP metadata',
    (eventType) => {
      const validated = validatePaymentLifecycleMessage(message(eventType));
      expect(validated.event.eventType).toBe(eventType);
      expect(validated.payloadSha256).toHaveLength(32);
    },
  );

  it('rejects added fields, column mismatches, unsafe amounts, and duplicate keys', () => {
    const base = claimed('payment.refunded.v1');
    expect(() =>
      serializePaymentLifecycleEvent({
        ...base,
        payload: { ...(base.payload as object), prohibited: true },
      }),
    ).toThrow(PaymentLifecycleEventContractError);
    expect(() => serializePaymentLifecycleEvent({ ...base, requestId: 'req_other' })).toThrow(
      PaymentLifecycleEventContractError,
    );

    const unsafe = message('payment.refunded.v1');
    unsafe.content = Buffer.from(
      unsafe.content.toString().replace('"amountMinor":400', '"amountMinor":9007199254740992'),
    );
    expect(() => validatePaymentLifecycleMessage(unsafe)).toThrow(
      PaymentLifecycleMessageContractError,
    );

    const duplicate = message('payment.captured.v1');
    duplicate.content = Buffer.from(
      duplicate.content
        .toString()
        .replace(
          '"capturedAmountMinor":1000',
          '"capturedAmountMinor":1000,"capturedAmountMinor":1000',
        ),
    );
    expect(() => validatePaymentLifecycleMessage(duplicate)).toThrow(
      PaymentLifecycleMessageContractError,
    );
  });

  it('rejects event-type/routing mismatches', () => {
    const invalid = message('payment.captured.v1');
    invalid.fields.routingKey = 'payment.refunded.v1';
    expect(() => validatePaymentLifecycleMessage(invalid)).toThrow(
      PaymentLifecycleMessageContractError,
    );
  });
});
