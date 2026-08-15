import type { MerchantApiKeyScope } from './api-key-scopes';

export interface ApiKeyMetadata {
  readonly createdAt: Date;
  readonly id: string;
  readonly merchantId: string;
  readonly prefix: string;
  readonly scopes: readonly MerchantApiKeyScope[];
  readonly status: 'active';
}

export interface IssuedApiKey extends ApiKeyMetadata {
  readonly plaintext: string;
}

export interface MerchantRequestIdentity {
  readonly apiKeyId: string;
  readonly merchantId: string;
  readonly scopes: readonly MerchantApiKeyScope[];
}

export interface IssueApiKeyCommand {
  readonly merchantId: string;
  readonly scopes: readonly MerchantApiKeyScope[];
}

export interface RotateApiKeyCommand {
  readonly apiKeyId: string;
  readonly scopes?: readonly MerchantApiKeyScope[];
}

export interface SyntheticMerchant {
  readonly code: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly status: 'active';
}
