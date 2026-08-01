import type { ClaimedOutboxEvent } from './outbox-relay.types';

const EVENT_ID_PATTERN = /^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const PAYMENT_ID_PATTERN = /^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PAYLOAD_KEYS = [
  'eventId',
  'eventType',
  'occurredAt',
  'requestId',
  'merchantId',
  'paymentId',
  'amountMinor',
  'currency',
  'status',
] as const;

export interface SerializedPaymentCreatedEvent {
  readonly amountMinor: number;
  readonly content: Buffer;
  readonly currency: 'ETB' | 'USD';
  readonly eventId: string;
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly paymentId: string;
  readonly requestId: string;
}

export class PaymentCreatedEventContractError extends Error {
  public constructor() {
    super('Outbox event does not match the payment.created.v1 contract');
    this.name = 'PaymentCreatedEventContractError';
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(): never {
  throw new PaymentCreatedEventContractError();
}

export function serializePaymentCreatedEvent(
  claimed: ClaimedOutboxEvent,
): SerializedPaymentCreatedEvent {
  if (
    claimed.eventType !== 'payment.created.v1' ||
    claimed.aggregateType !== 'payment_intent' ||
    !EVENT_ID_PATTERN.test(claimed.eventId) ||
    !PAYMENT_ID_PATTERN.test(claimed.aggregateId) ||
    !UUID_PATTERN.test(claimed.merchantId) ||
    !REQUEST_ID_PATTERN.test(claimed.requestId) ||
    !Number.isInteger(claimed.attemptCount) ||
    claimed.attemptCount < 1 ||
    !isRecord(claimed.payload)
  ) {
    return fail();
  }

  const payload = claimed.payload;
  const keys = Object.keys(payload);
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    !PAYLOAD_KEYS.every((key) => Object.hasOwn(payload, key))
  ) {
    return fail();
  }

  const eventId = payload['eventId'];
  const eventType = payload['eventType'];
  const occurredAt = payload['occurredAt'];
  const requestId = payload['requestId'];
  const merchantId = payload['merchantId'];
  const paymentId = payload['paymentId'];
  const amountMinor = payload['amountMinor'];
  const currency = payload['currency'];
  const status = payload['status'];

  if (
    eventId !== claimed.eventId ||
    eventType !== claimed.eventType ||
    occurredAt !== claimed.occurredAt.toISOString() ||
    requestId !== claimed.requestId ||
    merchantId !== claimed.merchantId ||
    paymentId !== claimed.aggregateId ||
    typeof amountMinor !== 'number' ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 1 ||
    (currency !== 'ETB' && currency !== 'USD') ||
    status !== 'CREATED'
  ) {
    return fail();
  }

  const body = {
    eventId,
    eventType,
    occurredAt,
    requestId,
    merchantId,
    paymentId,
    amountMinor,
    currency,
    status,
  };

  return {
    amountMinor,
    content: Buffer.from(JSON.stringify(body), 'utf8'),
    currency,
    eventId,
    merchantId,
    occurredAt: claimed.occurredAt,
    paymentId,
    requestId,
  };
}

export const paymentCreatedEventContractInternals = {
  EVENT_ID_PATTERN,
  PAYMENT_ID_PATTERN,
  PAYLOAD_KEYS,
};
