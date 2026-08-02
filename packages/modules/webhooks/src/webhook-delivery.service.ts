import { randomInt } from 'node:crypto';

import type { WebhookKeyring } from './webhook-secret-crypto';
import { WebhookSecretCipher } from './webhook-secret-crypto';
import {
  WebhookEndpointUrlProhibitedError,
  WebhookEndpointUrlResolutionUnavailableError,
  WebhookEndpointUrlUnresolvableError,
  WebhookKeyringUnavailableError,
} from './webhook.errors';
import type {
  ClaimedWebhookDelivery,
  WebhookDeliveryContext,
  WebhookDeliveryRepository,
  WebhookDeliveryRunResult,
  WebhookDeliverySignalSink,
  WebhookDeliveryUrlPolicy,
  WebhookHttpClient,
  WebhookHttpResult,
} from './webhook-delivery.types';
import { calculateWebhookRetryDelayMs, classifyWebhookResult } from './webhook-delivery-retry';
import {
  buildWebhookRequestHeaders,
  type WebhookSigningSecret,
} from './webhook-delivery-signature';

export interface WebhookDeliveryServiceOptions {
  readonly random?: () => number;
  readonly signal?: WebhookDeliverySignalSink;
}

function secureRandomFraction(): number {
  return randomInt(0, 0x1_0000_0000) / 0x1_0000_0000;
}

type ClaimResult =
  'dead_lettered' | 'delivered' | 'dependency_unavailable' | 'ownership_lost' | 'retrying';

export class WebhookDeliveryService {
  private dependencyReady = true;
  private readonly random: () => number;
  private readonly signal: WebhookDeliverySignalSink;
  private stopping = false;

  public constructor(
    private readonly repository: WebhookDeliveryRepository,
    private readonly keyring: WebhookKeyring,
    private readonly cipher: WebhookSecretCipher,
    private readonly urlPolicy: WebhookDeliveryUrlPolicy,
    private readonly httpClient: WebhookHttpClient,
    options: WebhookDeliveryServiceOptions = {},
  ) {
    this.random = options.random ?? secureRandomFraction;
    this.signal = options.signal ?? ((): void => undefined);
  }

  public async ensureReady(): Promise<boolean> {
    if (this.stopping) return false;
    try {
      this.keyring.active();
      this.dependencyReady = await this.repository.checkReadiness();
    } catch {
      this.dependencyReady = false;
    }
    return this.dependencyReady;
  }

  public isReady(): boolean {
    return !this.stopping && this.dependencyReady;
  }

  public beginShutdown(): void {
    this.stopping = true;
  }

  public abortActive(): void {
    this.httpClient.abortActive();
  }

  public async runOnce(workerId: string, batchSize: number): Promise<WebhookDeliveryRunResult> {
    const empty = {
      claimed: 0,
      deadLettered: 0,
      delivered: 0,
      dispatcherReady: this.isReady(),
      ownershipLost: 0,
      recoveredUnknown: 0,
      retrying: 0,
    } satisfies WebhookDeliveryRunResult;
    if (this.stopping) return empty;

    const recovery = await this.repository.recoverExpired(batchSize);
    if (recovery.recoveredUnknown > 0 || recovery.clearedUnstarted > 0) {
      this.signal({
        code: recovery.deadLettered > 0 ? 'recovered_with_terminal' : 'recovered',
        count: recovery.recoveredUnknown + recovery.clearedUnstarted,
        event: 'webhook.delivery.lease_recovered',
      });
    }
    const claims = await this.repository.claimDue(workerId, batchSize);
    if (claims.length === 0) {
      return {
        ...empty,
        deadLettered: recovery.deadLettered,
        recoveredUnknown: recovery.recoveredUnknown,
      };
    }

    const results = await Promise.all(claims.map(async (claim) => this.processClaim(claim)));
    const count = (kind: ClaimResult): number => results.filter((result) => result === kind).length;
    const dependencyUnavailable = count('dependency_unavailable') > 0;
    if (dependencyUnavailable) this.dependencyReady = false;
    return {
      claimed: claims.length,
      deadLettered: recovery.deadLettered + count('dead_lettered'),
      delivered: count('delivered'),
      dispatcherReady: !dependencyUnavailable && this.isReady(),
      ownershipLost: count('ownership_lost'),
      recoveredUnknown: recovery.recoveredUnknown,
      retrying: count('retrying'),
    };
  }

