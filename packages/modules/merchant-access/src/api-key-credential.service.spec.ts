import {
  ApiKeyCredentialService,
  apiKeyCredentialServiceInternals,
} from './api-key-credential.service';

describe('ApiKeyCredentialService', () => {
  const service = new ApiKeyCredentialService();

  it('generates a one-time credential while exposing only a safe prefix and slow hash', async () => {
    const first = await service.generate();
    const second = await service.generate();

    expect(first.plaintext).toMatch(/^sf_test_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/);
    expect(first.prefix).toMatch(/^sf_test_[A-Za-z0-9_-]{12}$/);
    expect(first.secretHash).toMatch(/^scrypt:v1:16384:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
    expect(first.secretHash).not.toContain(first.plaintext);
    expect(first.plaintext).not.toBe(second.plaintext);
    expect(first.secretHash).not.toBe(second.secretHash);
  });

  it('verifies only the complete matching credential and rejects malformed storage', async () => {
    const generated = await service.generate();
    const different = await service.generate();

    await expect(service.verify(generated.plaintext, generated.secretHash)).resolves.toBe(true);
    await expect(service.verify(different.plaintext, generated.secretHash)).resolves.toBe(false);
    await expect(service.verify('not-an-api-key', generated.secretHash)).resolves.toBe(false);
    await expect(service.verify(generated.plaintext, 'scrypt:v0:broken')).resolves.toBe(false);
  });

  it('deduplicates and briefly caches only successful slow verification', async () => {
    const generated = await service.generate();
    let now = 1_000;
    const deriveKey = jest.fn(apiKeyCredentialServiceInternals.deriveKey);
    const verifier = new ApiKeyCredentialService({
      deriveKey,
      now: (): number => now,
      verificationCacheSize: 2,
      verificationCacheTtlMs: 1_000,
    });

    await expect(
      Promise.all(
        Array.from({ length: 30 }, () =>
          verifier.verify(generated.plaintext, generated.secretHash),
        ),
      ),
    ).resolves.toEqual(Array.from({ length: 30 }, () => true));
    expect(deriveKey).toHaveBeenCalledTimes(1);

    await expect(verifier.verify(generated.plaintext, generated.secretHash)).resolves.toBe(true);
    expect(deriveKey).toHaveBeenCalledTimes(1);

    now += 1_001;
    await expect(verifier.verify(generated.plaintext, generated.secretHash)).resolves.toBe(true);
    expect(deriveKey).toHaveBeenCalledTimes(2);
  });

  it('does not retain failed verification and evicts the least-recent success at the bound', async () => {
    const first = await service.generate();
    const second = await service.generate();
    const deriveKey = jest.fn(apiKeyCredentialServiceInternals.deriveKey);
    const verifier = new ApiKeyCredentialService({
      deriveKey,
      verificationCacheSize: 1,
      verificationCacheTtlMs: 60_000,
    });

    await expect(verifier.verify(second.plaintext, first.secretHash)).resolves.toBe(false);
    await expect(verifier.verify(second.plaintext, first.secretHash)).resolves.toBe(false);
    expect(deriveKey).toHaveBeenCalledTimes(2);

    await expect(verifier.verify(first.plaintext, first.secretHash)).resolves.toBe(true);
    await expect(verifier.verify(second.plaintext, second.secretHash)).resolves.toBe(true);
    await expect(verifier.verify(first.plaintext, first.secretHash)).resolves.toBe(true);
    expect(deriveKey).toHaveBeenCalledTimes(5);
  });

  it('uses only a fixed non-secret fingerprint as the verification-cache key', () => {
    const plaintext = `sf_test_${'a'.repeat(12)}.${'b'.repeat(43)}`;
    const storedHash = `scrypt:v1:16384:8:1:${'c'.repeat(22)}:${'d'.repeat(43)}`;
    const fingerprint = apiKeyCredentialServiceInternals.verificationFingerprint(
      plaintext,
      storedHash,
    );

    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(fingerprint).not.toContain(plaintext);
    expect(fingerprint).not.toContain(storedHash);
  });
});
