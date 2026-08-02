import { InvalidWebhookEndpointRequestError, UnsupportedWebhookEventError } from './webhook.errors';
import {
  WEBHOOK_SUBSCRIPTIONS,
  type WebhookEndpointStatus,
  type WebhookSubscription,
} from './webhook.types';

const WEBHOOK_ID_PATTERN = /^whe_[0-9A-HJKMNP-TV-Z]{26}$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new InvalidWebhookEndpointRequestError();
  }
}

export function assertWebhookEndpointId(value: string): void {
  if (!WEBHOOK_ID_PATTERN.test(value)) {
    throw new InvalidWebhookEndpointRequestError('id');
  }
}

export function parseSubscriptions(value: unknown): readonly WebhookSubscription[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidWebhookEndpointRequestError('subscriptions');
  }
  if (value.some((item) => typeof item !== 'string')) {
    throw new InvalidWebhookEndpointRequestError('subscriptions');
  }
  if (new Set(value).size !== value.length) {
    throw new InvalidWebhookEndpointRequestError('subscriptions');
  }
  if (value.some((item) => !WEBHOOK_SUBSCRIPTIONS.includes(item as WebhookSubscription))) {
    throw new UnsupportedWebhookEventError();
  }
  const selected = new Set(value as WebhookSubscription[]);
  return WEBHOOK_SUBSCRIPTIONS.filter((eventType) => selected.has(eventType));
}

export interface ParsedCreateWebhookEndpoint {
  readonly subscriptions: readonly WebhookSubscription[];
  readonly url: string;
}

export function parseCreateWebhookEndpoint(value: unknown): ParsedCreateWebhookEndpoint {
  if (!isPlainRecord(value)) {
    throw new InvalidWebhookEndpointRequestError();
  }
  assertExactKeys(value, ['subscriptions', 'url']);
  if (Object.keys(value).length !== 2 || typeof value['url'] !== 'string') {
    throw new InvalidWebhookEndpointRequestError();
  }
  return { subscriptions: parseSubscriptions(value['subscriptions']), url: value['url'] };
}

export interface ParsedPatchWebhookEndpoint {
  readonly status?: WebhookEndpointStatus;
  readonly subscriptions?: readonly WebhookSubscription[];
}

export function parsePatchWebhookEndpoint(value: unknown): ParsedPatchWebhookEndpoint {
  if (!isPlainRecord(value)) {
    throw new InvalidWebhookEndpointRequestError();
  }
  assertExactKeys(value, ['status', 'subscriptions']);
  const keys = Object.keys(value);
  if (keys.length === 0) {
    throw new InvalidWebhookEndpointRequestError();
  }
  const status = value['status'];
  if (status !== undefined && status !== 'active' && status !== 'inactive') {
    throw new InvalidWebhookEndpointRequestError('status');
  }
  const subscriptions =
    value['subscriptions'] === undefined ? undefined : parseSubscriptions(value['subscriptions']);
  return {
    ...(status === undefined ? {} : { status }),
    ...(subscriptions === undefined ? {} : { subscriptions }),
  };
}

export const webhookValidationInternals = {
  SUPPORTED_SUBSCRIPTIONS: WEBHOOK_SUBSCRIPTIONS,
  WEBHOOK_ID_PATTERN,
  assertExactKeys,
  isPlainRecord,
};
