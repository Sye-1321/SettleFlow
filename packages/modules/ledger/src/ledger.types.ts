import type { PrismaTransactionClient } from '@settleflow/infrastructure';

export type LedgerAccountCode =
  'fee_revenue' | 'merchant_payable' | 'provider_clearing' | 'settlement_clearing';
export type LedgerBusinessType = 'capture' | 'refund' | 'reversal' | 'settlement';
export type LedgerCurrency = 'ETB' | 'USD';
export type LedgerEntrySide = 'credit' | 'debit';

export interface LedgerMoneyPostingCommand {
  readonly amountMinor: bigint;
  readonly businessReference: string;
  readonly currency: LedgerCurrency;
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly requestId: string;
}

export interface ReverseLedgerTransactionCommand {
  readonly businessReference: string;
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly originalPublicId: string;
  readonly requestId: string;
}

export interface LedgerSettlementPostingCommand {
  readonly businessReference: string;
  readonly currency: LedgerCurrency;
  readonly feeMinor: bigint;
  readonly grossMinor: bigint;
  readonly merchantId: string;
  readonly netMinor: bigint;
  readonly occurredAt: Date;
  readonly requestId: string;
}

export interface LedgerReconciliationReference {
  readonly businessReference: string;
  readonly businessType: 'capture' | 'refund' | 'settlement';
  readonly providerRef: string;
}

export interface LedgerReconciliationReadPort {
  resolveReconciliationReferences(
    transaction: PrismaTransactionClient,
    merchantId: string,
    references: readonly {
      readonly businessReference: string;
      readonly businessType: 'capture' | 'refund' | 'settlement';
    }[],
  ): Promise<readonly LedgerReconciliationReference[]>;
}

export interface LedgerEntryRecord {
  readonly accountCode: LedgerAccountCode;
  readonly amountMinor: bigint;
  readonly currency: LedgerCurrency;
  readonly entrySeq: number;
  readonly side: LedgerEntrySide;
}

export interface LedgerPostingResult {
  readonly businessReference: string;
  readonly businessType: LedgerBusinessType;
  readonly currency: LedgerCurrency;
  readonly entries: readonly LedgerEntryRecord[];
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly postedAt: Date;
  readonly publicId: string;
  readonly reversalOfPublicId?: string;
}

export interface LedgerSettlementPostingResult extends LedgerPostingResult {
  readonly internalId: string;
}

export interface LedgerAccountRecord {
  readonly code: LedgerAccountCode;
  readonly currency: LedgerCurrency;
  readonly merchantId: string;
  readonly normalSide: LedgerEntrySide;
}

export interface LedgerAccountProvisioningResult {
  readonly accounts: readonly LedgerAccountRecord[];
  readonly merchantId: string;
}

export interface LedgerObservation {
  readonly businessType: LedgerBusinessType;
  readonly errorCode?: string;
  readonly merchantId: string;
  readonly name: 'ledger.post';
  readonly outcome: 'rejected' | 'staged';
  readonly publicId?: string;
}

export interface LedgerObserver {
  record(observation: LedgerObservation): void;
}

export interface ProvisionLedgerAccountRecord {
  readonly code: LedgerAccountCode;
  readonly currency: LedgerCurrency;
  readonly id: string;
  readonly merchantId: string;
  readonly normalSide: LedgerEntrySide;
}

export interface CreateLedgerEntryRecord extends LedgerEntryRecord {
  readonly id: string;
}

export interface CreateLedgerPostingRecord {
  readonly businessReference: string;
  readonly businessType: LedgerBusinessType;
  readonly currency: LedgerCurrency;
  readonly entries: readonly CreateLedgerEntryRecord[];
  readonly id: string;
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly publicId: string;
  readonly requestId: string;
  readonly reversalOfId?: string;
  readonly reversalOfPublicId?: string;
}

export interface StoredLedgerTransaction extends LedgerPostingResult {
  readonly internalId: string;
}

export interface LedgerRepository {
  createPosting(
    transaction: PrismaTransactionClient,
    input: CreateLedgerPostingRecord,
  ): Promise<LedgerPostingResult>;
  findPostedForReversal(
    transaction: PrismaTransactionClient,
    merchantId: string,
    publicId: string,
  ): Promise<StoredLedgerTransaction | undefined>;
  provisionAccounts(
    transaction: PrismaTransactionClient,
    accounts: readonly ProvisionLedgerAccountRecord[],
  ): Promise<readonly LedgerAccountRecord[]>;
}

export interface LedgerPostingPort {
  postCapture(
    transaction: PrismaTransactionClient,
    command: LedgerMoneyPostingCommand,
  ): Promise<LedgerPostingResult>;
  postRefund(
    transaction: PrismaTransactionClient,
    command: LedgerMoneyPostingCommand,
  ): Promise<LedgerPostingResult>;
  postSettlement(
    transaction: PrismaTransactionClient,
    command: LedgerSettlementPostingCommand,
  ): Promise<LedgerSettlementPostingResult>;
  reverse(
    transaction: PrismaTransactionClient,
    command: ReverseLedgerTransactionCommand,
  ): Promise<LedgerPostingResult>;
}
