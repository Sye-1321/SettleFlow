export const MERCHANT_API_KEY_SCOPES = [
  'ledger:read',
  'payments:read',
  'payments:write',
  'reconciliation:read',
  'reconciliation:write',
  'settlements:read',
  'settlements:write',
  'webhooks:manage',
  'webhooks:read',
] as const;

export type MerchantApiKeyScope = (typeof MERCHANT_API_KEY_SCOPES)[number];

const merchantApiKeyScopeSet = new Set<string>(MERCHANT_API_KEY_SCOPES);

export function isMerchantApiKeyScope(value: string): value is MerchantApiKeyScope {
  return merchantApiKeyScopeSet.has(value);
}

export function normalizeMerchantApiKeyScopes(
  scopes: readonly MerchantApiKeyScope[],
): readonly MerchantApiKeyScope[] {
  const normalized = [...new Set(scopes)].sort();

  if (normalized.length === 0 || normalized.some((scope) => !isMerchantApiKeyScope(scope))) {
    throw new MerchantAccessValidationError('At least one supported API-key scope is required');
  }

  return normalized;
}

export class MerchantAccessValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MerchantAccessValidationError';
  }
}
