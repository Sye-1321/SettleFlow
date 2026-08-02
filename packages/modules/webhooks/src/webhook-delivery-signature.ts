import { createHmac, timingSafeEqual } from 'node:crypto';

const DELIVERY_ID_PATTERN = /^whd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const EVENT_ID_PATTERN = /^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SIGNATURE_PATTERN = /^v1,([A-Za-z0-9_-]{43})$/u;

export interface WebhookSigningSecret {
  readonly plaintext: string;
  readonly secretVersion: number;
}

export interface BuildWebhookRequestHeadersInput {
  readonly body: Uint8Array;
  readonly current: WebhookSigningSecret;
  readonly deliveryId: string;
  readonly eventId: string;
  readonly eventType: 'payment.captured.v1' | 'payment.created.v1' | 'payment.refunded.v1';
  readonly previous?: WebhookSigningSecret;
  readonly timestamp: bigint;
}

function signatureInput(timestamp: bigint, deliveryId: string, body: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.${deliveryId}.`, 'ascii'), Buffer.from(body)]);
}

function sign(secret: string, input: Uint8Array): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function assertSigningInput(input: BuildWebhookRequestHeadersInput): void {
  if (
    !DELIVERY_ID_PATTERN.test(input.deliveryId) ||
    !EVENT_ID_PATTERN.test(input.eventId) ||
    input.timestamp <= 0n ||
    !/^whsec_[A-Za-z0-9_-]{43}$/u.test(input.current.plaintext) ||
    (input.previous !== undefined && !/^whsec_[A-Za-z0-9_-]{43}$/u.test(input.previous.plaintext))
  ) {
    throw new Error('Webhook signing input is invalid');
  }
}

export function buildWebhookRequestHeaders(
  input: BuildWebhookRequestHeadersInput,
): Readonly<Record<string, string>> {
  assertSigningInput(input);
  const bytes = signatureInput(input.timestamp, input.deliveryId, input.body);
  const signatures = [`v1,${sign(input.current.plaintext, bytes)}`];
  if (input.previous !== undefined) {
    signatures.push(`v1,${sign(input.previous.plaintext, bytes)}`);
  }
  return {
    'Content-Length': String(input.body.byteLength),
    'Content-Type': 'application/json',
    'SettleFlow-Event-Id': input.eventId,
    'SettleFlow-Event-Schema-Version': '1',
    'SettleFlow-Event-Type': input.eventType,
    'SettleFlow-Signature': signatures.join(';'),
    'SettleFlow-Timestamp': String(input.timestamp),
    'SettleFlow-Webhook-Id': input.deliveryId,
    'User-Agent': 'SettleFlow-Webhooks/1.0',
  };
}

export function verifyWebhookSignature(input: {
  readonly body: Uint8Array;
  readonly deliveryId: string;
  readonly nowEpochSeconds: bigint;
  readonly secret: string;
  readonly signatureHeader: string;
  readonly timestampHeader: string;
  readonly toleranceSeconds?: bigint;
}): boolean {
  if (
    !/^[1-9][0-9]*$/u.test(input.timestampHeader) ||
    !DELIVERY_ID_PATTERN.test(input.deliveryId)
  ) {
    return false;
  }
  const timestamp = BigInt(input.timestampHeader);
  const tolerance = input.toleranceSeconds ?? 300n;
  if (
    timestamp > input.nowEpochSeconds + tolerance ||
    timestamp < input.nowEpochSeconds - tolerance
  ) {
    return false;
  }
  const expected = Buffer.from(
    sign(input.secret, signatureInput(timestamp, input.deliveryId, input.body)),
    'base64url',
  );
  return input.signatureHeader.split(';').some((entry) => {
    const match = SIGNATURE_PATTERN.exec(entry);
    if (match?.[1] === undefined) return false;
    const candidate = Buffer.from(match[1], 'base64url');
    return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
  });
}

export const webhookDeliverySignatureInternals = {
  DELIVERY_ID_PATTERN,
  EVENT_ID_PATTERN,
  SIGNATURE_PATTERN,
  signatureInput,
  sign,
};
