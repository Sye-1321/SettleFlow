import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const API_KEY_PREFIX_MARKER = 'sf_test_';
const PUBLIC_COMPONENT_BYTES = 9;
const SECRET_BYTES = 32;
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const HASH_VERSION = 'v1';
const CREDENTIAL_PATTERN = /^(sf_test_[A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/;
const VERIFICATION_CACHE_SIZE = 1_024;
const VERIFICATION_CACHE_TTL_MS = 5 * 60_000;

type DeriveKey = (plaintext: string, salt: Buffer) => Promise<Buffer>;

export interface ApiKeyCredentialServiceOptions {
  readonly deriveKey?: DeriveKey;
  readonly now?: () => number;
  readonly verificationCacheSize?: number;
  readonly verificationCacheTtlMs?: number;
}

export interface GeneratedApiKeyCredential {
  readonly plaintext: string;
  readonly prefix: string;
  readonly secretHash: string;
}

interface ParsedHash {
  readonly derivedKey: Buffer;
  readonly salt: Buffer;
}

function deriveKey(plaintext: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(plaintext, 'utf8'),
      salt,
      DERIVED_KEY_BYTES,
      {
        N: SCRYPT_COST,
        maxmem: SCRYPT_MAX_MEMORY,
        p: SCRYPT_PARALLELIZATION,
        r: SCRYPT_BLOCK_SIZE,
      },
      (error, derivedKey) => {
        if (error !== null) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      },
    );
  });
}

function parseStoredHash(value: string): ParsedHash | undefined {
  const [algorithm, version, cost, blockSize, parallelization, salt, derivedKey, extra] =
    value.split(':');

  if (
    extra !== undefined ||
    algorithm !== 'scrypt' ||
    version !== HASH_VERSION ||
    cost !== String(SCRYPT_COST) ||
    blockSize !== String(SCRYPT_BLOCK_SIZE) ||
    parallelization !== String(SCRYPT_PARALLELIZATION) ||
    salt === undefined ||
    derivedKey === undefined
  ) {
    return undefined;
  }

  try {
    const saltBuffer = Buffer.from(salt, 'base64url');
    const derivedKeyBuffer = Buffer.from(derivedKey, 'base64url');

    if (saltBuffer.length !== SALT_BYTES || derivedKeyBuffer.length !== DERIVED_KEY_BYTES) {
      return undefined;
    }

    return { derivedKey: derivedKeyBuffer, salt: saltBuffer };
  } catch {
    return undefined;
  }
}

function verificationFingerprint(plaintext: string, storedHash: string): string {
  return createHash('sha256')
    .update(plaintext, 'utf8')
    .update('\0', 'utf8')
    .update(storedHash, 'utf8')
    .digest('base64url');
}

export class ApiKeyCredentialService {
  private readonly derive: DeriveKey;
  private readonly now: () => number;
  private readonly verificationCache = new Map<string, number>();
  private readonly verificationCacheSize: number;
  private readonly verificationCacheTtlMs: number;
  private readonly verificationInFlight = new Map<string, Promise<boolean>>();

  public constructor(options: ApiKeyCredentialServiceOptions = {}) {
    this.derive = options.deriveKey ?? deriveKey;
    this.now = options.now ?? ((): number => performance.now());
    this.verificationCacheSize = options.verificationCacheSize ?? VERIFICATION_CACHE_SIZE;
    this.verificationCacheTtlMs = options.verificationCacheTtlMs ?? VERIFICATION_CACHE_TTL_MS;
    if (
      !Number.isInteger(this.verificationCacheSize) ||
      this.verificationCacheSize < 1 ||
      !Number.isInteger(this.verificationCacheTtlMs) ||
      this.verificationCacheTtlMs < 1
    ) {
      throw new Error('API key verification cache configuration is invalid');
    }
  }

  public async generate(): Promise<GeneratedApiKeyCredential> {
    const publicComponent = randomBytes(PUBLIC_COMPONENT_BYTES).toString('base64url');
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const prefix = `${API_KEY_PREFIX_MARKER}${publicComponent}`;
    const plaintext = `${prefix}.${secret}`;
    const salt = randomBytes(SALT_BYTES);
    const derivedKey = await this.derive(plaintext, salt);

    return {
      plaintext,
      prefix,
      secretHash: [
        'scrypt',
        HASH_VERSION,
        SCRYPT_COST,
        SCRYPT_BLOCK_SIZE,
        SCRYPT_PARALLELIZATION,
        salt.toString('base64url'),
        derivedKey.toString('base64url'),
      ].join(':'),
    };
  }

  public extractPrefix(plaintext: string): string | undefined {
    return CREDENTIAL_PATTERN.exec(plaintext)?.[1];
  }

  public async verify(plaintext: string, storedHash: string): Promise<boolean> {
    if (this.extractPrefix(plaintext) === undefined) {
      return false;
    }

    const parsedHash = parseStoredHash(storedHash);
    if (parsedHash === undefined) {
      return false;
    }

    const fingerprint = verificationFingerprint(plaintext, storedHash);
    if (this.hasVerifiedFingerprint(fingerprint)) {
      return true;
    }
    const pending = this.verificationInFlight.get(fingerprint);
    if (pending !== undefined) {
      return pending;
    }
    if (this.verificationInFlight.size >= this.verificationCacheSize) {
      return this.verifyAndRemember(fingerprint, plaintext, parsedHash);
    }
    const verification = this.verifyAndRemember(fingerprint, plaintext, parsedHash).finally(() => {
      this.verificationInFlight.delete(fingerprint);
    });
    this.verificationInFlight.set(fingerprint, verification);
    return verification;
  }

  private hasVerifiedFingerprint(fingerprint: string): boolean {
    const expiresAt = this.verificationCache.get(fingerprint);
    if (expiresAt === undefined) {
      return false;
    }
    this.verificationCache.delete(fingerprint);
    if (expiresAt <= this.now()) {
      return false;
    }
    this.verificationCache.set(fingerprint, expiresAt);
    return true;
  }

  private rememberVerifiedFingerprint(fingerprint: string): void {
    while (this.verificationCache.size >= this.verificationCacheSize) {
      const oldest = this.verificationCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.verificationCache.delete(oldest);
    }
    this.verificationCache.set(fingerprint, this.now() + this.verificationCacheTtlMs);
  }

  private async verifyAndRemember(
    fingerprint: string,
    plaintext: string,
    parsedHash: ParsedHash,
  ): Promise<boolean> {
    const actual = await this.derive(plaintext, parsedHash.salt);
    const verified = timingSafeEqual(actual, parsedHash.derivedKey);
    if (verified) {
      this.rememberVerifiedFingerprint(fingerprint);
    }
    return verified;
  }
}

export const apiKeyCredentialServiceInternals = {
  deriveKey,
  verificationFingerprint,
  VERIFICATION_CACHE_SIZE,
  VERIFICATION_CACHE_TTL_MS,
};
