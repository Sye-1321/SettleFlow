import type { MerchantApiKeyScope } from './api-key-scopes';
import type { ApiKeyMetadata } from './merchant-access.types';

export interface ApiKeyAuthenticationRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly prefix: string;
  readonly scopes: readonly MerchantApiKeyScope[];
  readonly secretHash: string;
}

export interface CreateApiKeyRecord {
  readonly merchantId: string;
  readonly prefix: string;
  readonly scopes: readonly MerchantApiKeyScope[];
  readonly secretHash: string;
}

export interface RotateApiKeyRecord {
  readonly apiKeyId: string;
  readonly prefix: string;
  readonly rotatedAt: Date;
  readonly scopes?: readonly MerchantApiKeyScope[];
  readonly secretHash: string;
}

export interface MerchantAccessRepository {
  createApiKey(input: CreateApiKeyRecord): Promise<ApiKeyMetadata>;
  disableApiKey(apiKeyId: string): Promise<boolean>;
  findActiveApiKeyByPrefix(prefix: string): Promise<ApiKeyAuthenticationRecord | undefined>;
  revokeApiKey(apiKeyId: string, revokedAt: Date): Promise<boolean>;
  rotateApiKey(input: RotateApiKeyRecord): Promise<ApiKeyMetadata>;
}

export class MerchantUnavailableError extends Error {
  public constructor() {
    super('Merchant is unavailable');
    this.name = 'MerchantUnavailableError';
  }
}

export class ApiKeyUnavailableError extends Error {
  public constructor() {
    super('API key is unavailable');
    this.name = 'ApiKeyUnavailableError';
  }
}
