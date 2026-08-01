import { generateRequestId, resolveRequestId } from './request-id';

describe('request IDs', () => {
  it('accepts exactly one safe caller value', () => {
    expect(resolveRequestId({ headers: {}, rawHeaders: ['X-Request-Id', 'caller.safe:123'] })).toBe(
      'caller.safe:123',
    );
  });

  it('replaces missing, duplicate, overlong, and log-injection values', () => {
    const candidates = [
      resolveRequestId({ headers: {} }),
      resolveRequestId({
        headers: {},
        rawHeaders: ['X-Request-Id', 'one', 'X-Request-Id', 'two'],
      }),
      resolveRequestId({ headers: { 'x-request-id': 'a'.repeat(129) } }),
      resolveRequestId({ headers: { 'x-request-id': 'bad\nvalue' } }),
    ];

    for (const candidate of candidates) {
      expect(candidate).toMatch(/^req_[A-Za-z0-9_-]{24}$/u);
    }
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it('generates high-entropy values in the database-approved alphabet', () => {
    expect(generateRequestId()).toMatch(/^req_[A-Za-z0-9_-]{24}$/u);
  });
});
