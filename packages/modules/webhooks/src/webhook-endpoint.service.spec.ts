import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';
import { AuditService } from '@settleflow/operations';

import {
  WebhookEndpointIdentifierCollisionError,
  WebhookEndpointIdentifierGenerationExhaustedError,
  WebhookEndpointNotFoundError,
  WebhookEndpointPreconditionFailedError,
} from './webhook.errors';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { LocalWebhookKeyring, WebhookSecretCipher } from './webhook-secret-crypto';
import type {
  WebhookEndpointRecord,
  WebhookEndpointRepository,
  WebhookUrlPolicy,
} from './webhook.types';

interface EndpointServiceHarness {
  readonly audit: jest.Mocked<AuditService>;
  readonly identifiers: jest.Mocked<MonotonicUlidGenerator>;
  readonly mocks: {
    readonly appendWebhookLifecycle: jest.Mock;
    readonly generate: jest.Mock;
    readonly update: jest.Mock;
  };
  readonly repository: jest.Mocked<WebhookEndpointRepository>;
  readonly service: WebhookEndpointService;
}

describe('WebhookEndpointService', () => {
  const now = new Date('2026-08-03T10:00:00.000Z');
  const publicId = 'whe_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const transaction = {} as PrismaTransactionClient;
  const record: WebhookEndpointRecord = {
    createdAt: now,
    id: 'endpoint-internal',
    merchantId: 'merchant',
    normalizedUrl: 'https://example.com/hook',
    publicId,
    status: 'active',
    subscriptions: ['payment.created.v1'],
    updatedAt: now,
    version: 0,
  };

  function harness(): EndpointServiceHarness {
    const update = jest.fn().mockResolvedValue({ ...record, status: 'inactive', version: 1 });
    const repository = {
      create: jest.fn().mockResolvedValue(record),
      findByPublicId: jest.fn().mockResolvedValue(record),
      findRotationContext: jest
        .fn()
        .mockResolvedValue({ endpointId: record.id, secretVersion: 2, version: 0 }),
      list: jest.fn().mockResolvedValue({ nextPublicId: undefined, records: [record] }),
      lockByPublicId: jest.fn().mockResolvedValue(record),
      rotateSecret: jest.fn().mockResolvedValue({ ...record, updatedAt: now, version: 1 }),
      update,
      withTransaction: jest
        .fn()
        .mockImplementation(
          (operation: (value: PrismaTransactionClient) => Promise<unknown>): Promise<unknown> =>
            operation(transaction),
        ),
    } as unknown as jest.Mocked<WebhookEndpointRepository>;
    const appendWebhookLifecycle = jest.fn().mockResolvedValue(undefined);
    const audit = { appendWebhookLifecycle } as unknown as jest.Mocked<AuditService>;
    const policy = {
      normalizeAndValidate: jest.fn().mockResolvedValue(record.normalizedUrl),
    } as unknown as jest.Mocked<WebhookUrlPolicy>;
    const keyring = new LocalWebhookKeyring({
      activeKeyId: 'local-v1',
      keysJson: JSON.stringify({ 'local-v1': Buffer.alloc(32, 4).toString('base64url') }),
      nodeEnvironment: 'test',
      provider: 'local',
    });
    const cipher = new WebhookSecretCipher(keyring, (size: number): Buffer =>
      Buffer.alloc(size, 9),
    );
    const generate = jest.fn().mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const identifiers = { generate } as unknown as jest.Mocked<MonotonicUlidGenerator>;
    return {
      audit,
      identifiers,
      mocks: { appendWebhookLifecycle, generate, update },
      repository,
      service: new WebhookEndpointService(
        repository,
        audit,
        policy,
        cipher,
        identifiers,
        () => now,
        () => record.id,
      ),
    };
  }

  const actor = { actorApiKeyId: 'key', merchantId: 'merchant', requestId: 'request' };

  it('creates atomically, returns the secret once, and bounds ID collisions', async () => {
    const h = harness();
    const created = await h.service.create({
      ...actor,
      subscriptions: ['payment.created.v1'],
      url: 'https://example.com/hook',
    });
    expect(created.id).toBe(publicId);
    expect(created.secret).toMatch(/^whsec_/);
    expect(h.mocks.appendWebhookLifecycle).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'webhook_endpoint.created' }),
    );
    h.repository.create.mockRejectedValue(new WebhookEndpointIdentifierCollisionError());
    await expect(
      h.service.create({ ...actor, subscriptions: [], url: 'https://example.com/hook' }),
    ).rejects.toBeInstanceOf(WebhookEndpointIdentifierGenerationExhaustedError);
    expect(h.mocks.generate).toHaveBeenCalledTimes(4);
  });

  it('gets and lists only repository-scoped endpoint records', async () => {
    const h = harness();
    await expect(h.service.get('merchant', publicId)).resolves.toMatchObject({ id: publicId });
    await expect(h.service.list('merchant', publicId, 20)).resolves.toMatchObject({
      data: [{ id: publicId }],
    });
    h.repository.findByPublicId.mockResolvedValue(undefined);
    await expect(h.service.get('merchant', publicId)).rejects.toBeInstanceOf(
      WebhookEndpointNotFoundError,
    );
  });

  it('enforces optimistic concurrency, no-op semantics, and correlated audits', async () => {
    const h = harness();
    await expect(
      h.service.patch({ ...actor, expectedVersion: 0, publicId }),
    ).resolves.toMatchObject({ version: 0 });
    expect(h.mocks.update).not.toHaveBeenCalled();
    h.repository.update.mockResolvedValue({
      ...record,
      status: 'inactive',
      subscriptions: [],
      version: 1,
    });
    await expect(
      h.service.patch({
        ...actor,
        expectedVersion: 0,
        publicId,
        status: 'inactive',
        subscriptions: [],
      }),
    ).resolves.toMatchObject({ version: 1 });
    expect(h.mocks.appendWebhookLifecycle).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'webhook_endpoint.status_changed' }),
    );
    expect(h.mocks.appendWebhookLifecycle).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: 'webhook_endpoint.subscriptions_changed' }),
    );
    h.repository.lockByPublicId.mockResolvedValue(undefined);
    await expect(
      h.service.patch({ ...actor, expectedVersion: 0, publicId, status: 'inactive' }),
    ).rejects.toBeInstanceOf(WebhookEndpointNotFoundError);
    h.repository.lockByPublicId.mockResolvedValue({ ...record, version: 2 });
    await expect(
      h.service.patch({ ...actor, expectedVersion: 0, publicId, status: 'inactive' }),
    ).rejects.toBeInstanceOf(WebhookEndpointPreconditionFailedError);
  });

  it('rotates while inactive with a 24-hour overlap and rechecks the ETag under lock', async () => {
    const h = harness();
    h.repository.lockByPublicId.mockResolvedValue({ ...record, status: 'inactive' });
    const rotated = await h.service.rotate({ ...actor, expectedVersion: 0, publicId });
    expect(rotated).toMatchObject({
      previousSecretExpiresAt: '2026-08-04T10:00:00.000Z',
      version: 1,
    });
    expect(rotated.secret).toMatch(/^whsec_/);
    h.repository.findRotationContext.mockResolvedValue(undefined);
    await expect(
      h.service.rotate({ ...actor, expectedVersion: 0, publicId }),
    ).rejects.toBeInstanceOf(WebhookEndpointNotFoundError);
    h.repository.findRotationContext.mockResolvedValue({
      endpointId: record.id,
      publicId,
      secretVersion: 2,
      version: 1,
    });
    await expect(
      h.service.rotate({ ...actor, expectedVersion: 0, publicId }),
    ).rejects.toBeInstanceOf(WebhookEndpointPreconditionFailedError);
  });
});
