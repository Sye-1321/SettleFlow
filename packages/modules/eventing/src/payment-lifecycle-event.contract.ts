import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import type { Message } from 'amqplib';

import type { PaymentCapturedEvent, PaymentRefundedEvent } from './eventing.types';
import type { ClaimedOutboxEvent } from './outbox-relay.types';
import { paymentEventRoute } from './rabbitmq-topology';

const EVENT_ID_PATTERN = /^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const PAYMENT_ID_PATTERN = /^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const REFUND_ID_PATTERN = /^rf_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const LEDGER_ID_PATTERN = /^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CAPTURED_KEYS = [
  'eventId',
  'eventType',
  'occurredAt',
  'requestId',
  'merchantId',
  'paymentId',
  'capturedAmountMinor',
  'currency',
  'availableOn',
  'ledgerTransactionId',
] as const;
const REFUNDED_KEYS = [
  'eventId',
  'eventType',
  'occurredAt',
  'requestId',
  'merchantId',
  'paymentId',
  'refundId',
  'amountMinor',
  'currency',
  'cumulativeRefundedAmountMinor',
  'ledgerTransactionId',
] as const;
export const PAYMENT_LIFECYCLE_MESSAGE_MAX_BYTES = 16_384;

export type PaymentLifecycleEvent = PaymentCapturedEvent | PaymentRefundedEvent;

export interface SerializedPaymentLifecycleEvent {
  readonly content: Buffer;
  readonly eventId: string;
  readonly eventType: PaymentLifecycleEvent['eventType'];
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly paymentId: string;
  readonly requestId: string;
  readonly routingKey: PaymentLifecycleEvent['eventType'];
}

export interface ValidatedPaymentLifecycleMessage {
  readonly event: PaymentLifecycleEvent;
  readonly payloadBytes: Buffer;
  readonly payloadSha256: Buffer;
  readonly publishAttempt: number;
  readonly redelivered: boolean;
  readonly schemaVersion: 1;
}

export class PaymentLifecycleEventContractError extends Error {
  public constructor() {
    super('Outbox event does not match its payment lifecycle contract');
    this.name = 'PaymentLifecycleEventContractError';
  }
}

export class PaymentLifecycleMessageContractError extends Error {
  public constructor(
    public readonly code:
      | 'amqp_metadata_invalid'
      | 'message_body_invalid'
      | 'message_body_too_large'
      | 'message_encoding_invalid'
      | 'message_schema_unsupported',
  ) {
    super('RabbitMQ message does not match its payment lifecycle contract');
    this.name = 'PaymentLifecycleMessageContractError';
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function safeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function assertNoDuplicateTopLevelKeys(text: string): void {
  const keys = new Set<string>();
  let depth = 0;
  let escaped = false;
  let expectingKey = false;
  let inString = false;
  let keyStart: number | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        inString = false;
        if (keyStart !== undefined) {
          const key = JSON.parse(text.slice(keyStart, index + 1)) as unknown;
          if (typeof key !== 'string' || keys.has(key)) {
            throw new PaymentLifecycleMessageContractError('message_body_invalid');
          }
          keys.add(key);
          keyStart = undefined;
          expectingKey = false;
        }
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      if (depth === 1 && expectingKey) keyStart = index;
    } else if (character === '{' || character === '[') {
      depth += 1;
      if (depth === 1 && character === '{') expectingKey = true;
    } else if (character === '}' || character === ']') depth -= 1;
    else if (character === ',' && depth === 1) expectingKey = true;
  }
}

function validCommon(value: Readonly<Record<string, unknown>>): boolean {
  const occurredAt = value['occurredAt'];
  const parsed = typeof occurredAt === 'string' ? new Date(occurredAt) : new Date(Number.NaN);
  return (
    typeof value['eventId'] === 'string' &&
    EVENT_ID_PATTERN.test(value['eventId']) &&
    typeof occurredAt === 'string' &&
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === occurredAt &&
    typeof value['requestId'] === 'string' &&
    REQUEST_ID_PATTERN.test(value['requestId']) &&
    typeof value['merchantId'] === 'string' &&
    UUID_PATTERN.test(value['merchantId']) &&
    typeof value['paymentId'] === 'string' &&
    PAYMENT_ID_PATTERN.test(value['paymentId']) &&
    (value['currency'] === 'ETB' || value['currency'] === 'USD')
  );
}

