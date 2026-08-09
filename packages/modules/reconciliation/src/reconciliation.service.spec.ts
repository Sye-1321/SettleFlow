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
});
