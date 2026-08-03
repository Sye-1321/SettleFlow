import type { ClaimedOutboxEvent } from './outbox-relay.types';
import { createHash } from 'node:crypto';
import type { ConsumeMessage } from 'amqplib';
import { paymentEventRoute } from './rabbitmq-topology';

export class OperationalEventContractError extends Error {
  public constructor() {
    super('Operational event does not satisfy its accepted contract.');
  }
}

const EVENT_ID_PATTERN = /^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SETTLEMENT_BATCH_ID_PATTERN = /^stb_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const RECONCILIATION_IMPORT_ID_PATTERN = /^rec_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UTC_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface SerializedOperationalEvent {
  readonly aggregateId: string;
  readonly aggregateType: 'reconciliation_import' | 'settlement_batch';
  readonly content: Buffer;
  readonly eventId: string;
  readonly eventType: 'reconciliation.completed.v1' | 'settlement.finalized.v1';
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly routingKey: 'reconciliation.completed.v1' | 'settlement.finalized.v1';
}

export interface ValidatedOperationalEventMessage {
  readonly event: Readonly<Record<string, unknown>> & {
    readonly eventId: string;
    readonly eventType: 'reconciliation.completed.v1' | 'settlement.finalized.v1';
    readonly merchantId: string;
    readonly occurredAt: Date;
    readonly requestId: string;
  };
  readonly payloadBytes: Uint8Array;
  readonly payloadSha256: Uint8Array;
  readonly redelivered: boolean;
  readonly schemaVersion: 1;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function safeInteger(value: unknown, allowNegative = false): value is number {
  return Number.isSafeInteger(value) && (allowNegative || Number(value) >= 0);
}

function exactUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_MILLISECOND_PATTERN.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function serializeOperationalEvent(event: ClaimedOutboxEvent): SerializedOperationalEvent {
  if (!isRecord(event.payload)) throw new OperationalEventContractError();
  const payload = event.payload;
  const common =
    payload['eventId'] === event.eventId &&
    payload['eventType'] === event.eventType &&
    payload['merchantId'] === event.merchantId &&
    payload['requestId'] === event.requestId &&
    payload['occurredAt'] === event.occurredAt.toISOString() &&
    EVENT_ID_PATTERN.test(event.eventId) &&
    UUID_PATTERN.test(event.merchantId) &&
    REQUEST_ID_PATTERN.test(event.requestId) &&
    exactUtcTimestamp(payload['occurredAt']);
  if (!common) throw new OperationalEventContractError();

  if (event.eventType === 'settlement.finalized.v1') {
    const keys = [
      'eventId',
      'eventType',
      'occurredAt',
      'requestId',
      'merchantId',
      'batchId',
      'cutoffAt',
      'grossAmountMinor',
      'feeAmountMinor',
      'netAmountMinor',
      'currency',
      'itemCount',
    ] as const;
    if (
      !exactKeys(payload, keys) ||
      event.aggregateType !== 'settlement_batch' ||
      payload['batchId'] !== event.aggregateId ||
      !SETTLEMENT_BATCH_ID_PATTERN.test(event.aggregateId) ||
      (payload['currency'] !== 'ETB' && payload['currency'] !== 'USD') ||
      !safeInteger(payload['grossAmountMinor']) ||
      !safeInteger(payload['feeAmountMinor']) ||
      !safeInteger(payload['netAmountMinor']) ||
      !safeInteger(payload['itemCount']) ||
      Number(payload['grossAmountMinor']) < 1 ||
      Number(payload['netAmountMinor']) < 1 ||
      Number(payload['itemCount']) < 1 ||
      Number(payload['itemCount']) > 500 ||
      Number(payload['grossAmountMinor']) !==
        Number(payload['feeAmountMinor']) + Number(payload['netAmountMinor']) ||
      !exactUtcTimestamp(payload['cutoffAt'])
    )
      throw new OperationalEventContractError();
    return {
      aggregateId: event.aggregateId,
      aggregateType: 'settlement_batch',
      content: Buffer.from(JSON.stringify(payload)),
      eventId: event.eventId,
      eventType: event.eventType,
      merchantId: event.merchantId,
      occurredAt: event.occurredAt,
      requestId: event.requestId,
      routingKey: event.eventType,
    };
  }

  if (event.eventType === 'reconciliation.completed.v1') {
    const keys = [
      'eventId',
      'eventType',
      'occurredAt',
      'requestId',
      'merchantId',
      'importId',
      'matchedExactCount',
      'mismatchCount',
      'unexplainedDifferenceMinorByCurrency',
    ] as const;
    const differences = payload['unexplainedDifferenceMinorByCurrency'];
    if (
      !exactKeys(payload, keys) ||
      event.aggregateType !== 'reconciliation_import' ||
      payload['importId'] !== event.aggregateId ||
      !RECONCILIATION_IMPORT_ID_PATTERN.test(event.aggregateId) ||
      !safeInteger(payload['matchedExactCount']) ||
      !safeInteger(payload['mismatchCount']) ||
      !isRecord(differences) ||
      !exactKeys(differences, ['ETB', 'USD']) ||
      !safeInteger(differences['ETB'], true) ||
      !safeInteger(differences['USD'], true)
    )
      throw new OperationalEventContractError();
    return {
      aggregateId: event.aggregateId,
      aggregateType: 'reconciliation_import',
      content: Buffer.from(JSON.stringify(payload)),
      eventId: event.eventId,
      eventType: event.eventType,
      merchantId: event.merchantId,
      occurredAt: event.occurredAt,
      requestId: event.requestId,
      routingKey: event.eventType,
    };
  }
  throw new OperationalEventContractError();
}

export function validateOperationalEventMessage(
  raw: ConsumeMessage,
  bodyLimitBytes: number,
): ValidatedOperationalEventMessage {
  if (raw.content.length > bodyLimitBytes) throw new OperationalEventContractError();
  const type: unknown = raw.properties.type;
  if (type !== 'settlement.finalized.v1' && type !== 'reconciliation.completed.v1')
    throw new OperationalEventContractError();
  const route = paymentEventRoute(type);
  const headers = raw.properties.headers ?? {};
  if (
    raw.fields.exchange !== route.exchange ||
    raw.fields.routingKey !== type ||
    raw.properties.contentType !== 'application/json' ||
    raw.properties.contentEncoding !== 'utf-8' ||
    raw.properties.deliveryMode !== 2 ||
    raw.properties.appId !== 'settleflow-worker' ||
    headers['x-settleflow-schema-version'] !== 1 ||
    typeof headers['x-settleflow-publish-attempt'] !== 'number' ||
    !Number.isInteger(headers['x-settleflow-publish-attempt']) ||
    Number(headers['x-settleflow-publish-attempt']) < 1 ||
    raw.properties.messageId === undefined ||
    raw.properties.correlationId === undefined
  )
    throw new OperationalEventContractError();
  let payload: unknown;
  try {
    payload = JSON.parse(raw.content.toString('utf8'));
  } catch {
    throw new OperationalEventContractError();
  }
  if (!isRecord(payload)) throw new OperationalEventContractError();
  const occurredAt = new Date(String(payload['occurredAt']));
  const claimed: ClaimedOutboxEvent = {
    aggregateId: String(headers['x-settleflow-aggregate-id']),
    aggregateType: String(headers['x-settleflow-aggregate-type']),
    attemptCount: 1,
    eventId: String(raw.properties.messageId),
    eventType: type,
    id: 'validation-only',
    merchantId: String(headers['x-settleflow-merchant-id']),
    occurredAt,
    payload,
    requestId: String(raw.properties.correlationId),
  };
  serializeOperationalEvent(claimed);
  if (raw.properties.timestamp !== Math.floor(occurredAt.getTime() / 1_000)) {
    throw new OperationalEventContractError();
  }
  return {
    event: {
      ...payload,
      eventId: claimed.eventId,
      eventType: type,
      merchantId: claimed.merchantId,
      occurredAt,
      requestId: claimed.requestId,
    },
    payloadBytes: Uint8Array.from(raw.content),
    payloadSha256: createHash('sha256').update(raw.content).digest(),
    redelivered: raw.fields.redelivered,
    schemaVersion: 1,
  };
}
