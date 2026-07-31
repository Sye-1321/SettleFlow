import type { ApiKeyCredentialService } from './api-key-credential.service';
import { MerchantAccessValidationError } from './api-key-scopes';
import type {
  ApiKeyAuthenticationRecord,
  CreateApiKeyRecord,
  MerchantAccessRepository,
} from './merchant-access.repository';
import { MerchantAccessService } from './merchant-access.service';
import type { ApiKeyMetadata } from './merchant-access.types';

describe('MerchantAccessService', () => {
  const metadata: ApiKeyMetadata = {
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    id: 'key-id',
    merchantId: 'merchant-id',
    prefix: 'sf_test_abcdefghijkl',
    scopes: ['payments:read'],
    status: 'active',
  };

  function createHarness(record?: ApiKeyAuthenticationRecord): {
    readonly credentials: jest.Mocked<ApiKeyCredentialService>;
    readonly repository: jest.Mocked<MerchantAccessRepository>;
    readonly service: MerchantAccessService;
  } {
    const repository: jest.Mocked<MerchantAccessRepository> = {
      createApiKey: jest.fn().mockResolvedValue(metadata),
      disableApiKey: jest.fn().mockResolvedValue(true),
      findActiveApiKeyByPrefix: jest.fn().mockResolvedValue(record),
      revokeApiKey: jest.fn().mockResolvedValue(true),
      rotateApiKey: jest.fn().mockResolvedValue(metadata),
    };
    const credentials = {
      extractPrefix: jest.fn().mockReturnValue('sf_test_abcdefghijkl'),
      generate: jest.fn().mockResolvedValue({
        plaintext: 'sf_test_abcdefghijkl.secret',
        prefix: 'sf_test_abcdefghijkl',
        secretHash: 'stored-hash',
      }),
      verify: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ApiKeyCredentialService>;

    return {
      credentials,
      repository,
      service: new MerchantAccessService(repository, credentials),
    };
  }

  it('returns only merchant request identity for a verified active record', async () => {
    const record: ApiKeyAuthenticationRecord = {
      id: 'key-id',
      merchantId: 'merchant-id',
      prefix: 'sf_test_abcdefghijkl',
      scopes: ['payments:read'],
      secretHash: 'stored-hash',
    };
    const { service } = createHarness(record);

    await expect(service.authenticate('credential')).resolves.toEqual({
      apiKeyId: 'key-id',
      merchantId: 'merchant-id',
      scopes: ['payments:read'],
    });
  });

  it('fails closed before verification for malformed or unknown credentials', async () => {
    const malformed = createHarness();
    malformed.credentials.extractPrefix.mockReturnValue(undefined);
    await expect(malformed.service.authenticate('bad')).resolves.toBeUndefined();
    expect(malformed.repository.findActiveApiKeyByPrefix.mock.calls).toHaveLength(0);

    const unknown = createHarness();
    await expect(unknown.service.authenticate('unknown')).resolves.toBeUndefined();
    expect(unknown.credentials.verify.mock.calls).toHaveLength(0);
  });

  it('normalizes allowlisted scopes and never passes plaintext to persistence', async () => {
    const { repository, service } = createHarness();
    const issued = await service.issueApiKey({
      merchantId: 'merchant-id',
      scopes: ['payments:read', 'payments:read', 'ledger:read'],
    });

    expect(issued.plaintext).toBe('sf_test_abcdefghijkl.secret');
    expect(repository.createApiKey.mock.calls).toEqual([
      [
        {
          merchantId: 'merchant-id',
          prefix: 'sf_test_abcdefghijkl',
          scopes: ['ledger:read', 'payments:read'],
          secretHash: 'stored-hash',
        } satisfies CreateApiKeyRecord,
      ],
    ]);
    expect(JSON.stringify(repository.createApiKey.mock.calls)).not.toContain(issued.plaintext);
  });

  it('rejects empty scopes and rotates through one repository command', async () => {
    const { repository, service } = createHarness();
    await expect(
      service.issueApiKey({ merchantId: 'merchant-id', scopes: [] }),
    ).rejects.toBeInstanceOf(MerchantAccessValidationError);

    const rotated = await service.rotateApiKey({ apiKeyId: 'key-id' });
    expect(rotated.plaintext).toBe('sf_test_abcdefghijkl.secret');
    const rotateCommand = repository.rotateApiKey.mock.calls[0]?.[0];
    expect(rotateCommand).toEqual(
      expect.objectContaining({
        apiKeyId: 'key-id',
        prefix: 'sf_test_abcdefghijkl',
        secretHash: 'stored-hash',
      }),
    );
  });

  it('requires every explicit scope', () => {
    const { service } = createHarness();
    const identity = {
      apiKeyId: 'key-id',
      merchantId: 'merchant-id',
      scopes: ['payments:read'] as const,
    };

    expect(service.hasScopes(identity, ['payments:read'])).toBe(true);
    expect(service.hasScopes(identity, ['payments:write'])).toBe(false);
  });
});
