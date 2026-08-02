import type {
  WebhookDeliveryAttemptEvidence,
  WebhookDeliveryFinalizationResult,
  WebhookHttpFailureCode,
  WebhookHttpResult,
} from './webhook-delivery.types';

const RETRY_CEILINGS_MS = new Map<number, number>([
  [2, 60_000],
  [3, 5 * 60_000],
  [4, 15 * 60_000],
  [5, 60 * 60_000],
  [6, 6 * 60 * 60_000],
  [7, 24 * 60 * 60_000],
]);

const RETRYABLE_TRANSPORT_CODES = new Set<WebhookHttpFailureCode>([
  'connection_refused',
  'connection_reset',
  'dns_unavailable',
  'network_error',
  'request_timeout',
]);

export function calculateWebhookRetryDelayMs(
  nextAttemptNumber: number,
  random: () => number,
): number | undefined {
  const ceiling = RETRY_CEILINGS_MS.get(nextAttemptNumber);
  if (ceiling === undefined) {
    return undefined;
  }
  const sample = Math.max(0, Math.min(0.999_999_999, random()));
  return Math.floor(sample * (ceiling + 1));
}

export interface ClassifiedWebhookResult {
  readonly evidence: WebhookDeliveryAttemptEvidence;
  readonly status: WebhookDeliveryFinalizationResult['status'];
}

function terminalOrRetrying(attemptNumber: number): 'dead_lettered' | 'retrying' {
  return attemptNumber >= 7 ? 'dead_lettered' : 'retrying';
}

function httpErrorCode(status: number): string {
  if (status === 408) return 'http_408';
  if (status === 429) return 'http_429';
  if (status >= 500) return 'http_5xx';
  if (status >= 300 && status <= 399) return 'http_redirect';
  if (status >= 400 && status <= 499) return 'http_client_error';
  return 'http_unexpected_status';
}

export function classifyWebhookResult(
  attemptNumber: number,
  result: WebhookHttpResult,
): ClassifiedWebhookResult {
  if (result.kind === 'failure') {
    const retryable = RETRYABLE_TRANSPORT_CODES.has(result.code);
    return {
      evidence: {
        errorCode: result.code,
        httpStatus: undefined,
        outcome: retryable ? 'retryable_failure' : 'non_retryable_failure',
        responseBodySha256: undefined,
        responseBodyTruncated: false,
      },
      status: retryable ? terminalOrRetrying(attemptNumber) : 'dead_lettered',
    };
  }

  const baseEvidence = {
    httpStatus: result.statusCode,
    responseBodySha256: result.bodySha256,
    responseBodyTruncated: result.bodyTruncated,
  } as const;
  if (result.statusCode >= 200 && result.statusCode <= 299) {
    return {
      evidence: {
        ...baseEvidence,
        errorCode: undefined,
        outcome: 'delivered',
      },
      status: 'delivered',
    };
  }

  const retryable =
    result.statusCode === 408 || result.statusCode === 429 || result.statusCode >= 500;
  return {
    evidence: {
      ...baseEvidence,
      errorCode: httpErrorCode(result.statusCode),
      outcome: retryable ? 'retryable_failure' : 'non_retryable_failure',
    },
    status: retryable ? terminalOrRetrying(attemptNumber) : 'dead_lettered',
  };
}

export const webhookDeliveryRetryInternals = { RETRY_CEILINGS_MS, RETRYABLE_TRANSPORT_CODES };
