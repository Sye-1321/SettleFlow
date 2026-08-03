import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  InvalidLedgerCommandError,
  LedgerReversalConflictError,
  LedgerTransactionNotFoundError,
} from './ledger.errors';
import { LedgerService } from './ledger.service';
import type {
  LedgerObserver,
  LedgerPostingResult,
  LedgerRepository,
  CreateLedgerPostingRecord,
  ProvisionLedgerAccountRecord,
  StoredLedgerTransaction,
} from './ledger.types';

describe('LedgerService', () => {
  const transaction = {} as PrismaTransactionClient;
  const occurredAt = new Date('2026-08-02T12:00:00.000Z');
  const merchantId = '00000000-0000-4000-8000-000000000001';
  const transactionId = 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const original: StoredLedgerTransaction = {
    businessReference: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    businessType: 'capture',
    currency: 'ETB',
    entries: [
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
    ],
    internalId: '00000000-0000-4000-8000-000000000010',
    merchantId,
    occurredAt,
    postedAt: occurredAt,
    publicId: transactionId,
  };

  function harness(): {
    readonly observer: jest.Mocked<LedgerObserver>;
    readonly repository: jest.Mocked<LedgerRepository>;
    readonly service: LedgerService;
  } {
    const repository: jest.Mocked<LedgerRepository> = {
      createPosting: jest
        .fn()
        .mockImplementation((_tx: PrismaTransactionClient, input: CreateLedgerPostingRecord) =>
          Promise.resolve({
            businessReference: input.businessReference,
            businessType: input.businessType,
            currency: input.currency,
            entries: input.entries,
            merchantId: input.merchantId,
            occurredAt: input.occurredAt,
            postedAt: occurredAt,
            publicId: input.publicId,
            ...(input.reversalOfPublicId === undefined
              ? {}
              : { reversalOfPublicId: input.reversalOfPublicId }),
          } satisfies LedgerPostingResult),
        ),
      findPostedForReversal: jest.fn().mockResolvedValue(original),
      provisionAccounts: jest
        .fn()
        .mockImplementation(
          (_tx: PrismaTransactionClient, accounts: readonly ProvisionLedgerAccountRecord[]) =>
            Promise.resolve(
              accounts.map((account) => ({
                code: account.code,
                currency: account.currency,
                merchantId: account.merchantId,
                normalSide: account.normalSide,
              })),
            ),
        ),
    };
    const identifiers = {
      generate: jest.fn().mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAW'),
    } as unknown as jest.Mocked<MonotonicUlidGenerator>;
    const observer: jest.Mocked<LedgerObserver> = { record: jest.fn() };
    let sequence = 0;
    const uuid = (): string => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
    return {
      observer,
      repository,
      service: new LedgerService(repository, identifiers, observer, uuid),
    };
  }

  it('stages capture and refund through the supplied transaction with fixed mappings', async () => {
    const subject = harness();
    const command = {
      amountMinor: 125_000n,
      businessReference: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      currency: 'ETB' as const,
      merchantId,
      occurredAt,
      requestId: 'req_ledger_test',
    };

    await subject.service.postCapture(transaction, command);
    await subject.service.postRefund(transaction, {
      ...command,
      amountMinor: 5_000n,
      businessReference: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });

    expect(subject.repository.createPosting.mock.calls[0]?.[0]).toBe(transaction);
    expect(subject.repository.createPosting.mock.calls[0]?.[1].entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: 'provider_clearing', side: 'debit' }),
        expect.objectContaining({ accountCode: 'merchant_payable', side: 'credit' }),
      ]),
    );
    expect(subject.repository.createPosting.mock.calls[1]?.[1].entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: 'merchant_payable', side: 'debit' }),
        expect.objectContaining({ accountCode: 'provider_clearing', side: 'credit' }),
      ]),
    );
    expect(subject.observer.record.mock.calls[0]?.[0]).toEqual({
      businessType: 'capture',
      merchantId,
      name: 'ledger.post',
      outcome: 'staged',
      publicId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAW',
    });
    expect(JSON.stringify(subject.observer.record.mock.calls)).not.toContain('125000');
    expect(JSON.stringify(subject.observer.record.mock.calls)).not.toContain('businessReference');
  });

  it('provisions the exact closed ETB/USD account chart idempotently', async () => {
    const subject = harness();
    const result = await subject.service.provisionAccounts(transaction, merchantId);
    expect(result.accounts).toHaveLength(8);
    expect(subject.repository.provisionAccounts.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'provider_clearing',
          currency: 'ETB',
          normalSide: 'debit',
        }),
        expect.objectContaining({
          code: 'merchant_payable',
          currency: 'ETB',
          normalSide: 'credit',
        }),
        expect.objectContaining({
          code: 'provider_clearing',
          currency: 'USD',
          normalSide: 'debit',
        }),
        expect.objectContaining({
          code: 'merchant_payable',
          currency: 'USD',
          normalSide: 'credit',
        }),
      ]),
    );
  });

  it('builds an exact one-time reversal without accepting caller entry data', async () => {
    const subject = harness();
    const result = await subject.service.reverse(transaction, {
      businessReference: transactionId,
      merchantId,
      occurredAt,
      originalPublicId: transactionId,
      requestId: 'req_reversal_test',
    });
    expect(result.reversalOfPublicId).toBe(transactionId);
    expect(subject.repository.createPosting.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        businessType: 'reversal',
        reversalOfId: original.internalId,
        reversalOfPublicId: transactionId,
      }),
    );
    expect(subject.repository.createPosting.mock.calls[0]?.[1].entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entrySeq: 1, side: 'credit' }),
        expect.objectContaining({ entrySeq: 2, side: 'debit' }),
      ]),
    );
  });

  it('rejects invalid commands, unknown transactions, and reversal chains', async () => {
    const subject = harness();
    await expect(
      subject.service.postCapture(transaction, {
        amountMinor: 0n,
        businessReference: ' pi_bad',
        currency: 'ETB',
        merchantId,
        occurredAt,
        requestId: 'req_test',
      }),
    ).rejects.toBeInstanceOf(InvalidLedgerCommandError);

    subject.repository.findPostedForReversal.mockResolvedValueOnce(undefined);
    await expect(
      subject.service.reverse(transaction, {
        businessReference: transactionId,
        merchantId,
        occurredAt,
        originalPublicId: transactionId,
        requestId: 'req_test',
      }),
    ).rejects.toBeInstanceOf(LedgerTransactionNotFoundError);

    subject.repository.findPostedForReversal.mockResolvedValueOnce({
      ...original,
      businessType: 'reversal',
    });
    await expect(
      subject.service.reverse(transaction, {
        businessReference: transactionId,
        merchantId,
        occurredAt,
        originalPublicId: transactionId,
        requestId: 'req_test',
      }),
    ).rejects.toBeInstanceOf(LedgerReversalConflictError);
  });

  it.each([
    { amountMinor: 9_007_199_254_740_992n },
    { businessReference: 'trailing ' },
    { businessReference: 'control\u0000character' },
    { currency: 'EUR' as never },
    { merchantId: 'not-a-uuid' },
    { occurredAt: new Date(Number.NaN) },
    { requestId: 'request id with spaces' },
  ])('rejects every malformed posting dimension %#', async (override) => {
    const subject = harness();
    await expect(
      subject.service.postCapture(transaction, {
        amountMinor: 1n,
        businessReference: 'pi_valid_reference',
        currency: 'ETB',
        merchantId,
        occurredAt,
        requestId: 'req_valid',
        ...override,
      }),
    ).rejects.toBeInstanceOf(InvalidLedgerCommandError);
    expect(subject.repository.createPosting.mock.calls).toHaveLength(0);
  });

  it('does not make the transaction depend on the optional observer', async () => {
    const subject = harness();
    subject.observer.record.mockImplementation(() => {
      throw new Error('telemetry unavailable');
    });
    await expect(
      subject.service.postCapture(transaction, {
        amountMinor: 1n,
        businessReference: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        currency: 'USD',
        merchantId,
        occurredAt,
        requestId: 'req_test',
      }),
    ).resolves.toEqual(expect.objectContaining({ businessType: 'capture' }));
  });
});
