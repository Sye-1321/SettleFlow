import { ApiKeyCredentialService } from './api-key-credential.service';

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
});
