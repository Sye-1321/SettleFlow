import type { IdempotencyRepository } from './idempotency.repository';
import { IdempotencyService, idempotencyServiceInternals } from './idempotency.service';

describe('IdempotencyService', () => {
  it('passes only SHA-256 digests and generated ownership IDs to persistence', async () => {
    const repository: jest.Mocked<IdempotencyRepository> = {
      acquire: jest.fn().mockResolvedValue({
        kind: 'acquired',
        ownership: { ownerToken: 'owner', recordId: 'record' },
      }),
      complete: jest.fn(),
    };
    const service = new IdempotencyService(repository);
    const now = new Date('2026-08-01T00:00:00.000Z');

    await service.acquire({
      canonicalRequest: '{"v":1}',
      key: 'private-command-key',
      merchantId: 'merchant-id',
      method: 'POST',
      normalizedRoute: '/v1/payment-intents',
      now,
    });

    const persisted = repository.acquire.mock.calls[0]?.[0];
    expect(persisted).toMatchObject({ merchantId: 'merchant-id', now });
    expect(Buffer.from(persisted?.keyHash ?? []).toString('hex')).toBe(
      Buffer.from(idempotencyServiceInternals.sha256('private-command-key')).toString('hex'),
    );
    expect(Buffer.from(persisted?.requestHash ?? []).toString('hex')).toBe(
      Buffer.from(idempotencyServiceInternals.sha256('{"v":1}')).toString('hex'),
    );
    expect(JSON.stringify(persisted)).not.toContain('private-command-key');
  });
});
