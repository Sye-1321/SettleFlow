import type {
  ParsedProviderRow,
  PlatformReconciliationRecord,
  ReconciliationBucket,
  ReconciliationCurrency,
} from './reconciliation.types';

export interface ClassifiedReconciliationResult {
  readonly bucket: ReconciliationBucket;
  readonly currency: ReconciliationCurrency;
  readonly matchedBy: 'external_ref' | 'provider_ref' | undefined;
  readonly platform?: PlatformReconciliationRecord;
  readonly provider?: ParsedProviderRow;
  readonly reasonCode: string;
}

function uniqueIndex(
  rows: readonly PlatformReconciliationRecord[],
  keyFor: (row: PlatformReconciliationRecord) => string | undefined,
): ReadonlyMap<string, PlatformReconciliationRecord> {
  const grouped = new Map<string, PlatformReconciliationRecord[]>();
  for (const row of rows) {
    const key = keyFor(row);
    if (key === undefined) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return new Map(
    [...grouped.entries()]
      .filter(([, matches]) => matches.length === 1)
      .map(([key, matches]) => [key, matches[0]!]),
  );
}

export function classifyReconciliation(
  providerRows: readonly ParsedProviderRow[],
  platformRows: readonly PlatformReconciliationRecord[],
): readonly ClassifiedReconciliationResult[] {
  // A settlement Ledger transaction can represent a batch plus multiple adjustment
  // records. Ambiguous provider references must not pick an arbitrary platform row;
  // those rows may still match by their event-type-scoped external reference.
  const providerRefs = uniqueIndex(platformRows, (row) => `${row.eventType}:${row.providerRef}`);
  const externalRefs = uniqueIndex(platformRows, (row) =>
    row.externalRef === undefined ? undefined : `${row.eventType}:${row.externalRef}`,
  );
  const consumed = new Set<string>();
  const providerTransactions = new Set<string>();
  const results: ClassifiedReconciliationResult[] = [];
  for (const provider of providerRows) {
    if (providerTransactions.has(provider.providerTransactionId)) {
      results.push({
        bucket: 'duplicate_provider_row',
        currency: provider.currency,
        matchedBy: undefined,
        provider,
        reasonCode: 'duplicate_provider_transaction_id',
      });
      continue;
    }
    providerTransactions.add(provider.providerTransactionId);
    let matchedBy: 'external_ref' | 'provider_ref' | undefined;
    let platform = providerRefs.get(`${provider.eventType}:${provider.providerRef}`);
    if (platform !== undefined) matchedBy = 'provider_ref';
    if (platform === undefined && provider.externalRef !== undefined) {
      platform = externalRefs.get(`${provider.eventType}:${provider.externalRef}`);
      if (platform !== undefined) matchedBy = 'external_ref';
    }
    if (platform === undefined || consumed.has(`${platform.recordType}:${platform.publicRef}`)) {
      results.push({
        bucket: 'provider_only',
        currency: provider.currency,
        matchedBy: undefined,
        provider,
        reasonCode: 'platform_record_not_found',
      });
      continue;
    }
    consumed.add(`${platform.recordType}:${platform.publicRef}`);
    let bucket: ReconciliationBucket = 'matched_exact';
    let reasonCode = 'exact_match';
    if (platform.currency !== provider.currency) {
      bucket = 'currency_mismatch';
      reasonCode = 'currency_differs';
    } else if (
      platform.grossMinor !== provider.grossMinor ||
      platform.feeMinor !== provider.feeMinor ||
      platform.netMinor !== provider.netMinor
    ) {
      bucket = 'amount_mismatch';
      reasonCode = 'amounts_differ';
    } else if (provider.status !== 'succeeded') {
      bucket = 'status_mismatch';
      reasonCode = 'provider_status_failed';
    }
    results.push({
      bucket,
      currency: provider.currency,
      matchedBy,
      platform,
      provider,
      reasonCode,
    });
  }
  for (const platform of platformRows) {
    if (!consumed.has(`${platform.recordType}:${platform.publicRef}`))
      results.push({
        bucket: 'platform_only',
        currency: platform.currency,
        matchedBy: undefined,
        platform,
        reasonCode: 'provider_record_not_found',
      });
  }
  return results;
}
