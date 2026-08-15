import { PrismaDatabase } from '@settleflow/infrastructure';

import { isMerchantApiKeyScope, type MerchantApiKeyScope } from './api-key-scopes';
import {
  ApiKeyUnavailableError,
  MerchantUnavailableError,
  type ApiKeyAuthenticationRecord,
  type CreateApiKeyRecord,
  type MerchantAccessRepository,
  type RotateApiKeyRecord,
} from './merchant-access.repository';
import type { ApiKeyMetadata, SyntheticMerchant } from './merchant-access.types';

function toScopes(scopes: readonly string[]): readonly MerchantApiKeyScope[] {
  if (scopes.some((scope) => !isMerchantApiKeyScope(scope))) {
    throw new Error('Persisted API key contains an unsupported scope');
  }

  return scopes as readonly MerchantApiKeyScope[];
}

function toMetadata(record: {
  readonly createdAt: Date;
  readonly id: string;
  readonly merchantId: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
}): ApiKeyMetadata {
  return {
    createdAt: record.createdAt,
    id: record.id,
    merchantId: record.merchantId,
    prefix: record.prefix,
    scopes: toScopes(record.scopes),
    status: 'active',
  };
}

export class PrismaMerchantAccessRepository implements MerchantAccessRepository {
  public constructor(private readonly database: PrismaDatabase) {}

  public async provisionSyntheticMerchant(code: string): Promise<SyntheticMerchant> {
    try {
      await this.database.getClient().merchant.createMany({
        data: [{ code }],
        skipDuplicates: true,
      });
      const merchant = await this.database.getClient().merchant.findUnique({
        select: { code: true, createdAt: true, id: true, status: true },
        where: { code },
      });
      if (merchant?.status !== 'ACTIVE') {
        throw new MerchantUnavailableError();
      }
      return {
        code: merchant.code,
        createdAt: merchant.createdAt,
        id: merchant.id,
        status: 'active',
      };
    } catch (error: unknown) {
      if (error instanceof MerchantUnavailableError) throw error;
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async createApiKey(input: CreateApiKeyRecord): Promise<ApiKeyMetadata> {
    const client = this.database.getClient();

    return client.$transaction(async (transaction) => {
      const merchant = await transaction.merchant.findFirst({
        where: { id: input.merchantId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (merchant === null) {
        throw new MerchantUnavailableError();
      }

      const record = await transaction.apiKey.create({
        data: {
          merchantId: input.merchantId,
          prefix: input.prefix,
          scopes: [...input.scopes],
          secretHash: input.secretHash,
        },
        select: {
          createdAt: true,
          id: true,
          merchantId: true,
          prefix: true,
          scopes: true,
        },
      });

      return toMetadata(record);
    });
  }

  public async disableApiKey(apiKeyId: string): Promise<boolean> {
    const result = await this.database.getClient().apiKey.updateMany({
      data: { status: 'DISABLED' },
      where: { id: apiKeyId, revokedAt: null, status: 'ACTIVE' },
    });

    return result.count === 1;
  }

  public async findActiveApiKeyByPrefix(
    prefix: string,
  ): Promise<ApiKeyAuthenticationRecord | undefined> {
    let record;
    try {
      record = await this.database.getClient().apiKey.findFirst({
        where: {
          merchant: { is: { status: 'ACTIVE' } },
          prefix,
          revokedAt: null,
          status: 'ACTIVE',
        },
        select: {
          id: true,
          merchantId: true,
          prefix: true,
          scopes: true,
          secretHash: true,
        },
      });
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }

    if (record === null) {
      return undefined;
    }

    return { ...record, scopes: toScopes(record.scopes) };
  }

  public async revokeApiKey(apiKeyId: string, revokedAt: Date): Promise<boolean> {
    const result = await this.database.getClient().apiKey.updateMany({
      data: { revokedAt, status: 'REVOKED' },
      where: {
        id: apiKeyId,
        revokedAt: null,
        status: { in: ['ACTIVE', 'DISABLED'] },
      },
    });

    return result.count === 1;
  }

  public async rotateApiKey(input: RotateApiKeyRecord): Promise<ApiKeyMetadata> {
    const client = this.database.getClient();

    return client.$transaction(async (transaction) => {
      const existing = await transaction.apiKey.findFirst({
        where: {
          id: input.apiKeyId,
          merchant: { is: { status: 'ACTIVE' } },
          revokedAt: null,
          status: { in: ['ACTIVE', 'DISABLED'] },
        },
        select: { merchantId: true, scopes: true },
      });
      if (existing === null) {
        throw new ApiKeyUnavailableError();
      }

      const retired = await transaction.apiKey.updateMany({
        data: {
          revokedAt: input.rotatedAt,
          rotatedAt: input.rotatedAt,
          status: 'REVOKED',
        },
        where: {
          id: input.apiKeyId,
          revokedAt: null,
          status: { in: ['ACTIVE', 'DISABLED'] },
        },
      });
      if (retired.count !== 1) {
        throw new ApiKeyUnavailableError();
      }

      const record = await transaction.apiKey.create({
        data: {
          merchantId: existing.merchantId,
          prefix: input.prefix,
          scopes: [...(input.scopes ?? toScopes(existing.scopes))],
          secretHash: input.secretHash,
        },
        select: {
          createdAt: true,
          id: true,
          merchantId: true,
          prefix: true,
          scopes: true,
        },
      });

      return toMetadata(record);
    });
  }
}
