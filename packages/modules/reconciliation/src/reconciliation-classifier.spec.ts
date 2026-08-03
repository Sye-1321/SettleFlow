import { classifyReconciliation } from './reconciliation-classifier';
import type { ParsedProviderRow, PlatformReconciliationRecord } from './reconciliation.types';

describe('reconciliation classifier', () => {
  const platform: PlatformReconciliationRecord = {
    currency: 'ETB',
    eventType: 'capture',
    externalRef: 'order-1',
    feeMinor: 0n,
    grossMinor: 100n,
    netMinor: 100n,
    providerRef: 'ltx_1',
    publicRef: 'pi_1',
    recordType: 'capture',
  };
  const provider: ParsedProviderRow = {
    currency: 'ETB',
    eventType: 'capture',
    externalRef: undefined,
    feeMinor: 0n,
    grossMinor: 100n,
    merchantCode: 'merchant_a',
    netMinor: 100n,
    occurredAt: new Date('2026-08-02T10:00:00.000Z'),
    providerRef: 'ltx_1',
    providerTransactionId: 'txn_1',
    rowNumber: 1,
    status: 'succeeded',
  };

  it('matches provider reference exactly and makes duplicate rows mutually exclusive', () => {
    expect(
      classifyReconciliation([provider, { ...provider, rowNumber: 2 }], [platform]).map(
        (row) => row.bucket,
      ),
    ).toEqual(['matched_exact', 'duplicate_provider_row']);
  });

  it('uses currency mismatch before amount and status mismatch', () => {
    expect(
      classifyReconciliation(
        [{ ...provider, currency: 'USD', grossMinor: 90n, status: 'failed' }],
        [platform],
      )[0]?.bucket,
    ).toBe('currency_mismatch');
  });

  it('uses amount before status and preserves unmatched records in exclusive buckets', () => {
    const results = classifyReconciliation(
      [
        { ...provider, grossMinor: 90n, netMinor: 90n, status: 'failed' },
        { ...provider, providerRef: 'missing', providerTransactionId: 'txn_2' },
      ],
      [platform, { ...platform, providerRef: 'unconsumed', publicRef: 'pi_2' }],
    );
    expect(results.map((row) => row.bucket)).toEqual([
      'amount_mismatch',
      'provider_only',
      'platform_only',
    ]);
  });

  it('does not choose an ambiguous settlement ledger reference and falls back to the scoped external reference', () => {
    const adjustment = {
      ...platform,
      eventType: 'adjustment',
      externalRef: 'sta_1',
      providerRef: 'ltx_shared',
      publicRef: 'sta_1',
      recordType: 'adjustment',
    };
    const otherAdjustment = { ...adjustment, externalRef: 'sta_2', publicRef: 'sta_2' };
    const providerAdjustment = {
      ...provider,
      eventType: 'adjustment' as const,
      externalRef: 'sta_1',
      providerRef: 'ltx_shared',
    };
    expect(
      classifyReconciliation([providerAdjustment], [adjustment, otherAdjustment])[0],
    ).toMatchObject({
      bucket: 'matched_exact',
      matchedBy: 'external_ref',
      platform: { publicRef: 'sta_1' },
    });
  });
});
