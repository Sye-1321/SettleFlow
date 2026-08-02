import {
  findDatabaseConstraint,
  PrismaDatabase,
  type PrismaTransactionClient,
} from '@settleflow/infrastructure';

import {
  LedgerAccountsNotProvisionedError,
  LedgerBusinessReferenceConflictError,
  LedgerIdentifierCollisionError,
  LedgerInvariantViolationError,
  LedgerReversalConflictError,
} from './ledger.errors';
import type {
  CreateLedgerPostingRecord,
  LedgerAccountCode,
  LedgerAccountRecord,
  LedgerBusinessType,
  LedgerCurrency,
  LedgerEntryRecord,
  LedgerEntrySide,
  LedgerPostingResult,
  LedgerRepository,
  ProvisionLedgerAccountRecord,
  StoredLedgerTransaction,
} from './ledger.types';

const BUSINESS_TYPE_TO_PRISMA = {
  capture: 'CAPTURE',
  refund: 'REFUND',
  reversal: 'REVERSAL',
} as const;
const CODE_TO_PRISMA = {
  merchant_payable: 'merchant_payable',
  provider_clearing: 'provider_clearing',
} as const;
const SIDE_TO_PRISMA = { credit: 'CREDIT', debit: 'DEBIT' } as const;

const LEDGER_INVARIANT_CONSTRAINTS = new Set([
  'ledger_entries_amount_minor_range_check',
  'ledger_entries_currency_consistency_check',
  'ledger_entries_minimum_count_check',
  'ledger_entries_posted_transaction_immutable_check',
  'ledger_accounts_provisioning_complete_check',
  'ledger_transactions_balance_check',
  'ledger_transactions_posted_at_required_check',
  'ledger_transactions_reversal_exact_check',
  'ledger_transactions_reversal_target_check',
]);

function accountCode(value: string): LedgerAccountCode {
  if (value === 'MERCHANT_PAYABLE' || value === 'merchant_payable') return 'merchant_payable';
  if (value === 'PROVIDER_CLEARING' || value === 'provider_clearing') return 'provider_clearing';
  throw new LedgerInvariantViolationError();
}

function entrySide(value: string): LedgerEntrySide {
  if (value === 'CREDIT' || value === 'credit') return 'credit';
  if (value === 'DEBIT' || value === 'debit') return 'debit';
  throw new LedgerInvariantViolationError();
}

function businessType(value: string): LedgerBusinessType {
  if (value === 'capture' || value === 'CAPTURE') return 'capture';
  if (value === 'refund' || value === 'REFUND') return 'refund';
  if (value === 'reversal' || value === 'REVERSAL') return 'reversal';
  throw new LedgerInvariantViolationError();
}

function currency(value: string): LedgerCurrency {
  if (value === 'ETB' || value === 'USD') return value;
  throw new LedgerInvariantViolationError();
}

interface LockedLedgerTransaction {
  readonly business_reference: string;
  readonly business_type: string;
  readonly currency: string;
  readonly id: string;
  readonly merchant_id: string;
  readonly occurred_at: Date;
  readonly posted_at: Date;
  readonly public_id: string;
}

interface FinalizedLedgerTransaction {
  readonly posted_at: Date;
}

export class PrismaLedgerRepository implements LedgerRepository {
  public constructor(private readonly database: PrismaDatabase) {}

