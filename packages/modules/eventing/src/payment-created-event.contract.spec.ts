import type { ClaimedOutboxEvent } from './outbox-relay.types';
import {
  PaymentCreatedEventContractError,
  serializePaymentCreatedEvent,
} from './payment-created-event.contract';

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
});
