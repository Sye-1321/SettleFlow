import { LocalWebhookKeyring, WebhookSecretCipher } from './webhook-secret-crypto';
import {
  WebhookEndpointUrlProhibitedError,
  WebhookEndpointUrlResolutionUnavailableError,
  WebhookEndpointUrlUnresolvableError,
} from './webhook.errors';
import { WebhookDeliveryService } from './webhook-delivery.service';
import type {
  ClaimedWebhookDelivery,
  WebhookDeliveryContext,
  WebhookDeliveryRepository,
} from './webhook-delivery.types';

const claim: ClaimedWebhookDelivery = {
  attemptCount: 0,
  claimToken: '00000000-0000-4000-8000-000000000020',
  deliveryId: '00000000-0000-4000-8000-000000000010',
  endpointId: '00000000-0000-4000-8000-000000000002',
  eventId: 'evt_01K00000000000000000000000',
  merchantId: '00000000-0000-4000-8000-000000000001',
  publicId: 'whd_01K00000000000000000000000',
};

function keyring(): LocalWebhookKeyring {
  return new LocalWebhookKeyring({
    activeKeyId: 'local-v1',
    keysJson: JSON.stringify({ 'local-v1': Buffer.alloc(32, 4).toString('base64url') }),
    nodeEnvironment: 'test',
    provider: 'local',
  });
}

function context(
  cipher: WebhookSecretCipher,
  status: 'active' | 'inactive' = 'active',
): WebhookDeliveryContext {
  const encrypted = cipher.create({
    endpointId: claim.endpointId,
    merchantId: claim.merchantId,
    secretVersion: 1,
  }).encrypted;
  return {
    body: Buffer.from('{"eventId":"evt_01K00000000000000000000000"}', 'utf8'),
    claim,
    currentSecret: {
      ...encrypted,
      lifecycle: 'current',
      overlapExpiresAt: undefined,
    },
    endpointStatus: status,
    eventType: 'payment.created.v1',
    normalizedUrl: 'https://example.com/hook',
    previousSecret: undefined,
    schemaVersion: 1,
  };
}

function repository(overrides: Partial<WebhookDeliveryRepository> = {}): WebhookDeliveryRepository {
  return {
    checkReadiness: jest.fn().mockResolvedValue(true),
    claimDue: jest.fn().mockResolvedValue([claim]),
    finalizeAttempt: jest.fn().mockResolvedValue({ status: 'delivered', updated: true }),
    loadContext: jest.fn(),
    recoverExpired: jest.fn().mockResolvedValue({
      clearedUnstarted: 0,
      deadLettered: 0,
      recoveredUnknown: 0,
    }),
    releaseUnstarted: jest.fn().mockResolvedValue(true),
    startAttempt: jest.fn(),
    ...overrides,
  };
}

