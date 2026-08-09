const SAFE_STRING_FIELDS = new Set([
  'code',
  'command',
  'consumer',
  'context',
  'currency',
  'dependency',
  'deliveryId',
  'endpointId',
  'environment',
  'event',
  'eventId',
  'eventType',
  'exchange',
  'level',
  'ledgerTransactionId',
  'merchantId',
  'method',
  'module',
  'operation',
  'outcome',
  'releaseCommit',
  'releaseVersion',
  'paymentId',
  'reconciliationId',
  'refundId',
  'requestId',
  'route',
  'routingKey',
  'safeResourceId',
  'service',
  'settlementId',
  'signal',
  'spanId',
  'status',
  'statusClass',
  'timestamp',
  'traceId',
  'nextAttemptAt',
]);

const SAFE_NUMBER_FIELDS = new Set([
  'attempt',
  'claimed',
  'count',
  'deadLettered',
  'delivered',
  'durationMs',
  'failed',
  'httpStatus',
  'ownershipLost',
  'published',
  'recoveredUnknown',
  'retryCount',
  'retrying',
]);

const PROHIBITED_FIELD =
  /(amount|authorization|body|checksum|credential|csv|database.*url|destination|dns|exception|external.*ref|header|idempotency.*key|message|password|provider.*ref|query|rabbitmq.*url|raw|request.*body|response.*body|secret|signature|sql|stack|token|url)/iu;

const PROHIBITED_VALUE =
  /(?:bearer\s|(?:amqp|http|postgres)(?:s)?:\/\/|whsec_|api[_-]?key|idempotency[_-]?key)/iu;

const SAFE_STRING_VALUE = /^[\p{L}\p{N}_.:/@ -]{1,256}$/u;

export type SafeTelemetryFields = Readonly<Record<string, boolean | number | string | undefined>>;

export function redactTelemetryFields(fields: Record<string, unknown>): SafeTelemetryFields {
  const safe: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (PROHIBITED_FIELD.test(key)) continue;
    if (SAFE_NUMBER_FIELDS.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      safe[key] = value;
      continue;
    }
    if (
      SAFE_STRING_FIELDS.has(key) &&
      typeof value === 'string' &&
      SAFE_STRING_VALUE.test(value) &&
      !PROHIBITED_VALUE.test(value)
    ) {
      safe[key] = value;
      continue;
    }
    if ((key === 'ready' || key === 'redelivered') && typeof value === 'boolean') safe[key] = value;
  }
  return safe;
}

export const redactionInternals = {
  PROHIBITED_FIELD,
  PROHIBITED_VALUE,
  SAFE_NUMBER_FIELDS,
  SAFE_STRING_FIELDS,
  SAFE_STRING_VALUE,
};
