export { ApiKeyCredentialService } from './api-key-credential.service';
export type { GeneratedApiKeyCredential } from './api-key-credential.service';
export {
  MERCHANT_API_KEY_SCOPES,
  MerchantAccessValidationError,
  isMerchantApiKeyScope,
  normalizeMerchantApiKeyScopes,
} from './api-key-scopes';
export type { MerchantApiKeyScope } from './api-key-scopes';
export { ApiKeyUnavailableError, MerchantUnavailableError } from './merchant-access.repository';
export type {
  ApiKeyAuthenticationRecord,
  CreateApiKeyRecord,
  MerchantAccessRepository,
  RotateApiKeyRecord,
} from './merchant-access.repository';
export { MerchantAccessService } from './merchant-access.service';
export type {
  ApiKeyMetadata,
  IssueApiKeyCommand,
  IssuedApiKey,
  MerchantRequestIdentity,
  RotateApiKeyCommand,
} from './merchant-access.types';
export { PrismaMerchantAccessRepository } from './prisma-merchant-access.repository';
