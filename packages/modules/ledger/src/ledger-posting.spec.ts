import { InvalidLedgerCommandError } from './ledger.errors';
import { buildCaptureEntries, buildRefundEntries, buildReversalEntries } from './ledger-posting';

describe('ledger posting builders', () => {
  it('builds the approved capture and refund goldens', () => {
    expect(buildCaptureEntries(125_000n, 'ETB')).toEqual([
      {
        accountCode: 'provider_clearing',
        amountMinor: 125_000n,
        currency: 'ETB',
        entrySeq: 1,
        side: 'debit',
      },
      {
        accountCode: 'merchant_payable',
        amountMinor: 125_000n,
        currency: 'ETB',
        entrySeq: 2,
        side: 'credit',
      },
    ]);
    expect(buildRefundEntries(50_000n, 'USD')).toEqual([
      {
        accountCode: 'merchant_payable',
        amountMinor: 50_000n,
        currency: 'USD',
        entrySeq: 1,
        side: 'debit',
      },
      {
        accountCode: 'provider_clearing',
        amountMinor: 50_000n,
        currency: 'USD',
        entrySeq: 2,
        side: 'credit',
      },
    ]);
  });

  it('inverts every original entry without changing its evidence', () => {
    const original = buildCaptureEntries(125_000n, 'ETB');
    expect(buildReversalEntries(original)).toEqual([
      { ...original[0], side: 'credit' },
      { ...original[1], side: 'debit' },
    ]);
    expect(original[0]?.side).toBe('debit');
  });

  it.each([0n, -1n, 9_007_199_254_740_992n])('rejects an unsafe amount %s', (amount) => {
    expect(() => buildCaptureEntries(amount, 'ETB')).toThrow(InvalidLedgerCommandError);
  });
});