  private async processClaim(claim: ClaimedWebhookDelivery): Promise<ClaimResult> {
    const context = await this.repository.loadContext(claim);
    if (context === undefined) {
      this.recordOwnershipLost(claim);
      return 'ownership_lost';
    }
    const retryDelayMs = calculateWebhookRetryDelayMs(claim.attemptCount + 2, this.random);

    let current: WebhookSigningSecret | undefined;
    let previous: WebhookSigningSecret | undefined;
    if (context.endpointStatus === 'active') {
      try {
        current = this.decrypt(context, context.currentSecret);
        if (context.previousSecret !== undefined) {
          previous = this.decrypt(context, context.previousSecret);
        }
      } catch {
        await this.repository.releaseUnstarted(claim);
        this.signal({
          code: 'keyring_unavailable',
          deliveryId: claim.publicId,
          endpointId: claim.endpointId,
          event: 'webhook.delivery.dependency_unavailable',
          eventId: claim.eventId,
          merchantId: claim.merchantId,
        });
        return 'dependency_unavailable';
      }
    }

    const started = await this.repository.startAttempt(context, retryDelayMs);
    if (started.kind === 'ownership_lost') {
      this.recordOwnershipLost(claim);
      return 'ownership_lost';
    }
    if (started.kind === 'inactive') {
      this.signal({
        attemptNumber: started.attemptNumber,
        code: 'endpoint_inactive',
        deliveryId: claim.publicId,
        endpointId: claim.endpointId,
        event: 'webhook.delivery.dead_lettered',
        eventId: claim.eventId,
        merchantId: claim.merchantId,
        status: 'dead_lettered',
      });
      return 'dead_lettered';
    }
    const attempt = started.attempt;
    if (current?.secretVersion !== attempt.currentSecretVersion) {
      this.dependencyReady = false;
      return 'dependency_unavailable';
    }
    const selectedPrevious =
      previous?.secretVersion === attempt.previousSecretVersion ? previous : undefined;
    if (attempt.previousSecretVersion !== undefined && selectedPrevious === undefined) {
      this.dependencyReady = false;
      return 'dependency_unavailable';
    }

    const headers = buildWebhookRequestHeaders({
      body: context.body,
      current,
      deliveryId: claim.publicId,
      eventId: claim.eventId,
      eventType: context.eventType,
      ...(selectedPrevious === undefined ? {} : { previous: selectedPrevious }),
      timestamp: attempt.signatureTimestamp,
    });
    this.signal({
      attemptNumber: attempt.attemptNumber,
      deliveryId: claim.publicId,
      endpointId: claim.endpointId,
      event: 'webhook.delivery.attempt_started',
      eventId: claim.eventId,
      merchantId: claim.merchantId,
    });

    const httpResult = await this.deliver(context, headers);
    const classified = classifyWebhookResult(attempt.attemptNumber, httpResult);
    const finalized = await this.repository.finalizeAttempt(claim, attempt, classified.evidence);
    if (!finalized.updated) {
      this.recordOwnershipLost(claim);
      return 'ownership_lost';
    }
    this.signal({
      attemptNumber: attempt.attemptNumber,
      ...(classified.evidence.errorCode === undefined
        ? {}
        : { code: classified.evidence.errorCode }),
      deliveryId: claim.publicId,
      endpointId: claim.endpointId,
      event:
        finalized.status === 'delivered'
          ? 'webhook.delivery.delivered'
          : finalized.status === 'retrying'
            ? 'webhook.delivery.retry_scheduled'
            : 'webhook.delivery.dead_lettered',
      eventId: claim.eventId,
      ...(classified.evidence.httpStatus === undefined
        ? {}
        : { httpStatus: classified.evidence.httpStatus }),
      merchantId: claim.merchantId,
      ...(attempt.nextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: attempt.nextAttemptAt.toISOString() }),
      status: finalized.status,
    });
    return finalized.status;
  }

  private decrypt(
    context: WebhookDeliveryContext,
    secret: WebhookDeliveryContext['currentSecret'],
  ): WebhookSigningSecret {
    try {
      return {
        plaintext: this.cipher.decrypt(
          {
            endpointId: context.claim.endpointId,
            merchantId: context.claim.merchantId,
            secretVersion: secret.secretVersion,
          },
          secret,
        ),
        secretVersion: secret.secretVersion,
      };
    } catch {
      throw new WebhookKeyringUnavailableError();
    }
  }

  private async deliver(
    context: WebhookDeliveryContext,
    headers: Readonly<Record<string, string>>,
  ): Promise<WebhookHttpResult> {
    try {
      const destination = await this.urlPolicy.resolveForDelivery(context.normalizedUrl);
      return await this.httpClient.deliver({ body: context.body, destination, headers });
    } catch (error: unknown) {
      if (error instanceof WebhookEndpointUrlResolutionUnavailableError) {
        return { code: 'dns_unavailable', kind: 'failure' };
      }
      if (error instanceof WebhookEndpointUrlUnresolvableError) {
        return { code: 'dns_unresolvable', kind: 'failure' };
      }
      if (error instanceof WebhookEndpointUrlProhibitedError) {
        return { code: 'destination_prohibited', kind: 'failure' };
      }
      return { code: 'network_error', kind: 'failure' };
    }
  }

  private recordOwnershipLost(claim: ClaimedWebhookDelivery): void {
    this.signal({
      code: 'claim_ownership_lost',
      deliveryId: claim.publicId,
      endpointId: claim.endpointId,
      event: 'webhook.delivery.ownership_lost',
      eventId: claim.eventId,
      merchantId: claim.merchantId,
    });
  }
}