  public async provisionAccounts(
    transaction: PrismaTransactionClient,
    accounts: readonly ProvisionLedgerAccountRecord[],
  ): Promise<readonly LedgerAccountRecord[]> {
    const merchantId = accounts[0]?.merchantId;
    if (merchantId === undefined || accounts.some((account) => account.merchantId !== merchantId)) {
      throw new LedgerAccountsNotProvisionedError();
    }
    try {
      await transaction.ledgerAccount.createMany({
        data: accounts.map((account) => ({
          code: CODE_TO_PRISMA[account.code],
          currency: account.currency,
          id: account.id,
          merchantId: account.merchantId,
          normalSide: SIDE_TO_PRISMA[account.normalSide],
        })),
        skipDuplicates: true,
      });
      const rows = await transaction.ledgerAccount.findMany({
        orderBy: [{ currency: 'asc' }, { code: 'asc' }],
        select: { code: true, currency: true, merchantId: true, normalSide: true },
        where: { merchantId },
      });
      const result = rows.map((row) => ({
        code: accountCode(row.code),
        currency: currency(row.currency),
        merchantId: row.merchantId,
        normalSide: entrySide(row.normalSide),
      }));
      if (
        result.length !== 4 ||
        result.some((row) => {
          const expected = accounts.find(
            (account) => account.code === row.code && account.currency === row.currency,
          );
          return expected?.normalSide !== row.normalSide;
        })
      ) {
        throw new LedgerAccountsNotProvisionedError();
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof LedgerAccountsNotProvisionedError) throw error;
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async createPosting(
    transaction: PrismaTransactionClient,
    input: CreateLedgerPostingRecord,
  ): Promise<LedgerPostingResult> {
    try {
      const accountRows = await transaction.ledgerAccount.findMany({
        select: { code: true, currency: true, id: true, normalSide: true },
        where: { merchantId: input.merchantId },
      });
      const accountIds = new Map(
        accountRows
          .filter((account) => account.currency === input.currency)
          .map((account) => [accountCode(account.code), account.id] as const),
      );
      if (
        accountRows.length !== 4 ||
        accountRows.some((account) => {
          const code = accountCode(account.code);
          const expectedSide = code === 'provider_clearing' ? 'debit' : 'credit';
          return (
            (account.currency !== 'ETB' && account.currency !== 'USD') ||
            entrySide(account.normalSide) !== expectedSide
          );
        }) ||
        accountIds.size !== new Set(input.entries.map((entry) => entry.accountCode)).size ||
        input.entries.some((entry) => !accountIds.has(entry.accountCode))
      ) {
        throw new LedgerAccountsNotProvisionedError();
      }

      await transaction.ledgerTransaction.create({
        data: {
          businessReference: input.businessReference,
          businessType: BUSINESS_TYPE_TO_PRISMA[input.businessType],
          currency: input.currency,
          id: input.id,
          merchantId: input.merchantId,
          occurredAt: input.occurredAt,
          publicId: input.publicId,
          requestId: input.requestId,
          ...(input.reversalOfId === undefined ? {} : { reversalOfId: input.reversalOfId }),
        },
      });
      await transaction.ledgerEntry.createMany({
        data: input.entries.map((entry) => ({
          accountId: accountIds.get(entry.accountCode)!,
          amountMinor: entry.amountMinor,
          currency: entry.currency,
          entrySeq: entry.entrySeq,
          id: entry.id,
          ledgerTransactionId: input.id,
          merchantId: input.merchantId,
          side: SIDE_TO_PRISMA[entry.side],
        })),
      });
      const finalized = await transaction.$queryRaw<FinalizedLedgerTransaction[]>`
        UPDATE "ledger_transactions"
        SET "posted_at" = transaction_timestamp()
        WHERE "id" = ${input.id}::uuid
          AND "merchant_id" = ${input.merchantId}::uuid
          AND "posted_at" IS NULL
        RETURNING "posted_at"
      `;
      const postedAt = finalized[0]?.posted_at;
      if (postedAt === undefined) {
        throw new LedgerInvariantViolationError();
      }
      return {
        businessReference: input.businessReference,
        businessType: input.businessType,
        currency: input.currency,
        entries: input.entries.map((entry) => ({
          accountCode: entry.accountCode,
          amountMinor: entry.amountMinor,
          currency: entry.currency,
          entrySeq: entry.entrySeq,
          side: entry.side,
        })),
        merchantId: input.merchantId,
        occurredAt: input.occurredAt,
        postedAt,
        publicId: input.publicId,
        ...(input.reversalOfPublicId === undefined
          ? {}
          : { reversalOfPublicId: input.reversalOfPublicId }),
      };
    } catch (error: unknown) {
      if (
        error instanceof LedgerAccountsNotProvisionedError ||
        error instanceof LedgerInvariantViolationError
      ) {
        throw error;
      }
      const constraint = findDatabaseConstraint(error);
      if (
        constraint === 'ledger_transactions_public_id_key' ||
        constraint === 'public_id' ||
        constraint === 'publicId'
      ) {
        throw new LedgerIdentifierCollisionError();
      }
      if (
        constraint === 'ledger_transactions_merchant_id_business_type_reference_key' ||
        constraint === 'merchant_id,business_type,business_reference'
      ) {
        throw new LedgerBusinessReferenceConflictError();
      }
      if (
        constraint === 'ledger_transactions_reversal_of_id_key' ||
        constraint === 'reversal_of_id'
      ) {
        throw new LedgerReversalConflictError();
      }
      if (constraint !== undefined && LEDGER_INVARIANT_CONSTRAINTS.has(constraint)) {
        throw new LedgerInvariantViolationError();
      }
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async findPostedForReversal(
    transaction: PrismaTransactionClient,
    merchantId: string,
    publicId: string,
  ): Promise<StoredLedgerTransaction | undefined> {
    try {
      // Prisma cannot express the required tenant-scoped row lock. The lock
      // serializes concurrent reversal ownership before the unique safeguard.
      const transactions = await transaction.$queryRaw<LockedLedgerTransaction[]>`
        SELECT
          "id",
          "public_id",
          "merchant_id",
          "currency",
          "business_type"::text AS "business_type",
          "business_reference",
          "occurred_at",
          "posted_at"
        FROM "ledger_transactions"
        WHERE "merchant_id" = ${merchantId}::uuid
          AND "public_id" = ${publicId}
          AND "posted_at" IS NOT NULL
        FOR UPDATE
      `;
      const stored = transactions[0];
      if (stored === undefined) return undefined;
      const rows = await transaction.ledgerEntry.findMany({
        orderBy: { entrySeq: 'asc' },
        select: {
          account: { select: { code: true } },
          amountMinor: true,
          currency: true,
          entrySeq: true,
          side: true,
        },
        where: { ledgerTransactionId: stored.id, merchantId },
      });
      const entries: LedgerEntryRecord[] = rows.map((row) => ({
        accountCode: accountCode(row.account.code),
        amountMinor: row.amountMinor,
        currency: currency(row.currency),
        entrySeq: row.entrySeq,
        side: entrySide(row.side),
      }));
      return {
        businessReference: stored.business_reference,
        businessType: businessType(stored.business_type),
        currency: currency(stored.currency),
        entries,
        internalId: stored.id,
        merchantId: stored.merchant_id,
        occurredAt: stored.occurred_at,
        postedAt: stored.posted_at,
        publicId: stored.public_id,
      };
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }
  }
}

export const prismaLedgerRepositoryInternals = {
  LEDGER_INVARIANT_CONSTRAINTS,
  accountCode,
  businessType,
  currency,
  entrySide,
};
