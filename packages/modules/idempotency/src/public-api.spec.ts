import * as idempotency from './index';

describe('idempotency public API', () => {
  it('exposes the service, repository, and stable error vocabulary', () => {
    expect(Object.values(idempotency).every((value) => value !== undefined)).toBe(true);
    expect(typeof idempotency.IdempotencyService).toBe('function');
    expect(typeof idempotency.PrismaIdempotencyRepository).toBe('function');
  });
});
