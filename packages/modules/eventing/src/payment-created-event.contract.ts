import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import type { Message } from 'amqplib';

import type { PaymentCreatedEvent } from './eventing.types';
import type { ClaimedOutboxEvent } from './outbox-relay.types';
import { OUTBOX_RABBITMQ_TOPOLOGY } from './rabbitmq-topology';
import {
  PaymentLifecycleMessageContractError,
  validatePaymentLifecycleMessage,
  type ValidatedPaymentLifecycleMessage,
} from './payment-lifecycle-event.contract';

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
const POSITIVE_INTEGER_TOKEN_PATTERN = /^[1-9]\d*$/u;
const MAX_SAFE_INTEGER_TEXT = String(Number.MAX_SAFE_INTEGER);
export const PAYMENT_CREATED_MESSAGE_MAX_BYTES = 16_384;

export type PaymentCreatedMessageContractFailureCode =
  | 'amqp_metadata_invalid'
  | 'message_body_invalid'
  | 'message_body_too_large'
  | 'message_encoding_invalid'
  | 'message_schema_unsupported';

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

export interface ValidatedPaymentCreatedMessage {
  readonly event: PaymentCreatedEvent;
  readonly payloadBytes: Buffer;
  readonly payloadSha256: Buffer;
  readonly publishAttempt: number;
  readonly redelivered: boolean;
  readonly schemaVersion: 1;
}

export type ValidatedPaymentEventMessage =
  ValidatedPaymentCreatedMessage | ValidatedPaymentLifecycleMessage;

export class PaymentCreatedEventContractError extends Error {
  public constructor() {
    super('Outbox event does not match the payment.created.v1 contract');
    this.name = 'PaymentCreatedEventContractError';
  }
}

export class PaymentCreatedMessageContractError extends Error {
  public constructor(public readonly code: PaymentCreatedMessageContractFailureCode) {
    super('RabbitMQ message does not match the payment.created.v1 contract');
    this.name = 'PaymentCreatedMessageContractError';
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(): never {
  throw new PaymentCreatedEventContractError();
}

function failMessage(code: PaymentCreatedMessageContractFailureCode): never {
  throw new PaymentCreatedMessageContractError(code);
}

function readHeader(headers: Readonly<Record<string, unknown>>, name: string): unknown {
  return Object.hasOwn(headers, name) ? headers[name] : undefined;
}

interface JsonParseContext {
  readonly source?: string;
}

type JsonParserWithSource = (
  text: string,
  reviver: (key: string, value: unknown, context: JsonParseContext) => unknown,
) => unknown;

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
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
        if (keyStart !== undefined) {
          const key = JSON.parse(text.slice(keyStart, index + 1)) as unknown;
          if (typeof key !== 'string' || keys.has(key)) {
            return failMessage('message_body_invalid');
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
      if (depth === 1 && expectingKey) {
        keyStart = index;
      }
    } else if (character === '{' || character === '[') {
      depth += 1;
      if (depth === 1 && character === '{') {
        expectingKey = true;
      }
    } else if (character === '}' || character === ']') {
      depth -= 1;
    } else if (character === ',' && depth === 1) {
      expectingKey = true;
    }
  }
}

function parseExactSafeInteger(token: string | undefined): number | undefined {
  if (token === undefined) {
    return undefined;
  }
  if (
    !POSITIVE_INTEGER_TOKEN_PATTERN.test(token) ||
    token.length > MAX_SAFE_INTEGER_TEXT.length ||
    (token.length === MAX_SAFE_INTEGER_TEXT.length && token > MAX_SAFE_INTEGER_TEXT)
  ) {
    return undefined;
  }
  const amount = Number(token);
  return Number.isSafeInteger(amount) ? amount : undefined;
}

function parseEventBody(content: Buffer): PaymentCreatedEvent {
  if (content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
    return failMessage('message_encoding_invalid');
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return failMessage('message_encoding_invalid');
  }

  let value: unknown;
  let amountMinorToken: string | undefined;
  try {
    assertNoDuplicateTopLevelKeys(decoded);
    const parseWithSource = JSON.parse as JsonParserWithSource;
    value = parseWithSource(decoded, (key, parsedValue, context) => {
      if (key === 'amountMinor' && typeof parsedValue === 'number') {
        amountMinorToken = context.source;
      }
      return parsedValue;
    });
  } catch {
    return failMessage('message_body_invalid');
  }
  if (!isRecord(value)) {
    return failMessage('message_body_invalid');
  }

  const keys = Object.keys(value);
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    !PAYLOAD_KEYS.every((key) => Object.hasOwn(value, key))
  ) {
    return failMessage('message_body_invalid');
  }

