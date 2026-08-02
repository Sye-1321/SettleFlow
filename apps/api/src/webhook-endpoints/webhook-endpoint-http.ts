import {
  InvalidWebhookEndpointRequestError,
  WebhookEndpointPreconditionRequiredError,
} from '@settleflow/webhooks';

import { headerValues, type RequestWithRequestId } from '../http/request-id';

const WEBHOOK_ID_SOURCE = 'whe_[0-9A-HJKMNP-TV-Z]{26}';
const ETAG_PATTERN = new RegExp(`^"(${WEBHOOK_ID_SOURCE})\\.v(0|[1-9][0-9]*)"$`, 'u');
const MAX_VERSION = 2_147_483_647;

export interface WebhookHttpRequest extends RequestWithRequestId {
  readonly rawBody?: Buffer;
}

export function requireJsonContentType(request: WebhookHttpRequest): void {
  const values = headerValues(request, 'content-type');
  if (
    values.length !== 1 ||
    values[0]?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    throw new InvalidWebhookEndpointRequestError('Content-Type');
  }
}

export function requireEmptyBody(request: WebhookHttpRequest): void {
  const lengths = headerValues(request, 'content-length');
  const transferEncoding = headerValues(request, 'transfer-encoding');
  if (
    (request.rawBody !== undefined && request.rawBody.byteLength > 0) ||
    lengths.some((value) => value !== '0') ||
    transferEncoding.length > 0
  ) {
    throw new InvalidWebhookEndpointRequestError();
  }
}

export function formatWebhookEtag(publicId: string, version: number): string {
  return `"${publicId}.v${String(version)}"`;
}

export function parseWebhookIfMatch(request: WebhookHttpRequest, expectedPublicId: string): number {
  const values = headerValues(request, 'if-match');
  if (values.length === 0) {
    throw new WebhookEndpointPreconditionRequiredError();
  }
  if (values.length !== 1) {
    throw new InvalidWebhookEndpointRequestError('If-Match');
  }
  const match = ETAG_PATTERN.exec(values[0] ?? '');
  if (match?.[1] !== expectedPublicId) {
    throw new InvalidWebhookEndpointRequestError('If-Match');
  }
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 0 || version > MAX_VERSION) {
    throw new InvalidWebhookEndpointRequestError('If-Match');
  }
  return version;
}

export interface ParsedWebhookListQuery {
  readonly afterPublicId: string | undefined;
  readonly limit: number;
}

export function encodeWebhookCursor(publicId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, id: publicId }), 'utf8').toString('base64url');
}

function decodeWebhookCursor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new InvalidWebhookEndpointRequestError('cursor');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) {
    throw new InvalidWebhookEndpointRequestError('cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new InvalidWebhookEndpointRequestError('cursor');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidWebhookEndpointRequestError('cursor');
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    record['v'] !== 1 ||
    typeof record['id'] !== 'string' ||
    !new RegExp(`^${WEBHOOK_ID_SOURCE}$`, 'u').test(record['id']) ||
    JSON.stringify({ v: 1, id: record['id'] }) !== bytes.toString('utf8')
  ) {
    throw new InvalidWebhookEndpointRequestError('cursor');
  }
  return record['id'];
}

export function parseWebhookListQuery(value: unknown): ParsedWebhookListQuery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidWebhookEndpointRequestError();
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'cursor' && key !== 'limit')) {
    throw new InvalidWebhookEndpointRequestError();
  }
  const rawLimit = record['limit'];
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== 'string' || !/^[1-9][0-9]*$/u.test(rawLimit))
  ) {
    throw new InvalidWebhookEndpointRequestError('limit');
  }
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidWebhookEndpointRequestError('limit');
  }
  return { afterPublicId: decodeWebhookCursor(record['cursor']), limit };
}

export const webhookEndpointHttpInternals = {
  ETAG_PATTERN,
  WEBHOOK_ID_SOURCE,
  decodeWebhookCursor,
};
