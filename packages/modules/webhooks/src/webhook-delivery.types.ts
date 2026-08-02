import type { EncryptedWebhookSecret, WebhookEndpointStatus } from './webhook.types';

export type WebhookDeliveryStatus = 'dead_lettered' | 'delivered' | 'pending' | 'retrying';
export type WebhookDeliveryAttemptOutcome =
  'delivered' | 'non_retryable_failure' | 'retryable_failure' | 'unknown';

export interface WebhookDeliverySignal {
  readonly attemptNumber?: number;
  readonly claimed?: number;
  readonly code?: string;
  readonly count?: number;
  readonly deadLettered?: number;
  readonly deliveryId?: string;
  readonly delivered?: number;
  readonly durationMs?: number;
  readonly endpointId?: string;
  readonly event: string;
  readonly eventId?: string;
  readonly httpStatus?: number;
  readonly merchantId?: string;
  readonly nextAttemptAt?: string;
  readonly ownershipLost?: number;
  readonly recoveredUnknown?: number;
  readonly retrying?: number;
  readonly status?: WebhookDeliveryStatus;
}

export type WebhookDeliverySignalSink = (signal: WebhookDeliverySignal) => void;

export interface ClaimedWebhookDelivery {
  readonly attemptCount: number;
  readonly claimToken: string;
  readonly deliveryId: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly merchantId: string;
  readonly publicId: string;
}

export interface StoredWebhookSecret extends EncryptedWebhookSecret {
  readonly lifecycle: 'current' | 'previous';
  readonly overlapExpiresAt: Date | undefined;
}

export interface WebhookDeliveryContext {
  readonly body: Uint8Array;
  readonly claim: ClaimedWebhookDelivery;
  readonly currentSecret: StoredWebhookSecret;
  readonly endpointStatus: WebhookEndpointStatus;
  readonly eventType: 'payment.created.v1';
  readonly normalizedUrl: string;
  readonly previousSecret: StoredWebhookSecret | undefined;
  readonly schemaVersion: 1;
}

export interface StartedWebhookDeliveryAttempt {
  readonly attemptNumber: number;
  readonly currentSecretVersion: number;
  readonly nextAttemptAt: Date | undefined;
  readonly previousSecretVersion: number | undefined;
  readonly signatureTimestamp: bigint;
  readonly startedAt: Date;
}

export type StartWebhookDeliveryAttemptResult =
  | { readonly attemptNumber: number; readonly kind: 'inactive' }
  | { readonly kind: 'ownership_lost' }
  | { readonly attempt: StartedWebhookDeliveryAttempt; readonly kind: 'started' };

export interface WebhookDeliveryAttemptEvidence {
  readonly errorCode: string | undefined;
  readonly httpStatus: number | undefined;
  readonly outcome: Exclude<WebhookDeliveryAttemptOutcome, 'unknown'>;
  readonly responseBodySha256: Uint8Array | undefined;
  readonly responseBodyTruncated: boolean;
}

export interface WebhookDeliveryRecoveryResult {
  readonly clearedUnstarted: number;
  readonly deadLettered: number;
  readonly recoveredUnknown: number;
}

export interface WebhookDeliveryFinalizationResult {
  readonly status: 'dead_lettered' | 'delivered' | 'retrying';
  readonly updated: boolean;
}

export interface WebhookDeliveryRepository {
  checkReadiness(): Promise<boolean>;
  claimDue(workerId: string, batchSize: number): Promise<readonly ClaimedWebhookDelivery[]>;
  finalizeAttempt(
    claim: ClaimedWebhookDelivery,
    attempt: StartedWebhookDeliveryAttempt,
    evidence: WebhookDeliveryAttemptEvidence,
  ): Promise<WebhookDeliveryFinalizationResult>;
  loadContext(claim: ClaimedWebhookDelivery): Promise<WebhookDeliveryContext | undefined>;
  recoverExpired(limit: number): Promise<WebhookDeliveryRecoveryResult>;
  releaseUnstarted(claim: ClaimedWebhookDelivery): Promise<boolean>;
  startAttempt(
    context: WebhookDeliveryContext,
    retryDelayMs: number | undefined,
  ): Promise<StartWebhookDeliveryAttemptResult>;
}

export interface ResolvedWebhookDestination {
  readonly address: string;
  readonly family: 4 | 6;
  readonly hostname: string;
  readonly url: string;
}

export interface WebhookDeliveryUrlPolicy {
  resolveForDelivery(normalizedUrl: string): Promise<ResolvedWebhookDestination>;
}

export type WebhookHttpFailureCode =
  | 'connection_refused'
  | 'connection_reset'
  | 'destination_prohibited'
  | 'dns_unavailable'
  | 'dns_unresolvable'
  | 'network_error'
  | 'request_timeout'
  | 'tls_verification_failed';

export type WebhookHttpResult =
  | { readonly code: WebhookHttpFailureCode; readonly kind: 'failure' }
  | {
      readonly bodySha256: Uint8Array | undefined;
      readonly bodyTruncated: boolean;
      readonly kind: 'response';
      readonly statusCode: number;
    };

export interface WebhookHttpRequest {
  readonly body: Uint8Array;
  readonly destination: ResolvedWebhookDestination;
  readonly headers: Readonly<Record<string, string>>;
}

export interface WebhookHttpClient {
  abortActive(): void;
  deliver(request: WebhookHttpRequest): Promise<WebhookHttpResult>;
}

export interface WebhookDeliveryRunResult {
  readonly claimed: number;
  readonly deadLettered: number;
  readonly delivered: number;
  readonly dispatcherReady: boolean;
  readonly ownershipLost: number;
  readonly recoveredUnknown: number;
  readonly retrying: number;
}
