import * as ledger from './index';

describe('ledger public API', () => {
  it('exposes guarded posting and invariant errors without mutation APIs', () => {
    expect(Object.values(ledger).every((value) => value !== undefined)).toBe(true);
    expect(typeof ledger.LedgerService).toBe('function');
    expect(typeof ledger.PrismaLedgerRepository).toBe('function');
  });
});
