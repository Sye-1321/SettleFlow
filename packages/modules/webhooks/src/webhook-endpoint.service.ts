import { randomUUID } from 'node:crypto';

import { MonotonicUlidGenerator } from '@settleflow/infrastructure';
import { AuditService } from '@settleflow/operations';

import {
  WebhookEndpointIdentifierCollisionError,
  WebhookEndpointIdentifierGenerationExhaustedError,
  WebhookEndpointNotFoundError,
  WebhookEndpointPreconditionFailedError,
} from './webhook.errors';
import { WebhookSecretCipher } from './webhook-secret-crypto';
import type {
  CreatedWebhookEndpointRepresentation,
  MerchantWebhookActor,
  RotatedWebhookSecretRepresentation,
  WebhookEndpointRecord,
  WebhookEndpointRepresentation,
  WebhookEndpointRepository,
  WebhookEndpointStatus,
  WebhookSubscription,
  WebhookUrlPolicy,
} from './webhook.types';
import { assertWebhookEndpointId } from './webhook.validation';

const MAX_IDENTIFIER_ATTEMPTS = 3;
const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1_000;

function toRepresentation(record: WebhookEndpointRecord): WebhookEndpointRepresentation {
  return {
    createdAt: record.createdAt.toISOString(),
    id: record.publicId,
    status: record.status,
    subscriptions: record.subscriptions,
    updatedAt: record.updatedAt.toISOString(),
    url: record.normalizedUrl,
    version: record.version,
  };
}

