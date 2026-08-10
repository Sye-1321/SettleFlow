import { LocalWebhookKeyring, WebhookSecretCipher } from './webhook-secret-crypto';
import { WebhookKeyringUnavailableError } from './webhook.errors';

function keyring(keyByte = 7): LocalWebhookKeyring {
  return new LocalWebhookKeyring({
    activeKeyId: 'local-v1',
    keysJson: JSON.stringify({ 'local-v1': Buffer.alloc(32, keyByte).toString('base64url') }),
    nodeEnvironment: 'test',
    provider: 'local',
  });
}

describe('WebhookSecretCipher', () => {
  it('creates the exact one-time format and authenticated envelope', () => {
    let call = 0;
    const cipher = new WebhookSecretCipher(keyring(), (size) => {
      call += 1;
      return Buffer.alloc(size, call);
    });
    const context = {
      endpointId: '00000000-0000-4000-8000-000000000002',
      merchantId: '00000000-0000-4000-8000-000000000001',
      secretVersion: 1,
    };
    const created = cipher.create(context);

    expect(created.plaintext).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/u);
    expect(created.encrypted).toMatchObject({
      algorithm: 'aes-256-gcm',
      encryptionKeyId: 'local-v1',
      secretVersion: 1,
    });
    expect(created.encrypted.nonce).toHaveLength(12);
    expect(created.encrypted.ciphertext).toHaveLength(49);
    expect(created.encrypted.authenticationTag).toHaveLength(16);
    expect(cipher.decrypt(context, created.encrypted)).toBe(created.plaintext);
  });

  it('fails closed after ciphertext or AAD context substitution', () => {
    const cipher = new WebhookSecretCipher(keyring());
    const context = {
      endpointId: '00000000-0000-4000-8000-000000000002',
      merchantId: '00000000-0000-4000-8000-000000000001',
      secretVersion: 1,
    };
    const created = cipher.create(context);
    const tampered = Uint8Array.from(created.encrypted.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;

    expect(() => cipher.decrypt(context, { ...created.encrypted, ciphertext: tampered })).toThrow();
    expect(() => cipher.decrypt({ ...context, secretVersion: 2 }, created.encrypted)).toThrow();
  });

  it('rejects malformed keys and every local-provider production startup', () => {
    expect(
      () =>
        new LocalWebhookKeyring({
          activeKeyId: 'local-v1',
          keysJson: '{"local-v1":"not-a-key"}',
          nodeEnvironment: 'test',
          provider: 'local',
        }),
    ).toThrow(WebhookKeyringUnavailableError);
    expect(
      () =>
        new LocalWebhookKeyring({
          activeKeyId: 'local-v1',
          keysJson: JSON.stringify({ 'local-v1': Buffer.alloc(32).toString('base64url') }),
          nodeEnvironment: 'production',
          provider: 'local',
        }),
    ).toThrow(WebhookKeyringUnavailableError);
  });

  it.each([
    {
      activeKeyId: 'local-v1',
      keysJson: '{}',
      nodeEnvironment: 'test' as const,
      provider: 'kms',
    },
    {
      activeKeyId: 'invalid key id',
      keysJson: '{}',
      nodeEnvironment: 'test' as const,
      provider: 'local',
    },
    {
      activeKeyId: 'local-v1',
      keysJson: '{',
      nodeEnvironment: 'test' as const,
      provider: 'local',
    },
    {
      activeKeyId: 'local-v1',
      keysJson: '[]',
      nodeEnvironment: 'test' as const,
      provider: 'local',
    },
    {
      activeKeyId: 'local-v1',
      keysJson: '{}',
      nodeEnvironment: 'test' as const,
      provider: 'local',
    },
    {
      activeKeyId: 'missing',
      keysJson: JSON.stringify({ 'local-v1': Buffer.alloc(32).toString('base64url') }),
      nodeEnvironment: 'test' as const,
      provider: 'local',
    },
    {
      activeKeyId: 'local-v1',
      keysJson: JSON.stringify({ 'invalid key id': Buffer.alloc(32).toString('base64url') }),
      nodeEnvironment: 'test' as const,
      provider: 'local',
    },
    {
      activeKeyId: 'local-v1',
      keysJson: JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [
            `local-${index}`,
            Buffer.alloc(32, index).toString('base64url'),
          ]),
        ),
      ),
      nodeEnvironment: 'test' as const,
      provider: 'local',
    },
  ])('fails closed for unusable keyring options %#', (options) => {
    expect(() => new LocalWebhookKeyring(options)).toThrow(WebhookKeyringUnavailableError);
  });

  it('fails closed for missing keys, malformed entropy, invalid active keys, and algorithms', () => {
    const local = keyring();
    expect(() => local.get('missing')).toThrow(WebhookKeyringUnavailableError);

    const context = {
      endpointId: '00000000-0000-4000-8000-000000000002',
      merchantId: '00000000-0000-4000-8000-000000000001',
      secretVersion: 1,
    };
    expect(() => new WebhookSecretCipher(local, () => Buffer.alloc(1)).create(context)).toThrow(
      WebhookKeyringUnavailableError,
    );
    expect(() =>
      new WebhookSecretCipher(
        {
          active: (): { readonly id: string; readonly key: Buffer } => ({
            id: 'bad',
            key: Buffer.alloc(31),
          }),
          get: (): Buffer => Buffer.alloc(31),
        },
        (size: number): Buffer => Buffer.alloc(size),
      ).create(context),
    ).toThrow(WebhookKeyringUnavailableError);

    const cipher = new WebhookSecretCipher(local);
    const encrypted = cipher.create(context).encrypted;
    expect(() =>
      cipher.decrypt(context, { ...encrypted, algorithm: 'invalid' as 'aes-256-gcm' }),
    ).toThrow(WebhookKeyringUnavailableError);
  });
});
