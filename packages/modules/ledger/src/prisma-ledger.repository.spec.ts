import { PrismaDatabase, type PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  LedgerAccountsNotProvisionedError,
  LedgerBusinessReferenceConflictError,
  LedgerIdentifierCollisionError,
  LedgerInvariantViolationError,
  LedgerReversalConflictError,
} from './ledger.errors';
import {
  PrismaLedgerRepository,
  prismaLedgerRepositoryInternals,
} from './prisma-ledger.repository';
import type { CreateLedgerPostingRecord, ProvisionLedgerAccountRecord } from './ledger.types';

interface LedgerRepositoryHarness {
  readonly database: PrismaDatabase;
  readonly repository: PrismaLedgerRepository;
  readonly transaction: {
    readonly $queryRaw: jest.Mock;
    readonly ledgerAccount: { readonly createMany: jest.Mock; readonly findMany: jest.Mock };
    readonly ledgerEntry: { readonly createMany: jest.Mock; readonly findMany: jest.Mock };
    readonly ledgerTransaction: { readonly create: jest.Mock };
  };
  readonly tx: PrismaTransactionClient;
}

describe('PrismaLedgerRepository guarded persistence', () => {
  const now = new Date('2026-08-03T10:00:00.000Z');
  const accounts: ProvisionLedgerAccountRecord[] = (['ETB', 'USD'] as const).flatMap((currency) => [
    {
      code: 'provider_clearing' as const,
      currency,
      id: `${currency}-provider`,
      merchantId: 'merchant',
      normalSide: 'debit' as const,
    },
    {
      code: 'merchant_payable' as const,
      currency,
      id: `${currency}-merchant`,
      merchantId: 'merchant',
      normalSide: 'credit' as const,
    },
    {
      code: 'fee_revenue' as const,
      currency,
      id: `${currency}-fee`,
      merchantId: 'merchant',
      normalSide: 'credit' as const,
    },
    {
      code: 'settlement_clearing' as const,
      currency,
      id: `${currency}-settlement`,
      merchantId: 'merchant',
      normalSide: 'credit' as const,
    },
  ]);

  function harness(): LedgerRepositoryHarness {
    const transaction = {
      $queryRaw: jest.fn(),
      ledgerAccount: { createMany: jest.fn(), findMany: jest.fn() },
      ledgerEntry: { createMany: jest.fn(), findMany: jest.fn() },
      ledgerTransaction: { create: jest.fn() },
    };
    const database = {
      rethrowDatabaseError: jest.fn().mockImplementation((error: unknown) => {
        throw error;
      }),
    } as unknown as PrismaDatabase;
    return {
      database,
      repository: new PrismaLedgerRepository(database),
      transaction,
      tx: transaction as unknown as PrismaTransactionClient,
    };
  }

  it('provisions exactly the closed ETB/USD chart', async () => {
    const h = harness();
    h.transaction.ledgerAccount.findMany.mockResolvedValue(
      accounts.map(({ code, currency, merchantId, normalSide }) => ({
        code,
        currency,
        merchantId,
        normalSide,
      })),
    );
    await expect(h.repository.provisionAccounts(h.tx, accounts)).resolves.toHaveLength(8);
    await expect(h.repository.provisionAccounts(h.tx, [])).rejects.toBeInstanceOf(
      LedgerAccountsNotProvisionedError,
    );
    await expect(
      h.repository.provisionAccounts(h.tx, [
        { ...accounts[0]!, merchantId: 'other' },
        ...accounts.slice(1),
      ]),
    ).rejects.toBeInstanceOf(LedgerAccountsNotProvisionedError);
    h.transaction.ledgerAccount.findMany.mockResolvedValue(accounts.slice(0, 7));
    await expect(h.repository.provisionAccounts(h.tx, accounts)).rejects.toBeInstanceOf(
      LedgerAccountsNotProvisionedError,
    );
  });

  it('creates and finalizes a balanced posting from provisioned accounts', async () => {
    const h = harness();
    h.transaction.ledgerAccount.findMany.mockResolvedValue(
      accounts.map((account) => ({ ...account })),
    );
    h.transaction.$queryRaw.mockResolvedValue([{ posted_at: now }]);
    const input: CreateLedgerPostingRecord = {
      businessReference: 'pi-id',
      businessType: 'capture',
      currency: 'ETB',
      entries: [
        {
          accountCode: 'provider_clearing',
          amountMinor: 1_000n,
          currency: 'ETB',
          entrySeq: 1,
          id: 'entry-1',
          side: 'debit',
        },
        {
          accountCode: 'merchant_payable',
          amountMinor: 1_000n,
          currency: 'ETB',
          entrySeq: 2,
          id: 'entry-2',
          side: 'credit',
        },
      ],
      id: 'transaction-id',
      merchantId: 'merchant',
      occurredAt: now,
      publicId: 'ltx-id',
      requestId: 'request',
    };
    await expect(h.repository.createPosting(h.tx, input)).resolves.toMatchObject({
      businessType: 'capture',
      postedAt: now,
      publicId: 'ltx-id',
    });
    expect(h.transaction.ledgerEntry.createMany).toHaveBeenCalled();
    h.transaction.$queryRaw.mockResolvedValue([]);
    await expect(h.repository.createPosting(h.tx, input)).rejects.toBeInstanceOf(
      LedgerInvariantViolationError,
    );
  });

  it('maps every guarded database constraint to the stable ledger error', async () => {
    const cases = [
      ['ledger_transactions_public_id_key', LedgerIdentifierCollisionError],
      [
        'ledger_transactions_merchant_id_business_type_reference_key',
        LedgerBusinessReferenceConflictError,
      ],
      ['ledger_transactions_reversal_of_id_key', LedgerReversalConflictError],
      ['ledger_transactions_balance_check', LedgerInvariantViolationError],
    ] as const;
    for (const [constraint, ErrorType] of cases) {
      const h = harness();
      h.transaction.ledgerAccount.findMany.mockRejectedValue({ constraint });
      await expect(
        h.repository.createPosting(h.tx, {} as CreateLedgerPostingRecord),
      ).rejects.toBeInstanceOf(ErrorType);
    }
  });

  it('maps locked posted transactions and rejects corrupt enum evidence', async () => {
    const h = harness();
    h.transaction.$queryRaw.mockResolvedValue([
      {
        business_reference: 'pi-id',
        business_type: 'REVERSAL',
        currency: 'USD',
        id: 'internal',
        merchant_id: 'merchant',
        occurred_at: now,
        posted_at: now,
        public_id: 'ltx-id',
      },
    ]);
    h.transaction.ledgerEntry.findMany.mockResolvedValue([
      {
        account: { code: 'PROVIDER_CLEARING' },
        amountMinor: 1n,
        currency: 'USD',
        entrySeq: 1,
        side: 'DEBIT',
      },
    ]);
    await expect(
      h.repository.findPostedForReversal(h.tx, 'merchant', 'ltx-id'),
    ).resolves.toMatchObject({ businessType: 'reversal', currency: 'USD' });
    h.transaction.$queryRaw.mockResolvedValue([]);
    await expect(
      h.repository.findPostedForReversal(h.tx, 'merchant', 'missing'),
    ).resolves.toBeUndefined();
    expect(() => prismaLedgerRepositoryInternals.accountCode('unknown')).toThrow(
      LedgerInvariantViolationError,
    );
    expect(() => prismaLedgerRepositoryInternals.entrySide('unknown')).toThrow(
      LedgerInvariantViolationError,
    );
    expect(() => prismaLedgerRepositoryInternals.businessType('unknown')).toThrow(
      LedgerInvariantViolationError,
    );
    expect(() => prismaLedgerRepositoryInternals.currency('EUR')).toThrow(
      LedgerInvariantViolationError,
    );
  });
});