function toCaptured(value: Readonly<Record<string, unknown>>): PaymentCapturedEvent {
  if (
    !exactKeys(value, CAPTURED_KEYS) ||
    !validCommon(value) ||
    value['eventType'] !== 'payment.captured.v1' ||
    !safeAmount(value['capturedAmountMinor']) ||
    value['availableOn'] !== value['occurredAt'] ||
    typeof value['ledgerTransactionId'] !== 'string' ||
    !LEDGER_ID_PATTERN.test(value['ledgerTransactionId'])
  ) {
    throw new PaymentLifecycleMessageContractError('message_body_invalid');
  }
  return {
    availableOn: new Date(value['availableOn'] as string),
    capturedAmountMinor: value['capturedAmountMinor'],
    currency: value['currency'] as 'ETB' | 'USD',
    eventId: value['eventId'] as string,
    eventType: 'payment.captured.v1',
    ledgerTransactionId: value['ledgerTransactionId'],
    merchantId: value['merchantId'] as string,
    occurredAt: new Date(value['occurredAt'] as string),
    paymentId: value['paymentId'] as string,
    requestId: value['requestId'] as string,
  };
}

function toRefunded(value: Readonly<Record<string, unknown>>): PaymentRefundedEvent {
  if (
    !exactKeys(value, REFUNDED_KEYS) ||
    !validCommon(value) ||
    value['eventType'] !== 'payment.refunded.v1' ||
    typeof value['refundId'] !== 'string' ||
    !REFUND_ID_PATTERN.test(value['refundId']) ||
    !safeAmount(value['amountMinor']) ||
    !safeAmount(value['cumulativeRefundedAmountMinor']) ||
    value['cumulativeRefundedAmountMinor'] < value['amountMinor'] ||
    typeof value['ledgerTransactionId'] !== 'string' ||
    !LEDGER_ID_PATTERN.test(value['ledgerTransactionId'])
  ) {
    throw new PaymentLifecycleMessageContractError('message_body_invalid');
  }
  return {
    amountMinor: value['amountMinor'],
    cumulativeRefundedAmountMinor: value['cumulativeRefundedAmountMinor'],
    currency: value['currency'] as 'ETB' | 'USD',
    eventId: value['eventId'] as string,
    eventType: 'payment.refunded.v1',
    ledgerTransactionId: value['ledgerTransactionId'],
    merchantId: value['merchantId'] as string,
    occurredAt: new Date(value['occurredAt'] as string),
    paymentId: value['paymentId'] as string,
    refundId: value['refundId'],
    requestId: value['requestId'] as string,
  };
}

function parseBody(content: Buffer): PaymentLifecycleEvent {
  if (content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
    throw new PaymentLifecycleMessageContractError('message_encoding_invalid');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new PaymentLifecycleMessageContractError('message_encoding_invalid');
  }
  let value: unknown;
  try {
    assertNoDuplicateTopLevelKeys(text);
    value = JSON.parse(text);
  } catch {
    throw new PaymentLifecycleMessageContractError('message_body_invalid');
  }
  if (!isRecord(value)) throw new PaymentLifecycleMessageContractError('message_body_invalid');
  return value['eventType'] === 'payment.captured.v1' ? toCaptured(value) : toRefunded(value);
}

