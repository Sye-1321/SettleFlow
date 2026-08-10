import { PrismaDatabase, type PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  InvalidReconciliationRequestError,
  ReconciliationChecksumConflictError,
  ReconciliationImportFailedError,
  ReconciliationImportNotFoundError,
  ReconciliationReportNotReadyError,
} from './reconciliation.errors';
import { PrismaReconciliationRepository } from './prisma-reconciliation.repository';
import type { ParsedProviderRow } from './reconciliation.types';

interface ReconciliationRepositoryHarness {
  readonly client: {
    readonly $transaction: jest.Mock;
    readonly merchant: { readonly findUniqueOrThrow: jest.Mock };
    readonly reconciliationImport: { readonly findFirst: jest.Mock };
  };
  readonly repository: PrismaReconciliationRepository;
  readonly transaction: {
    readonly $queryRaw: jest.Mock;
    readonly reconciliationImport: {
      readonly create: jest.Mock;
      readonly findFirst: jest.Mock;
      readonly findUnique: jest.Mock;
      readonly update: jest.Mock;
    };
    readonly reconciliationProviderRow: { readonly createMany: jest.Mock };
    readonly reconciliationResult: { readonly createMany: jest.Mock };
    readonly reconciliationSummary: { readonly createMany: jest.Mock };
  };
  readonly tx: PrismaTransactionClient;
}