describe('WebhookDeliveryService', () => {
  it('sends exact projected bytes and finalizes a confirmed 2xx attempt', async () => {
    const localKeyring = keyring();
    const cipher = new WebhookSecretCipher(localKeyring, (size) => Buffer.alloc(size, 9));
    const stored = context(cipher);
    const finalizeAttempt = jest.fn().mockResolvedValue({ status: 'delivered', updated: true });
    const repo = repository({
      finalizeAttempt,
      loadContext: jest.fn().mockResolvedValue(stored),
      startAttempt: jest.fn().mockResolvedValue({
        attempt: {
          attemptNumber: 1,
          currentSecretVersion: 1,
          nextAttemptAt: new Date('2026-08-02T10:01:00.000Z'),
          previousSecretVersion: undefined,
          signatureTimestamp: 1_785_665_000n,
          startedAt: new Date('2026-08-02T10:00:00.000Z'),
        },
        kind: 'started',
      }),
    });
    const deliver = jest.fn().mockResolvedValue({
      bodySha256: Buffer.alloc(32, 7),
      bodyTruncated: false,
      kind: 'response',
      statusCode: 204,
    });
    const service = new WebhookDeliveryService(
      repo,
      localKeyring,
      cipher,
      {
        resolveForDelivery: jest.fn().mockResolvedValue({
          address: '93.184.216.34',
          family: 4,
          hostname: 'example.com',
          url: stored.normalizedUrl,
        }),
      },
      { abortActive: jest.fn(), deliver },
      { random: (): number => 0 },
    );

    await expect(service.runOnce('webhook_test', 4)).resolves.toMatchObject({
      claimed: 1,
      delivered: 1,
      dispatcherReady: true,
    });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ body: stored.body }));
    expect(finalizeAttempt).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ attemptNumber: 1 }),
      expect.objectContaining({ httpStatus: 204, outcome: 'delivered' }),
    );
  });

  it('dead-letters an inactive endpoint without decrypting or making network contact', async () => {
    const localKeyring = keyring();
    const cipher = new WebhookSecretCipher(localKeyring);
    const deliver = jest.fn();
    const repo = repository({
      loadContext: jest.fn().mockResolvedValue(context(cipher, 'inactive')),
      startAttempt: jest.fn().mockResolvedValue({ attemptNumber: 1, kind: 'inactive' }),
    });
    const service = new WebhookDeliveryService(
      repo,
      localKeyring,
      cipher,
      { resolveForDelivery: jest.fn() },
      { abortActive: jest.fn(), deliver },
    );

    await expect(service.runOnce('webhook_test', 4)).resolves.toMatchObject({ deadLettered: 1 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('releases an unstarted claim and becomes unready when decryption fails', async () => {
    const localKeyring = keyring();
    const cipher = new WebhookSecretCipher(localKeyring);
    const invalid = context(cipher);
    invalid.currentSecret.ciphertext[0] = (invalid.currentSecret.ciphertext[0] ?? 0) ^ 1;
    const releaseUnstarted = jest.fn().mockResolvedValue(true);
    const startAttempt = jest.fn();
    const repo = repository({
      loadContext: jest.fn().mockResolvedValue(invalid),
      releaseUnstarted,
      startAttempt,
    });
    const service = new WebhookDeliveryService(
      repo,
      localKeyring,
      cipher,
      { resolveForDelivery: jest.fn() },
      { abortActive: jest.fn(), deliver: jest.fn() },
    );

    await expect(service.runOnce('webhook_test', 4)).resolves.toMatchObject({
      dispatcherReady: false,
    });
    expect(releaseUnstarted).toHaveBeenCalledWith(claim);
    expect(startAttempt).not.toHaveBeenCalled();
  });

  it('reports readiness failures and stops without claiming more work', async () => {
    const localKeyring = keyring();
    const cipher = new WebhookSecretCipher(localKeyring);
    const repo = repository({ checkReadiness: jest.fn().mockResolvedValue(false) });
    const httpClient = { abortActive: jest.fn(), deliver: jest.fn() };
    const service = new WebhookDeliveryService(
      repo,
      localKeyring,
      cipher,
      { resolveForDelivery: jest.fn() },
      httpClient,
    );
    await expect(service.ensureReady()).resolves.toBe(false);
    expect(service.isReady()).toBe(false);
    service.abortActive();
    expect(httpClient.abortActive).toHaveBeenCalled();
    service.beginShutdown();
    await expect(service.ensureReady()).resolves.toBe(false);
    await expect(service.runOnce('worker', 4)).resolves.toMatchObject({
      claimed: 0,
      dispatcherReady: false,
    });
  });

  it('records lease recovery and ownership loss without network contact', async () => {
    const localKeyring = keyring();
    const cipher = new WebhookSecretCipher(localKeyring);
    const signal = jest.fn();
    const repo = repository({
      loadContext: jest.fn().mockResolvedValue(undefined),
      recoverExpired: jest
        .fn()
        .mockResolvedValue({ clearedUnstarted: 1, deadLettered: 1, recoveredUnknown: 1 }),
    });
    const service = new WebhookDeliveryService(
      repo,
      localKeyring,
      cipher,
      { resolveForDelivery: jest.fn() },
      { abortActive: jest.fn(), deliver: jest.fn() },
      { signal },
    );
    await expect(service.runOnce('worker', 4)).resolves.toMatchObject({
      claimed: 1,
      deadLettered: 1,
      ownershipLost: 1,
      recoveredUnknown: 1,
    });
    expect(signal).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'webhook.delivery.ownership_lost' }),
    );
  });

  it('handles start-attempt ownership loss and secret-version drift safely', async () => {
    const localKeyring = keyring();
    const cipher = new WebhookSecretCipher(localKeyring);
    const stored = context(cipher);
    const ownership = new WebhookDeliveryService(
      repository({
        loadContext: jest.fn().mockResolvedValue(stored),
        startAttempt: jest.fn().mockResolvedValue({ kind: 'ownership_lost' }),
      }),
      localKeyring,
      cipher,
      { resolveForDelivery: jest.fn() },
      { abortActive: jest.fn(), deliver: jest.fn() },
    );
    await expect(ownership.runOnce('worker', 4)).resolves.toMatchObject({ ownershipLost: 1 });

    const drift = new WebhookDeliveryService(
      repository({
        loadContext: jest.fn().mockResolvedValue(stored),
        startAttempt: jest.fn().mockResolvedValue({
          attempt: {
            attemptNumber: 1,
            currentSecretVersion: 99,
            nextAttemptAt: new Date(),
            previousSecretVersion: undefined,
            signatureTimestamp: 1n,
            startedAt: new Date(),
          },
          kind: 'started',
        }),
      }),
      localKeyring,
      cipher,
      { resolveForDelivery: jest.fn() },
      { abortActive: jest.fn(), deliver: jest.fn() },
    );
    await expect(drift.runOnce('worker', 4)).resolves.toMatchObject({ dispatcherReady: false });
  });

  it.each([
    [
      new WebhookEndpointUrlResolutionUnavailableError(),
      'dns_unavailable',
      'retryable_failure',
      'retrying',
    ],
    [
      new WebhookEndpointUrlUnresolvableError(),
      'dns_unresolvable',
      'non_retryable_failure',
      'dead_lettered',
    ],
    [
      new WebhookEndpointUrlProhibitedError(),
      'destination_prohibited',
      'non_retryable_failure',
      'dead_lettered',
    ],
    [new Error('socket failed'), 'network_error', 'retryable_failure', 'retrying'],
  ])(
    'persists classified evidence for delivery failure %#',
    async (error, code, outcome, status) => {
      const localKeyring = keyring();
      const cipher = new WebhookSecretCipher(localKeyring);
      const stored = context(cipher);
      const finalizeAttempt = jest.fn().mockResolvedValue({ status, updated: true });
      const repo = repository({
        finalizeAttempt,
        loadContext: jest.fn().mockResolvedValue(stored),
        startAttempt: jest.fn().mockResolvedValue({
          attempt: {
            attemptNumber: 1,
            currentSecretVersion: 1,
            nextAttemptAt: new Date('2026-08-02T10:01:00.000Z'),
            previousSecretVersion: undefined,
            signatureTimestamp: 1n,
            startedAt: new Date(),
          },
          kind: 'started',
        }),
      });
      const service = new WebhookDeliveryService(
        repo,
        localKeyring,
        cipher,
        { resolveForDelivery: jest.fn().mockRejectedValue(error) },
        { abortActive: jest.fn(), deliver: jest.fn() },
        { random: (): number => 0 },
      );
      await expect(service.runOnce('worker', 4)).resolves.toMatchObject(
        status === 'retrying' ? { retrying: 1 } : { deadLettered: 1 },
      );
      expect(finalizeAttempt).toHaveBeenCalledWith(
        claim,
        expect.anything(),
        expect.objectContaining({ errorCode: code, outcome }),
      );
    },
  );

  it('treats lost finalization ownership as an ownership loss', async () => {
    const localKeyring = keyring();
    const cipher = new WebhookSecretCipher(localKeyring);
    const stored = context(cipher);
    const repo = repository({
      finalizeAttempt: jest.fn().mockResolvedValue({ status: 'delivered', updated: false }),
      loadContext: jest.fn().mockResolvedValue(stored),
      startAttempt: jest.fn().mockResolvedValue({
        attempt: {
          attemptNumber: 1,
          currentSecretVersion: 1,
          nextAttemptAt: undefined,
          previousSecretVersion: undefined,
          signatureTimestamp: 1n,
          startedAt: new Date(),
        },
        kind: 'started',
      }),
    });
    const service = new WebhookDeliveryService(
      repo,
      localKeyring,
      cipher,
      {
        resolveForDelivery: jest.fn().mockResolvedValue({
          address: '93.184.216.34',
          family: 4,
          hostname: 'example.com',
          url: stored.normalizedUrl,
        }),
      },
      {
        abortActive: jest.fn(),
        deliver: jest.fn().mockResolvedValue({
          bodySha256: Buffer.alloc(32),
          bodyTruncated: false,
          kind: 'response',
          statusCode: 200,
        }),
      },
    );
    await expect(service.runOnce('worker', 4)).resolves.toMatchObject({ ownershipLost: 1 });
  });
});
