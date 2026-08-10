import {
  IdempotencyService,
  type IdempotentOperation,
  type IdempotencyOwnership,
} from '@settleflow/idempotency';
import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';
import { AuditService } from '@settleflow/operations';

import { PrismaReconciliationRepository } from './prisma-reconciliation.repository';
import { ReconciliationService } from './reconciliation.service';
import type { StageReconciliationCommand } from './reconciliation.types';
import {
  InvalidReconciliationRequestError,
  ReconciliationIdentifierExhaustedError,
} from './reconciliation.errors';

describe('ReconciliationService', () => {
  const periodStart = new Date('2026-08-03T00:00:00.000Z');
  const periodEnd = new Date('2026-08-04T00:00:00.000Z');
  const importId = 'rec_01ARZ3NDEKTSV4RRFFQ69G5FAV';

  function csv(merchantCode: string, occurredAt: Date): Buffer {
    return Buffer.from(
      [
        'provider_txn_id,merchant_code,provider_ref,external_ref,event_type,currency,gross_minor,fee_minor,net_minor,status,occurred_at',
        `mock_settlement_1,${merchantCode},ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV,stb_01ARZ3NDEKTSV4RRFFQ69G5FAV,settlement,ETB,120000,3000,117000,succeeded,${occurredAt.toISOString()}`,
        '',
      ].join('\n'),
    );
  }

  function createHarness(): {
    readonly appendOperational: jest.Mock;
    readonly service: ReconciliationService;
    readonly stage: jest.Mock;
    readonly stageFailed: jest.Mock;
    readonly transaction: PrismaTransactionClient;
  } {
    const transaction = {} as PrismaTransactionClient;
    const stage = jest.fn();
    const stageFailed = jest.fn().mockResolvedValue({
      created: true,
      representation: {
        createdAt: '2026-08-03T10:00:00.000Z',
        id: importId,
        periodEnd: periodEnd.toISOString(),
        periodStart: periodStart.toISOString(),
        rowCount: 0,
        status: 'FAILED',
      },
    });
    const repository = {
      merchantCode: jest.fn().mockResolvedValue('settlement_test'),
      stage,
      stageFailed,
    } as unknown as jest.Mocked<PrismaReconciliationRepository>;
    const idempotency = {
      acquire: jest.fn().mockResolvedValue({
        kind: 'acquired',
        ownership: { ownerToken: 'owner', recordId: 'record' },
      }),
      complete: jest
        .fn()
        .mockImplementation(
          async <T>(_ownership: IdempotencyOwnership, operation: IdempotentOperation<T>) =>
            (await operation(transaction)).value,
        ),
    } as unknown as jest.Mocked<IdempotencyService>;
    const appendOperational = jest.fn().mockResolvedValue(undefined);
    const audit = { appendOperational } as unknown as jest.Mocked<AuditService>;
    const identifiers = {
      generate: jest.fn().mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    } as unknown as jest.Mocked<MonotonicUlidGenerator>;

    return {
      appendOperational,
      service: new ReconciliationService(
        repository,
        idempotency,
        audit,
        identifiers,
        () => new Date('2026-08-03T10:00:00.000Z'),
      ),
      stage,
      stageFailed,
      transaction,
    };
  }

  it.each([
    ['outside the reconciliation interval', 'settlement_test', periodEnd],
    ['owned by another merchant', 'another_merchant', new Date('2026-08-03T10:00:00.000Z')],
  ])('uses failed staging for a parsed row %s', async (_case, merchantCode, occurredAt) => {
    const harness = createHarness();
    const command: StageReconciliationCommand = {
      actorApiKeyId: '00000000-0000-4000-8000-000000000202',
      bytes: csv(merchantCode, occurredAt),
      idempotencyKey: `invalid-${merchantCode}`,
      merchantId: '00000000-0000-4000-8000-000000000201',
      periodEnd,
      periodStart,
      requestId: 'req_reconciliation_invalid_row',
    };

    await expect(harness.service.stage(command)).resolves.toMatchObject({
      id: importId,
      rowCount: 0,
      status: 'FAILED',
    });
    expect(harness.stage).not.toHaveBeenCalled();
    expect(harness.stageFailed).toHaveBeenCalledWith(
      harness.transaction,
      expect.objectContaining({ failureCode: 'csv_invalid' }),
    );
    expect(harness.appendOperational).toHaveBeenCalledWith(
      harness.transaction,
      expect.objectContaining({ details: { outcome: 'failed', rowCount: 0 } }),
    );
  });

  it('stages a valid import, audits it atomically, and returns a replay without staging', async () => {
    const harness = createHarness();
    harness.stage.mockResolvedValue({
      created: true,
      representation: {
        createdAt: '2026-08-03T10:00:00.000Z',
        id: importId,
        periodEnd: periodEnd.toISOString(),
        periodStart: periodStart.toISOString(),
        rowCount: 1,
        status: 'STAGED',
      },
    });
    const command: StageReconciliationCommand = {
      actorApiKeyId: '00000000-0000-4000-8000-000000000202',
      bytes: csv('settlement_test', new Date('2026-08-03T10:00:00.000Z')),
      idempotencyKey: 'valid-import',
      merchantId: '00000000-0000-4000-8000-000000000201',
      periodEnd,
      periodStart,
      requestId: 'req_reconciliation_valid',
    };

    await expect(harness.service.stage(command)).resolves.toMatchObject({
      rowCount: 1,
      status: 'STAGED',
    });
    expect(harness.stage).toHaveBeenCalledWith(
      harness.transaction,
      expect.objectContaining({
        rows: [expect.objectContaining({ merchantCode: 'settlement_test' })],
      }),
    );
    expect(harness.appendOperational).toHaveBeenCalledWith(
      harness.transaction,
      expect.objectContaining({ details: { outcome: 'staged', rowCount: 1 } }),
    );

    const replayHarness = createHarness();
    const replay = { id: importId, rowCount: 1, status: 'STAGED' };
    const idempotency = (
      replayHarness.service as unknown as {
        idempotency: { acquire: jest.Mock };
      }
    ).idempotency;
    idempotency.acquire.mockResolvedValue({
      kind: 'replay',
      response: { body: replay },
    });
    await expect(replayHarness.service.stage(command)).resolves.toBe(replay);
    expect(replayHarness.stage).not.toHaveBeenCalled();
  });

  it.each([
    [new Date(Number.NaN), periodEnd],
    [periodStart, new Date(Number.NaN)],
    [periodEnd, periodStart],
    [periodStart, new Date('2026-09-04T00:00:00.001Z')],
  ])('rejects invalid reconciliation interval %#', async (start, end) => {
    const harness = createHarness();
    await expect(
      harness.service.stage({
        actorApiKeyId: '00000000-0000-4000-8000-000000000202',
        bytes: Buffer.from('unused'),
        idempotencyKey: 'invalid-window',
        merchantId: '00000000-0000-4000-8000-000000000201',
        periodEnd: end,
        periodStart: start,
        requestId: 'req_invalid_window',
      }),
    ).rejects.toBeInstanceOf(InvalidReconciliationRequestError);
  });

  it('retries public-ID conflicts three times, then fails closed', async () => {
    const harness = createHarness();
    harness.stage.mockRejectedValue(new Error('unique constraint'));
    await expect(
      harness.service.stage({
        actorApiKeyId: '00000000-0000-4000-8000-000000000202',
        bytes: csv('settlement_test', new Date('2026-08-03T10:00:00.000Z')),
        idempotencyKey: 'collision',
        merchantId: '00000000-0000-4000-8000-000000000201',
        periodEnd,
        periodStart,
        requestId: 'req_collision',
      }),
    ).rejects.toBeInstanceOf(ReconciliationIdentifierExhaustedError);
    expect(harness.stage).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['rec_invalid', 20, undefined],
    [importId, 0, undefined],
    [importId, 101, undefined],
    [importId, 20, 'bad cursor!'],
  ] as const)('rejects invalid report request %#', (id, limit, cursor) => {
    const harness = createHarness();
    expect(() =>
      harness.service.getReport('00000000-0000-4000-8000-000000000201', id, limit, cursor),
    ).toThrow(InvalidReconciliationRequestError);
  });
});
