import { InvalidSettlementRequestError, SettlementCutoffNotClosedError } from './settlement.errors';
import type { SettlementCurrency, SettlementFeePolicy } from './settlement.types';

export const SETTLEMENT_FEE_POLICY = {
  ETB: { basisPoints: 200, flatFeeMinor: 600n },
  USD: { basisPoints: 200, flatFeeMinor: 25n },
} as const;
export const SETTLEMENT_FEE_POLICY_VERSION = 'settlement_fee_v1';

export function cutoffInstant(cutoffDate: string, now: Date): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(cutoffDate)) throw new InvalidSettlementRequestError();
  const cutoff = new Date(`${cutoffDate}T21:00:00.000Z`);
  if (!Number.isFinite(cutoff.getTime()) || cutoff.toISOString().slice(0, 10) !== cutoffDate) {
    throw new InvalidSettlementRequestError();
  }
  if (now < cutoff) throw new SettlementCutoffNotClosedError();
  return cutoff;
}

export function calculateFee(
  grossMinor: bigint,
  currency: SettlementCurrency,
  suppliedPolicy?: SettlementFeePolicy,
): {
  readonly basisPoints: number;
  readonly feeMinor: bigint;
  readonly flatFeeMinor: bigint;
} {
  const policy = suppliedPolicy ?? SETTLEMENT_FEE_POLICY[currency];
  return {
    ...policy,
    feeMinor: policy.flatFeeMinor + (grossMinor * BigInt(policy.basisPoints)) / 10_000n,
  };
}