function sameSubscriptions(
  left: readonly WebhookSubscription[],
  right: readonly WebhookSubscription[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface CreateWebhookEndpointCommand extends MerchantWebhookActor {
  readonly subscriptions: readonly WebhookSubscription[];
  readonly url: string;
}

export interface PatchWebhookEndpointCommand extends MerchantWebhookActor {
  readonly expectedVersion: number;
  readonly publicId: string;
  readonly status?: WebhookEndpointStatus;
  readonly subscriptions?: readonly WebhookSubscription[];
}

export interface RotateWebhookSecretCommand extends MerchantWebhookActor {
  readonly expectedVersion: number;
  readonly publicId: string;
}

export class WebhookEndpointService {
  public constructor(
    private readonly repository: WebhookEndpointRepository,
    private readonly audit: AuditService,
    private readonly urlPolicy: WebhookUrlPolicy,
    private readonly secrets: WebhookSecretCipher,
    private readonly identifiers: MonotonicUlidGenerator,
    private readonly clock: () => Date = () => new Date(),
    private readonly uuid: () => string = randomUUID,
  ) {}

  public async create(
    command: CreateWebhookEndpointCommand,
  ): Promise<CreatedWebhookEndpointRepresentation> {
    const normalizedUrl = await this.urlPolicy.normalizeAndValidate(command.url);
    const createdAt = this.clock();
    const endpointId = this.uuid();
    const secret = this.secrets.create({
      endpointId,
      merchantId: command.merchantId,
      secretVersion: 1,
    });

    for (let attempt = 1; attempt <= MAX_IDENTIFIER_ATTEMPTS; attempt += 1) {
      const publicId = `whe_${this.identifiers.generate(createdAt.getTime())}`;
      try {
        const record = await this.repository.withTransaction(async (transaction) => {
          const created = await this.repository.create(transaction, {
            createdAt,
            encryptedSecret: secret.encrypted,
            id: endpointId,
            merchantId: command.merchantId,
            normalizedUrl,
            publicId,
            subscriptions: command.subscriptions,
          });
          await this.audit.appendWebhookLifecycle(transaction, {
            action: 'webhook_endpoint.created',
            actorApiKeyId: command.actorApiKeyId,
            details: {
              status: 'active',
              subscriptions: ['payment.created.v1'],
              version: 0,
            },
            merchantId: command.merchantId,
            occurredAt: createdAt,
            requestId: command.requestId,
            targetId: publicId,
          });
          return created;
        });
        return { ...toRepresentation(record), secret: secret.plaintext };
      } catch (error: unknown) {
        if (
          error instanceof WebhookEndpointIdentifierCollisionError &&
          attempt < MAX_IDENTIFIER_ATTEMPTS
        ) {
          continue;
        }
        if (error instanceof WebhookEndpointIdentifierCollisionError) {
          throw new WebhookEndpointIdentifierGenerationExhaustedError();
        }
        throw error;
      }
    }
    throw new WebhookEndpointIdentifierGenerationExhaustedError();
  }

  public async get(merchantId: string, publicId: string): Promise<WebhookEndpointRepresentation> {
    assertWebhookEndpointId(publicId);
    const record = await this.repository.findByPublicId(merchantId, publicId);
    if (record === undefined) {
      throw new WebhookEndpointNotFoundError();
    }
    return toRepresentation(record);
  }

  public async list(
    merchantId: string,
    afterPublicId: string | undefined,
    limit: number,
  ): Promise<{
    readonly data: readonly WebhookEndpointRepresentation[];
    readonly nextPublicId: string | undefined;
  }> {
    if (afterPublicId !== undefined) {
      assertWebhookEndpointId(afterPublicId);
    }
    const page = await this.repository.list(merchantId, afterPublicId, limit);
    return { data: page.records.map(toRepresentation), nextPublicId: page.nextPublicId };
  }

  public async patch(command: PatchWebhookEndpointCommand): Promise<WebhookEndpointRepresentation> {
    assertWebhookEndpointId(command.publicId);
    return this.repository.withTransaction(async (transaction) => {
      const current = await this.repository.lockByPublicId(
        transaction,
        command.merchantId,
        command.publicId,
      );
      if (current === undefined) {
        throw new WebhookEndpointNotFoundError();
      }
      if (current.version !== command.expectedVersion) {
        throw new WebhookEndpointPreconditionFailedError();
      }
      const desiredStatus = command.status ?? current.status;
      const desiredSubscriptions = command.subscriptions ?? current.subscriptions;
      const statusChanged = desiredStatus !== current.status;
      const subscriptionsChanged = !sameSubscriptions(desiredSubscriptions, current.subscriptions);
      if (!statusChanged && !subscriptionsChanged) {
        return toRepresentation(current);
      }

      const occurredAt = this.clock();
      const version = current.version + 1;
      const updated = await this.repository.update(transaction, current.id, {
        ...(statusChanged ? { status: desiredStatus } : {}),
        ...(subscriptionsChanged ? { subscriptions: desiredSubscriptions } : {}),
        updatedAt: occurredAt,
        version,
      });
      if (statusChanged) {
        await this.audit.appendWebhookLifecycle(transaction, {
          action: 'webhook_endpoint.status_changed',
          actorApiKeyId: command.actorApiKeyId,
          details: { from: current.status, to: desiredStatus, version },
          merchantId: command.merchantId,
          occurredAt,
          requestId: command.requestId,
          targetId: command.publicId,
        });
      }
      if (subscriptionsChanged) {
        await this.audit.appendWebhookLifecycle(transaction, {
          action: 'webhook_endpoint.subscriptions_changed',
          actorApiKeyId: command.actorApiKeyId,
          details: {
            from: current.subscriptions as readonly ['payment.created.v1'],
            to: desiredSubscriptions as readonly ['payment.created.v1'],
            version,
          },
          merchantId: command.merchantId,
          occurredAt,
          requestId: command.requestId,
          targetId: command.publicId,
        });
      }
      return toRepresentation(updated);
    });
  }

  public async rotate(
    command: RotateWebhookSecretCommand,
  ): Promise<RotatedWebhookSecretRepresentation> {
    assertWebhookEndpointId(command.publicId);
    const context = await this.repository.findRotationContext(command.merchantId, command.publicId);
    if (context === undefined) {
      throw new WebhookEndpointNotFoundError();
    }
    if (context.version !== command.expectedVersion) {
      throw new WebhookEndpointPreconditionFailedError();
    }
    const candidate = this.secrets.create({
      endpointId: context.endpointId,
      merchantId: command.merchantId,
      secretVersion: context.secretVersion,
    });
    const rotatedAt = this.clock();
    const overlapExpiresAt = new Date(rotatedAt.getTime() + ROTATION_OVERLAP_MS);
    const updated = await this.repository.withTransaction(async (transaction) => {
      const current = await this.repository.lockByPublicId(
        transaction,
        command.merchantId,
        command.publicId,
      );
      if (current === undefined) {
        throw new WebhookEndpointNotFoundError();
      }
      if (current.version !== command.expectedVersion) {
        throw new WebhookEndpointPreconditionFailedError();
      }
      const version = current.version + 1;
      const record = await this.repository.rotateSecret(transaction, current.id, {
        encryptedSecret: candidate.encrypted,
        overlapExpiresAt,
        rotatedAt,
        version,
      });
      await this.audit.appendWebhookLifecycle(transaction, {
        action: 'webhook_endpoint.secret_rotated',
        actorApiKeyId: command.actorApiKeyId,
        details: { changedFields: ['secret'], version },
        merchantId: command.merchantId,
        occurredAt: rotatedAt,
        requestId: command.requestId,
        targetId: command.publicId,
      });
      return record;
    });
    return {
      id: updated.publicId,
      previousSecretExpiresAt: overlapExpiresAt.toISOString(),
      secret: candidate.plaintext,
      updatedAt: updated.updatedAt.toISOString(),
      version: updated.version,
    };
  }
}

export const webhookEndpointServiceInternals = {
  MAX_IDENTIFIER_ATTEMPTS,
  ROTATION_OVERLAP_MS,
  sameSubscriptions,
  toRepresentation,
};