export function validatePaymentLifecycleMessage(
  message: Message,
  maxBodyBytes = PAYMENT_LIFECYCLE_MESSAGE_MAX_BYTES,
): ValidatedPaymentLifecycleMessage {
  if (message.content.length > maxBodyBytes) {
    throw new PaymentLifecycleMessageContractError('message_body_too_large');
  }
  const event = parseBody(message.content);
  const route = paymentEventRoute(event.eventType);
  const rawHeaders: unknown = message.properties.headers;
  const headers: Readonly<Record<string, unknown>> = isRecord(rawHeaders) ? rawHeaders : {};
  const schemaVersion = headers['x-settleflow-schema-version'];
  if (schemaVersion !== 1) {
    throw new PaymentLifecycleMessageContractError('message_schema_unsupported');
  }
  const publishAttempt = headers['x-settleflow-publish-attempt'];
  if (
    message.fields.exchange !== route.exchange ||
    message.fields.routingKey !== route.routingKey ||
    message.properties.messageId !== event.eventId ||
    message.properties.type !== event.eventType ||
    message.properties.correlationId !== event.requestId ||
    message.properties.contentType !== 'application/json' ||
    message.properties.contentEncoding !== 'utf-8' ||
    message.properties.deliveryMode !== 2 ||
    message.properties.appId !== 'settleflow-worker' ||
    message.properties.timestamp !== Math.floor(event.occurredAt.getTime() / 1_000) ||
    headers['x-settleflow-aggregate-type'] !== 'payment_intent' ||
    headers['x-settleflow-aggregate-id'] !== event.paymentId ||
    headers['x-settleflow-merchant-id'] !== event.merchantId ||
    typeof publishAttempt !== 'number' ||
    !Number.isInteger(publishAttempt) ||
    publishAttempt < 1
  ) {
    throw new PaymentLifecycleMessageContractError('amqp_metadata_invalid');
  }
  return {
    event,
    payloadBytes: Buffer.from(message.content),
    payloadSha256: createHash('sha256').update(message.content).digest(),
    publishAttempt,
    redelivered: message.fields.redelivered,
    schemaVersion,
  };
}

export function serializePaymentLifecycleEvent(
  claimed: ClaimedOutboxEvent,
): SerializedPaymentLifecycleEvent {
  if (
    (claimed.eventType !== 'payment.captured.v1' && claimed.eventType !== 'payment.refunded.v1') ||
    claimed.aggregateType !== 'payment_intent' ||
    !isRecord(claimed.payload)
  ) {
    throw new PaymentLifecycleEventContractError();
  }
  let event: PaymentLifecycleEvent;
  try {
    event =
      claimed.eventType === 'payment.captured.v1'
        ? toCaptured(claimed.payload)
        : toRefunded(claimed.payload);
  } catch {
    throw new PaymentLifecycleEventContractError();
  }
  if (
    event.eventId !== claimed.eventId ||
    event.paymentId !== claimed.aggregateId ||
    event.merchantId !== claimed.merchantId ||
    event.requestId !== claimed.requestId ||
    event.occurredAt.getTime() !== claimed.occurredAt.getTime()
  ) {
    throw new PaymentLifecycleEventContractError();
  }
  const body =
    event.eventType === 'payment.captured.v1'
      ? {
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt.toISOString(),
          requestId: event.requestId,
          merchantId: event.merchantId,
          paymentId: event.paymentId,
          capturedAmountMinor: event.capturedAmountMinor,
          currency: event.currency,
          availableOn: event.availableOn.toISOString(),
          ledgerTransactionId: event.ledgerTransactionId,
        }
      : {
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt.toISOString(),
          requestId: event.requestId,
          merchantId: event.merchantId,
          paymentId: event.paymentId,
          refundId: event.refundId,
          amountMinor: event.amountMinor,
          currency: event.currency,
          cumulativeRefundedAmountMinor: event.cumulativeRefundedAmountMinor,
          ledgerTransactionId: event.ledgerTransactionId,
        };
  return {
    content: Buffer.from(JSON.stringify(body), 'utf8'),
    eventId: event.eventId,
    eventType: event.eventType,
    merchantId: event.merchantId,
    occurredAt: event.occurredAt,
    paymentId: event.paymentId,
    requestId: event.requestId,
    routingKey: event.eventType,
  };
}

export const paymentLifecycleEventContractInternals = {
  CAPTURED_KEYS,
  REFUNDED_KEYS,
  assertNoDuplicateTopLevelKeys,
  parseBody,
  toCaptured,
  toRefunded,
};
