import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

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

export class ApiKeyCredentialService {
  public async generate(): Promise<GeneratedApiKeyCredential> {
    const publicComponent = randomBytes(PUBLIC_COMPONENT_BYTES).toString('base64url');
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const prefix = `${API_KEY_PREFIX_MARKER}${publicComponent}`;
    const plaintext = `${prefix}.${secret}`;
    const salt = randomBytes(SALT_BYTES);
    const derivedKey = await deriveKey(plaintext, salt);

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

    const actual = await deriveKey(plaintext, parsedHash.salt);
    return timingSafeEqual(actual, parsedHash.derivedKey);
  }
}