describe('PrismaReconciliationRepository', () => {
  const now = new Date('2026-08-03T10:00:00.000Z');
  const periodStart = new Date('2026-08-02T00:00:00.000Z');
  const periodEnd = new Date('2026-08-03T00:00:00.000Z');
  const provider: ParsedProviderRow = {
    currency: 'ETB',
    eventType: 'settlement',
    externalRef: 'batch',
    feeMinor: 20n,
    grossMinor: 1_000n,
    merchantCode: 'merchant-code',
    netMinor: 980n,
    occurredAt: now,
    providerRef: 'provider-ref',
    providerTransactionId: 'provider-transaction',
    rowNumber: 1,
    status: 'succeeded',
  };

  function harness(): ReconciliationRepositoryHarness {
    const transaction = {
      $queryRaw: jest.fn(),
      reconciliationImport: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      reconciliationProviderRow: { createMany: jest.fn() },
      reconciliationResult: { createMany: jest.fn() },
      reconciliationSummary: { createMany: jest.fn() },
    };
    const client = {
      $transaction: jest
        .fn()
        .mockImplementation(
          (operation: (value: typeof transaction) => Promise<unknown>): Promise<unknown> =>
            operation(transaction),
        ),
      merchant: { findUniqueOrThrow: jest.fn() },
      reconciliationImport: { findFirst: jest.fn() },
    };
    const database = {
      getClient: jest.fn().mockReturnValue(client),
      rethrowDatabaseError: jest.fn().mockImplementation((error: unknown) => {
        throw error;
      }),
    } as unknown as PrismaDatabase;
    return {
      client,
      repository: new PrismaReconciliationRepository(database),
      transaction,
      tx: transaction as unknown as PrismaTransactionClient,
    };
  }

  function persisted(status = 'STAGED'): Record<string, unknown> {
    return {
      createdAt: now,
      id: 'internal',
      periodEnd,
      periodStart,
      publicId: 'rec-id',
      rowCount: 1,
      status,
    };
  }

  it('reads bounded backlog and merchant identity, mapping dependency failures', async () => {
    const h = harness();
    h.transaction.$queryRaw
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ currency: 'USD', reportsWithDifference: 2n }]);
    await expect(h.repository.readBacklogMetrics(250)).resolves.toEqual([
      { currency: 'USD', reportsWithDifference: 2 },
    ]);
    h.client.merchant.findUniqueOrThrow.mockResolvedValue({ code: 'merchant-code' });
    await expect(h.repository.merchantCode('merchant')).resolves.toBe('merchant-code');
    h.client.$transaction.mockRejectedValueOnce(new Error('timeout'));
    await expect(h.repository.readBacklogMetrics(250)).rejects.toThrow('timeout');
  });

  it('stages parsed rows once and replays only matching checksums', async () => {
    const h = harness();
    h.transaction.reconciliationImport.findUnique.mockResolvedValue(null);
    h.transaction.$queryRaw.mockResolvedValue([{ now }]);
    h.transaction.reconciliationImport.create.mockResolvedValue(persisted());
    const input = {
      actorApiKeyId: 'key',
      byteCount: 100,
      checksum: Buffer.alloc(32, 1),
      importId: 'rec-id',
      merchantId: 'merchant',
      periodEnd,
      periodStart,
      requestId: 'request',
      rows: [provider],
    };
    await expect(h.repository.stage(h.tx, input)).resolves.toMatchObject({
      created: true,
      representation: { id: 'rec-id', rowCount: 1 },
    });
    expect(h.transaction.reconciliationProviderRow.createMany).toHaveBeenCalled();
    h.transaction.reconciliationImport.findUnique.mockResolvedValue(persisted());
    await expect(h.repository.stage(h.tx, input)).resolves.toMatchObject({ created: false });
    h.transaction.reconciliationImport.findUnique.mockResolvedValue({
      ...persisted(),
      rowCount: 2,
    });
    await expect(h.repository.stage(h.tx, input)).rejects.toBeInstanceOf(
      ReconciliationChecksumConflictError,
    );
  });

  it('persists validation failures without parsed provider rows', async () => {
    const h = harness();
    h.transaction.reconciliationImport.findUnique.mockResolvedValue(null);
    h.transaction.$queryRaw.mockResolvedValue([{ now }]);
    h.transaction.reconciliationImport.create.mockResolvedValue({
      ...persisted('FAILED'),
      rowCount: 0,
    });
    const input = {
      actorApiKeyId: 'key',
      byteCount: 100,
      checksum: Buffer.alloc(32, 2),
      failureCode: 'csv_invalid' as const,
      importId: 'rec-id',
      merchantId: 'merchant',
      periodEnd,
      periodStart,
      requestId: 'request',
    };
    await expect(h.repository.stageFailed(h.tx, input)).resolves.toMatchObject({
      created: true,
      representation: { rowCount: 0, status: 'FAILED' },
    });
    expect(h.transaction.reconciliationProviderRow.createMany).not.toHaveBeenCalled();
    h.transaction.reconciliationImport.findUnique.mockResolvedValue({
      ...persisted('FAILED'),
      rowCount: 0,
    });
    await expect(h.repository.stageFailed(h.tx, input)).resolves.toMatchObject({ created: false });
    h.transaction.reconciliationImport.findUnique.mockResolvedValue({
      ...persisted('FAILED'),
      periodEnd: new Date(0),
      rowCount: 0,
    });
    await expect(h.repository.stageFailed(h.tx, input)).rejects.toBeInstanceOf(
      ReconciliationChecksumConflictError,
    );
  });

  it('claims one staged import, classifies it durably, and emits completion after writes', async () => {
    const h = harness();
    h.transaction.$queryRaw
      .mockResolvedValueOnce([{ id: 'internal' }])
      .mockResolvedValueOnce([{ now }]);
    h.transaction.reconciliationImport.findFirst.mockResolvedValue({
      merchantId: 'merchant',
      periodEnd,
      periodStart,
      providerRows: [
        {
          currency: 'ETB',
          eventType: 'SETTLEMENT',
          externalRef: 'batch',
          feeMinor: 20n,
          grossMinor: 1_000n,
          id: 'provider-row',
          merchantCode: 'merchant-code',
          netMinor: 980n,
          occurredAt: now,
          providerRef: 'provider-ref',
          providerTransactionId: 'provider-transaction',
          rowNumber: 1,
          status: 'SUCCEEDED',
        },
      ],
      publicId: 'rec-id',
      requestId: 'request',
    });
    const platformReader = {
      readPlatformRecords: jest.fn().mockResolvedValue([
        {
          currency: 'ETB',
          eventType: 'settlement',
          externalRef: 'batch',
          feeMinor: 20n,
          grossMinor: 1_000n,
          netMinor: 980n,
          providerRef: 'provider-ref',
          publicRef: 'stb-id',
          recordType: 'settlement',
        },
      ]),
    };
    const eventFactory = jest.fn().mockResolvedValue(undefined);
    await expect(
      h.repository.claimAndProcess('worker', platformReader, eventFactory),
    ).resolves.toBe(true);
    expect(h.transaction.reconciliationResult.createMany).toHaveBeenCalled();
    expect(h.transaction.reconciliationSummary.createMany).toHaveBeenCalled();
    expect(eventFactory).toHaveBeenCalledWith(
      h.transaction,
      expect.objectContaining({ importId: 'rec-id', matchedExactCount: 1, mismatchCount: 0 }),
    );
  });

  it('returns false without a claim and fails oversized aggregates without completion events', async () => {
    const empty = harness();
    empty.transaction.$queryRaw.mockResolvedValue([]);
    await expect(
      empty.repository.claimAndProcess('worker', { readPlatformRecords: jest.fn() }, jest.fn()),
    ).resolves.toBe(false);

    const overflow = harness();
    const excessive = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    overflow.transaction.$queryRaw
      .mockResolvedValueOnce([{ id: 'internal' }])
      .mockResolvedValueOnce([{ now }]);
    overflow.transaction.reconciliationImport.findFirst.mockResolvedValue({
      merchantId: 'merchant',
      periodEnd,
      periodStart,
      providerRows: [
        {
          currency: 'ETB',
          eventType: 'SETTLEMENT',
          externalRef: null,
          feeMinor: 0n,
          grossMinor: excessive,
          id: 'provider-row',
          merchantCode: 'merchant-code',
          netMinor: excessive,
          occurredAt: now,
          providerRef: 'provider-ref',
          providerTransactionId: 'provider-transaction',
          rowNumber: 1,
          status: 'SUCCEEDED',
        },
      ],
      publicId: 'rec-id',
      requestId: 'request',
    });
    const eventFactory = jest.fn();
    await expect(
      overflow.repository.claimAndProcess(
        'worker',
        { readPlatformRecords: jest.fn().mockResolvedValue([]) },
        eventFactory,
      ),
    ).resolves.toBe(true);
    const updateCalls = overflow.transaction.reconciliationImport.update.mock
      .calls as readonly (readonly unknown[])[];
    const updateInput = updateCalls.at(-1)?.[0] as {
      readonly data?: { readonly failureCode?: unknown; readonly status?: unknown };
    };
    expect(updateInput.data).toMatchObject({ failureCode: 'aggregate_overflow', status: 'FAILED' });
    expect(eventFactory).not.toHaveBeenCalled();
  });

  it('returns mismatch pages and rejects invalid, missing, pending, and failed reports', async () => {
    const h = harness();
    const summary = {
      amountMismatchCount: 1,
      currency: 'ETB',
      currencyMismatchCount: 0,
      duplicateProviderRowCount: 0,
      matchedExactCount: 1,
      platformOnlyCount: 0,
      providerOnlyCount: 0,
      statusMismatchCount: 0,
      unexplainedDifferenceMinor: 10n,
    };
    const mismatch = {
      bucket: 'AMOUNT_MISMATCH',
      platformPublicRef: 'stb-id',
      reasonCode: 'amounts_differ',
      sortOrdinal: 1,
    };
    h.client.reconciliationImport.findFirst.mockResolvedValue({
      publicId: 'rec-id',
      results: [mismatch, { ...mismatch, sortOrdinal: 2 }],
      status: 'COMPLETED',
      summaries: [summary],
    });
    const first = await h.repository.getReport('merchant', 'rec-id', 1);
    expect(first.mismatches).toEqual([
      expect.objectContaining({ bucket: 'amount_mismatch', platformPublicRef: 'stb-id' }),
    ]);
    expect(typeof first.nextCursor).toBe('string');
    await expect(
      h.repository.getReport('merchant', 'rec-id', 1, first.nextCursor),
    ).resolves.toMatchObject({ status: 'COMPLETED' });
    await expect(h.repository.getReport('merchant', 'rec-id', 1, 'invalid')).rejects.toBeInstanceOf(
      InvalidReconciliationRequestError,
    );
    h.client.reconciliationImport.findFirst.mockResolvedValue(null);
    await expect(h.repository.getReport('merchant', 'missing', 20)).rejects.toBeInstanceOf(
      ReconciliationImportNotFoundError,
    );
    h.client.reconciliationImport.findFirst.mockResolvedValue({
      publicId: 'rec',
      results: [],
      status: 'STAGED',
      summaries: [],
    });
    await expect(h.repository.getReport('merchant', 'rec', 20)).rejects.toBeInstanceOf(
      ReconciliationReportNotReadyError,
    );
    h.client.reconciliationImport.findFirst.mockResolvedValue({
      publicId: 'rec',
      results: [],
      status: 'FAILED',
      summaries: [],
    });
    await expect(h.repository.getReport('merchant', 'rec', 20)).rejects.toBeInstanceOf(
      ReconciliationImportFailedError,
    );
  });
});
