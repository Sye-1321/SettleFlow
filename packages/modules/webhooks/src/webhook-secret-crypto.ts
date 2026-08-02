import { createCipheriv, createDecipheriv, randomBytes, type CipherGCMTypes } from 'node:crypto';

import { WebhookKeyringUnavailableError } from './webhook.errors';
import type { EncryptedWebhookSecret } from './webhook.types';

const ALGORITHM: CipherGCMTypes = 'aes-256-gcm';
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const MAX_LOCAL_KEYS = 16;

export interface WebhookEncryptionKey {
  readonly id: string;
  readonly key: Uint8Array;
}

export interface WebhookKeyring {
  active(): WebhookEncryptionKey;
  get(keyId: string): Uint8Array;
}

export interface LocalWebhookKeyringOptions {
  readonly activeKeyId: string;
  readonly keysJson: string;
  readonly nodeEnvironment: 'development' | 'production' | 'test';
  readonly provider: string;
}

function decodeKey(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new WebhookKeyringUnavailableError();
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) {
    throw new WebhookKeyringUnavailableError();
  }
  return decoded;
}

export class LocalWebhookKeyring implements WebhookKeyring {
  private readonly activeKeyId: string;
  private readonly keys: ReadonlyMap<string, Uint8Array>;

  public constructor(options: LocalWebhookKeyringOptions) {
    if (options.provider !== 'local' || options.nodeEnvironment === 'production') {
      throw new WebhookKeyringUnavailableError();
    }
    if (!KEY_ID_PATTERN.test(options.activeKeyId)) {
      throw new WebhookKeyringUnavailableError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(options.keysJson);
    } catch {
      throw new WebhookKeyringUnavailableError();
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new WebhookKeyringUnavailableError();
    }
    const entries = Object.entries(parsed);
    if (entries.length < 1 || entries.length > MAX_LOCAL_KEYS) {
      throw new WebhookKeyringUnavailableError();
    }
    const keys = new Map<string, Uint8Array>();
    for (const [keyId, value] of entries) {
      if (!KEY_ID_PATTERN.test(keyId)) {
        throw new WebhookKeyringUnavailableError();
      }
      keys.set(keyId, decodeKey(value));
    }
    if (!keys.has(options.activeKeyId)) {
      throw new WebhookKeyringUnavailableError();
    }
    this.activeKeyId = options.activeKeyId;
    this.keys = keys;
  }

  public active(): WebhookEncryptionKey {
    return { id: this.activeKeyId, key: this.get(this.activeKeyId) };
  }

  public get(keyId: string): Uint8Array {
    const key = this.keys.get(keyId);
    if (key === undefined) {
      throw new WebhookKeyringUnavailableError();
    }
    return key;
  }
}

export interface WebhookSecretContext {
  readonly endpointId: string;
  readonly merchantId: string;
  readonly secretVersion: number;
}

function additionalData(context: WebhookSecretContext, keyId: string): Uint8Array {
  return Buffer.from(
    [
      'settleflow.webhook-secret.v1',
      context.merchantId,
      context.endpointId,
      String(context.secretVersion),
      ALGORITHM,
      keyId,
    ].join('\0'),
    'utf8',
  );
}

export class WebhookSecretCipher {
  public constructor(
    private readonly keyring: WebhookKeyring,
    private readonly random: (size: number) => Uint8Array = randomBytes,
  ) {}

  public create(context: WebhookSecretContext): {
    readonly encrypted: EncryptedWebhookSecret;
    readonly plaintext: string;
  } {
    const plaintext = `whsec_${Buffer.from(this.random(32)).toString('base64url')}`;
    if (Buffer.byteLength(plaintext, 'ascii') !== 49) {
      throw new WebhookKeyringUnavailableError();
    }
    const active = this.keyring.active();
    const nonce = Buffer.from(this.random(12));
    if (active.key.byteLength !== 32 || nonce.byteLength !== 12) {
      throw new WebhookKeyringUnavailableError();
    }
    const cipher = createCipheriv(ALGORITHM, active.key, nonce, { authTagLength: 16 });
    cipher.setAAD(additionalData(context, active.id));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();
    return {
      encrypted: {
        algorithm: 'aes-256-gcm',
        authenticationTag,
        ciphertext,
        encryptionKeyId: active.id,
        nonce,
        secretVersion: context.secretVersion,
      },
      plaintext,
    };
  }

  public decrypt(context: WebhookSecretContext, encrypted: EncryptedWebhookSecret): string {
    if (encrypted.algorithm !== 'aes-256-gcm') {
      throw new WebhookKeyringUnavailableError();
    }
    const decipher = createDecipheriv(
      ALGORITHM,
      this.keyring.get(encrypted.encryptionKeyId),
      encrypted.nonce,
      { authTagLength: 16 },
    );
    decipher.setAAD(additionalData(context, encrypted.encryptionKeyId));
    decipher.setAuthTag(encrypted.authenticationTag);
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString(
      'utf8',
    );
  }
}

export const webhookSecretCryptoInternals = { additionalData, decodeKey };