  const eventId = value['eventId'];
  const eventType = value['eventType'];
  const occurredAtValue = value['occurredAt'];
  const requestId = value['requestId'];
  const merchantId = value['merchantId'];
  const paymentId = value['paymentId'];
  const amountMinor = parseExactSafeInteger(amountMinorToken);
  const currency = value['currency'];
  const status = value['status'];
  const occurredAt =
    typeof occurredAtValue === 'string' ? new Date(occurredAtValue) : new Date(Number.NaN);

  if (
    typeof eventId !== 'string' ||
    !EVENT_ID_PATTERN.test(eventId) ||
    eventType !== 'payment.created.v1' ||
    typeof occurredAtValue !== 'string' ||
    !Number.isFinite(occurredAt.getTime()) ||
    occurredAt.toISOString() !== occurredAtValue ||
    typeof requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(requestId) ||
    typeof merchantId !== 'string' ||
    !UUID_PATTERN.test(merchantId) ||
    typeof paymentId !== 'string' ||
    !PAYMENT_ID_PATTERN.test(paymentId) ||
    amountMinor === undefined ||
    (currency !== 'ETB' && currency !== 'USD') ||
    status !== 'CREATED'
  ) {
    return failMessage('message_body_invalid');
  }

  return {
    amountMinor,
    currency,
    eventId,
    eventType,
    merchantId,
    occurredAt,
    paymentId,
    requestId,
    status,
  };
}

export function validatePaymentCreatedMessage(
  message: Message,
  maxBodyBytes = PAYMENT_CREATED_MESSAGE_MAX_BYTES,
): ValidatedPaymentCreatedMessage {
  if (message.content.length > maxBodyBytes) {
    return failMessage('message_body_too_large');
  }
  const event = parseEventBody(message.content);
  const headers = isRecord(message.properties.headers) ? message.properties.headers : {};
  const schemaVersion = readHeader(headers, 'x-settleflow-schema-version');
  if (schemaVersion !== 1) {
    return failMessage('message_schema_unsupported');
  }
  const publishAttempt = readHeader(headers, 'x-settleflow-publish-attempt');
  if (
    message.fields.exchange !== OUTBOX_RABBITMQ_TOPOLOGY.exchange ||
    message.fields.routingKey !== OUTBOX_RABBITMQ_TOPOLOGY.routingKey ||
    message.properties.messageId !== event.eventId ||
    message.properties.type !== event.eventType ||
    message.properties.correlationId !== event.requestId ||
    message.properties.contentType !== 'application/json' ||
    message.properties.contentEncoding !== 'utf-8' ||
    message.properties.deliveryMode !== 2 ||
    message.properties.appId !== 'settleflow-worker' ||
    message.properties.timestamp !== Math.floor(event.occurredAt.getTime() / 1_000) ||
    readHeader(headers, 'x-settleflow-aggregate-type') !== 'payment_intent' ||
    readHeader(headers, 'x-settleflow-aggregate-id') !== event.paymentId ||
    readHeader(headers, 'x-settleflow-merchant-id') !== event.merchantId ||
    typeof publishAttempt !== 'number' ||
    !Number.isInteger(publishAttempt) ||
    publishAttempt < 1
  ) {
    return failMessage('amqp_metadata_invalid');
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

export function validatePaymentEventMessage(
  message: Message,
  maxBodyBytes = PAYMENT_CREATED_MESSAGE_MAX_BYTES,
): ValidatedPaymentEventMessage {
  if (message.properties.type === 'payment.created.v1') {
    return validatePaymentCreatedMessage(message, maxBodyBytes);
  }
  if (
    message.properties.type === 'payment.captured.v1' ||
    message.properties.type === 'payment.refunded.v1'
  ) {
    return validatePaymentLifecycleMessage(message, maxBodyBytes);
  }
  throw new PaymentLifecycleMessageContractError('message_schema_unsupported');
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
  assertNoDuplicateTopLevelKeys,
  parseEventBody,
  parseExactSafeInteger,
};
