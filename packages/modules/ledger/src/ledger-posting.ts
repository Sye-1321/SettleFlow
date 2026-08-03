import { InvalidLedgerCommandError } from './ledger.errors';
import type { LedgerCurrency, LedgerEntryRecord } from './ledger.types';

const MAX_LEDGER_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

function assertAmount(amountMinor: bigint): void {
  if (amountMinor < 1n || amountMinor > MAX_LEDGER_AMOUNT) {
    throw new InvalidLedgerCommandError();
  }
}

export function buildCaptureEntries(
  amountMinor: bigint,
  currency: LedgerCurrency,
): readonly LedgerEntryRecord[] {
  assertAmount(amountMinor);
  return [
    {
      accountCode: 'provider_clearing',
      amountMinor,
      currency,
      entrySeq: 1,
      side: 'debit',
    },
    {
      accountCode: 'merchant_payable',
      amountMinor,
      currency,
      entrySeq: 2,
      side: 'credit',
    },
  ];
}

export function buildRefundEntries(
  amountMinor: bigint,
  currency: LedgerCurrency,
): readonly LedgerEntryRecord[] {
  assertAmount(amountMinor);
  return [
    {
      accountCode: 'merchant_payable',
      amountMinor,
      currency,
      entrySeq: 1,
      side: 'debit',
    },
    {
      accountCode: 'provider_clearing',
      amountMinor,
      currency,
      entrySeq: 2,
      side: 'credit',
    },
  ];
}

export function buildSettlementEntries(
  grossMinor: bigint,
  feeMinor: bigint,
  netMinor: bigint,
  currency: LedgerCurrency,
): readonly LedgerEntryRecord[] {
  assertAmount(grossMinor);
  assertAmount(netMinor);
  if (feeMinor < 0n || feeMinor > MAX_LEDGER_AMOUNT || grossMinor !== feeMinor + netMinor) {
    throw new InvalidLedgerCommandError();
  }
  return [
    {
      accountCode: 'merchant_payable',
      amountMinor: grossMinor,
      currency,
      entrySeq: 1,
      side: 'debit',
    },
    ...(feeMinor === 0n
      ? []
      : [
          {
            accountCode: 'fee_revenue' as const,
            amountMinor: feeMinor,
            currency,
            entrySeq: 2,
            side: 'credit' as const,
          },
        ]),
    {
      accountCode: 'settlement_clearing',
      amountMinor: netMinor,
      currency,
      entrySeq: feeMinor === 0n ? 2 : 3,
      side: 'credit',
    },
  ];
}

export function buildReversalEntries(
  entries: readonly LedgerEntryRecord[],
): readonly LedgerEntryRecord[] {
  if (entries.length < 2) {
    throw new InvalidLedgerCommandError();
  }
  return entries.map((entry) => ({
    ...entry,
    side: entry.side === 'debit' ? 'credit' : 'debit',
  }));
}

export const ledgerPostingInternals = { MAX_LEDGER_AMOUNT, assertAmount };
