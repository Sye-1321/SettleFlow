import { ApiKeyCredentialService } from './api-key-credential.service';
import { normalizeMerchantApiKeyScopes, type MerchantApiKeyScope } from './api-key-scopes';
import type { MerchantAccessRepository } from './merchant-access.repository';
import type {
  IssueApiKeyCommand,
  IssuedApiKey,
  MerchantRequestIdentity,
  RotateApiKeyCommand,
  SyntheticMerchant,
} from './merchant-access.types';

const SYNTHETIC_MERCHANT_CODE_PATTERN = /^demo_[a-z0-9_]{1,58}$/u;

export class MerchantAccessService {
  public constructor(
    private readonly repository: MerchantAccessRepository,
    private readonly credentials: ApiKeyCredentialService,
  ) {}

  public async authenticate(plaintext: string): Promise<MerchantRequestIdentity | undefined> {
    const prefix = this.credentials.extractPrefix(plaintext);
    if (prefix === undefined) {
      return undefined;
    }

    const record = await this.repository.findActiveApiKeyByPrefix(prefix);
    if (record === undefined || !(await this.credentials.verify(plaintext, record.secretHash))) {
      return undefined;
    }

    return {
      apiKeyId: record.id,
      merchantId: record.merchantId,
      scopes: record.scopes,
    };
  }

  public async issueApiKey(command: IssueApiKeyCommand): Promise<IssuedApiKey> {
    const scopes = normalizeMerchantApiKeyScopes(command.scopes);
    const generated = await this.credentials.generate();
    const metadata = await this.repository.createApiKey({
      merchantId: command.merchantId,
      prefix: generated.prefix,
      scopes,
      secretHash: generated.secretHash,
    });

    return { ...metadata, plaintext: generated.plaintext };
  }

  /** Local fixture boundary only; intentionally has no HTTP controller. */
  public provisionSyntheticMerchant(code: string): Promise<SyntheticMerchant> {
    if (!SYNTHETIC_MERCHANT_CODE_PATTERN.test(code)) {
      throw new Error('Synthetic merchant code is invalid');
    }
    return this.repository.provisionSyntheticMerchant(code);
  }

  public async disableApiKey(apiKeyId: string): Promise<boolean> {
    return this.repository.disableApiKey(apiKeyId);
  }

  public async revokeApiKey(apiKeyId: string, revokedAt = new Date()): Promise<boolean> {
    return this.repository.revokeApiKey(apiKeyId, revokedAt);
  }

  public async rotateApiKey(command: RotateApiKeyCommand): Promise<IssuedApiKey> {
    const scopes =
      command.scopes === undefined ? undefined : normalizeMerchantApiKeyScopes(command.scopes);
    const generated = await this.credentials.generate();
    const metadata = await this.repository.rotateApiKey({
      apiKeyId: command.apiKeyId,
      prefix: generated.prefix,
      rotatedAt: new Date(),
      secretHash: generated.secretHash,
      ...(scopes === undefined ? {} : { scopes }),
    });

    return { ...metadata, plaintext: generated.plaintext };
  }

  public hasScopes(
    identity: MerchantRequestIdentity,
    requiredScopes: readonly MerchantApiKeyScope[],
  ): boolean {
    const granted = new Set<MerchantApiKeyScope>(identity.scopes);
    return requiredScopes.every((scope) => granted.has(scope));
  }
}

export const merchantAccessServiceInternals = { SYNTHETIC_MERCHANT_CODE_PATTERN };
