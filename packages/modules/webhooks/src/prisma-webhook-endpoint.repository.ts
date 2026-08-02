import {
  findDatabaseConstraint,
  PrismaDatabase,
  type PrismaTransactionClient,
} from '@settleflow/infrastructure';

import {
  WebhookEndpointIdentifierCollisionError,
  WebhookEndpointUrlConflictError,
} from './webhook.errors';
import type {
  CreateWebhookEndpointPersistence,
  WebhookEndpointMutation,
  WebhookEndpointPage,
  WebhookEndpointRecord,
  WebhookEndpointRepository,
  WebhookEndpointStatus,
  WebhookRotationContext,
  WebhookSecretRotationPersistence,
  WebhookSubscription,
} from './webhook.types';

interface PersistedEndpoint {
  readonly createdAt: Date;
  readonly id: string;
  readonly merchantId: string;
  readonly normalizedUrl: string;
  readonly publicId: string;
  readonly status: string;
  readonly subscriptions: readonly { readonly eventType: string }[];
  readonly updatedAt: Date;
  readonly version: number;
}

interface LockedEndpoint {
  readonly createdAt: Date;
  readonly id: string;
  readonly merchantId: string;
  readonly normalizedUrl: string;
  readonly publicId: string;
  readonly status: string;
  readonly updatedAt: Date;
  readonly version: number;
}

const endpointSelection = {
  createdAt: true,
  id: true,
  merchantId: true,
  normalizedUrl: true,
  publicId: true,
  status: true,
  subscriptions: { orderBy: { eventType: 'asc' as const }, select: { eventType: true } },
  updatedAt: true,
  version: true,
} as const;

function toStatus(value: string): WebhookEndpointStatus {
  if (value === 'ACTIVE' || value === 'active') {
    return 'active';
  }
  if (value === 'INACTIVE' || value === 'inactive') {
    return 'inactive';
  }
  throw new Error('Persisted webhook endpoint status is invalid');
}

function toSubscriptions(
  values: readonly { readonly eventType: string }[],
): readonly WebhookSubscription[] {
  if (values.length !== 1 || values[0]?.eventType !== 'payment.created.v1') {
    throw new Error('Persisted webhook subscriptions are outside the supported contract');
  }
  return ['payment.created.v1'];
}

function toRecord(value: PersistedEndpoint): WebhookEndpointRecord {
  return {
    createdAt: value.createdAt,
    id: value.id,
    merchantId: value.merchantId,
    normalizedUrl: value.normalizedUrl,
    publicId: value.publicId,
    status: toStatus(value.status),
    subscriptions: toSubscriptions(value.subscriptions),
    updatedAt: value.updatedAt,
    version: value.version,
  };
}

export interface PrismaWebhookEndpointRepositoryOptions {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export class PrismaWebhookEndpointRepository implements WebhookEndpointRepository {
  public constructor(
    private readonly database: PrismaDatabase,
    private readonly options: PrismaWebhookEndpointRepositoryOptions,
  ) {}

  public async withTransaction<T>(
    operation: (transaction: PrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.getClient().$transaction(
        async (transaction) => {
          await transaction.$queryRaw`SELECT set_config('lock_timeout', ${`${this.options.lockTimeoutMs}ms`}, true)`;
          await transaction.$queryRaw`SELECT set_config('statement_timeout', ${`${this.options.statementTimeoutMs}ms`}, true)`;
          return operation(transaction);
        },
        {
          maxWait: this.options.lockTimeoutMs,
          timeout: this.options.statementTimeoutMs + 1_000,
        },
      );
    } catch (error: unknown) {
      const constraint = findDatabaseConstraint(error);
      if (
        constraint === 'webhook_endpoints_public_id_key' ||
        constraint === 'public_id' ||
        constraint === 'publicId'
      ) {
        throw new WebhookEndpointIdentifierCollisionError();
      }
      if (
        constraint === 'webhook_endpoints_merchant_id_normalized_url_key' ||
        constraint === 'merchant_id,normalized_url' ||
        constraint === 'merchantId,normalizedUrl'
      ) {
        throw new WebhookEndpointUrlConflictError();
      }
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async create(
    transaction: PrismaTransactionClient,
    input: CreateWebhookEndpointPersistence,
  ): Promise<WebhookEndpointRecord> {
    await transaction.webhookEndpoint.create({
      data: {
        createdAt: input.createdAt,
        id: input.id,
        merchantId: input.merchantId,
        normalizedUrl: input.normalizedUrl,
        publicId: input.publicId,
        updatedAt: input.createdAt,
      },
      select: { id: true },
    });
    await transaction.webhookEndpointSubscription.createMany({
      data: input.subscriptions.map((eventType) => ({
        createdAt: input.createdAt,
        endpointId: input.id,
        eventType,
      })),
    });
    await transaction.webhookEndpointSecret.create({
      data: {
        algorithm: input.encryptedSecret.algorithm,
        authenticationTag: input.encryptedSecret.authenticationTag,
        ciphertext: input.encryptedSecret.ciphertext,
        createdAt: input.createdAt,
        encryptionKeyId: input.encryptedSecret.encryptionKeyId,
        endpointId: input.id,
        lifecycle: 'CURRENT',
        nonce: input.encryptedSecret.nonce,
        secretVersion: input.encryptedSecret.secretVersion,
      },
      select: { id: true },
    });
    return this.load(transaction, input.id);
  }

  public async findByPublicId(
    merchantId: string,
    publicId: string,
  ): Promise<WebhookEndpointRecord | undefined> {
    try {
      const record = await this.database.getClient().webhookEndpoint.findFirst({
        select: endpointSelection,
        where: { merchantId, publicId },
      });
      return record === null ? undefined : toRecord(record);
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async list(
    merchantId: string,
    afterPublicId: string | undefined,
    limit: number,
  ): Promise<WebhookEndpointPage> {
    try {
      const records = await this.database.getClient().webhookEndpoint.findMany({
        orderBy: { publicId: 'desc' },
        select: endpointSelection,
        take: limit + 1,
        where: {
          merchantId,
          ...(afterPublicId === undefined ? {} : { publicId: { lt: afterPublicId } }),
        },
      });
      const hasNext = records.length > limit;
      const page = records.slice(0, limit).map(toRecord);
      return {
        nextPublicId: hasNext ? page.at(-1)?.publicId : undefined,
        records: page,
      };
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async findRotationContext(
    merchantId: string,
    publicId: string,
  ): Promise<WebhookRotationContext | undefined> {
    try {
      const endpoint = await this.database.getClient().webhookEndpoint.findFirst({
        select: {
          id: true,
          publicId: true,
          secrets: { orderBy: { secretVersion: 'desc' }, select: { secretVersion: true }, take: 1 },
          version: true,
        },
        where: { merchantId, publicId },
      });
      if (endpoint === null) {
        return undefined;
      }
      const latest = endpoint.secrets[0]?.secretVersion;
      if (latest === undefined) {
        throw new Error('Webhook endpoint has no signing secret');
      }
      return {
        endpointId: endpoint.id,
        publicId: endpoint.publicId,
        secretVersion: latest + 1,
        version: endpoint.version,
      };
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async lockByPublicId(
    transaction: PrismaTransactionClient,
    merchantId: string,
    publicId: string,
  ): Promise<WebhookEndpointRecord | undefined> {
    const rows = await transaction.$queryRaw<LockedEndpoint[]>`
      SELECT
        "id",
        "public_id" AS "publicId",
        "merchant_id" AS "merchantId",
        "normalized_url" AS "normalizedUrl",
        "status"::text AS "status",
        "version",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "webhook_endpoints"
      WHERE "merchant_id" = ${merchantId}::uuid
        AND "public_id" = ${publicId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    const subscriptions = await transaction.webhookEndpointSubscription.findMany({
      orderBy: { eventType: 'asc' },
      select: { eventType: true },
      where: { endpointId: row.id },
    });
    return toRecord({ ...row, subscriptions });
  }

  public async update(
    transaction: PrismaTransactionClient,
    endpointId: string,
    input: WebhookEndpointMutation,
  ): Promise<WebhookEndpointRecord> {
    if (input.subscriptions !== undefined) {
      await transaction.webhookEndpointSubscription.deleteMany({ where: { endpointId } });
      await transaction.webhookEndpointSubscription.createMany({
        data: input.subscriptions.map((eventType) => ({
          createdAt: input.updatedAt,
          endpointId,
          eventType,
        })),
      });
    }
    await transaction.webhookEndpoint.update({
      data: {
        ...(input.status === undefined
          ? {}
          : { status: input.status === 'active' ? 'ACTIVE' : 'INACTIVE' }),
        updatedAt: input.updatedAt,
        version: input.version,
      },
      select: { id: true },
      where: { id: endpointId },
    });
    return this.load(transaction, endpointId);
  }

  public async rotateSecret(
    transaction: PrismaTransactionClient,
    endpointId: string,
    input: WebhookSecretRotationPersistence,
  ): Promise<WebhookEndpointRecord> {
    await transaction.webhookEndpointSecret.updateMany({
      data: { lifecycle: 'RETIRED', retiredAt: input.rotatedAt },
      where: { endpointId, lifecycle: 'PREVIOUS' },
    });
    const promoted = await transaction.webhookEndpointSecret.updateMany({
      data: {
        lifecycle: 'PREVIOUS',
        overlapExpiresAt: input.overlapExpiresAt,
      },
      where: { endpointId, lifecycle: 'CURRENT' },
    });
    if (promoted.count !== 1) {
      throw new Error('Webhook endpoint does not have exactly one current secret');
    }
    await transaction.webhookEndpointSecret.create({
      data: {
        algorithm: input.encryptedSecret.algorithm,
        authenticationTag: input.encryptedSecret.authenticationTag,
        ciphertext: input.encryptedSecret.ciphertext,
        createdAt: input.rotatedAt,
        encryptionKeyId: input.encryptedSecret.encryptionKeyId,
        endpointId,
        lifecycle: 'CURRENT',
        nonce: input.encryptedSecret.nonce,
        secretVersion: input.encryptedSecret.secretVersion,
      },
      select: { id: true },
    });
    await transaction.webhookEndpoint.update({
      data: { updatedAt: input.rotatedAt, version: input.version },
      select: { id: true },
      where: { id: endpointId },
    });
    return this.load(transaction, endpointId);
  }

  private async load(
    transaction: PrismaTransactionClient,
    endpointId: string,
  ): Promise<WebhookEndpointRecord> {
    const record = await transaction.webhookEndpoint.findUniqueOrThrow({
      select: endpointSelection,
      where: { id: endpointId },
    });
    return toRecord(record);
  }
}

export const prismaWebhookEndpointRepositoryInternals = {
  endpointSelection,
  toRecord,
  toStatus,
  toSubscriptions,
};
