import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { EventingService, PrismaOutboxRepository } from '@settleflow/eventing';
import { IdempotencyService, PrismaIdempotencyRepository } from '@settleflow/idempotency';
import { MonotonicUlidGenerator, PrismaDatabase } from '@settleflow/infrastructure';
import {
  LedgerService,
  PrismaLedgerReconciliationReader,
  PrismaLedgerRepository,
} from '@settleflow/ledger';
import { AuditService, PrismaAuditRepository } from '@settleflow/operations';
import {
  PrismaPaymentReconciliationReader,
  PrismaPaymentSettlementReader,
} from '@settleflow/payments';
import {
  PrismaReconciliationRepository,
  ReconciliationProcessor,
  ReconciliationService,
} from '@settleflow/reconciliation';
import {
  PrismaSettlementReconciliationReader,
  PrismaSettlementRepository,
  SettlementBatchNotFoundError,
  SettlementProjectionService,
  SettlementService,
} from '@settleflow/settlements';

import { provisionTestRuntimeRole, testRuntimeDatabaseUrl } from './support/postgres-runtime-role';
import { ReconciliationPlatformReadAdapter } from '../../apps/worker/src/runtime/reconciliation-platform-read.adapter';

const POSTGRES_IMAGE =
  'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
jest.setTimeout(120_000);

function deploy(databaseUrl: string): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      process.execPath,
      [
        resolve('node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        resolve('prisma.config.mts'),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl },
        timeout: 120_000,
        windowsHide: true,
      },
      (error, _stdout, stderr) =>
        error === null ? resolveCommand() : rejectCommand(new Error(stderr, { cause: error })),
    );
  });
}

function utcDayInterval(instant: Date): { readonly end: Date; readonly start: Date } {
  const start = new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
  return { end: new Date(start.getTime() + 86_400_000), start };
}

describe('settlement financial transaction with real PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer;
  let owner: PrismaDatabase;
  let runtime: PrismaDatabase;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('settleflow_settlement_test')
      .withUsername('settleflow_settlement_test')
      .withPassword('settleflow_settlement_test_only')
      .start();
    await provisionTestRuntimeRole(postgres);
    await deploy(postgres.getConnectionUri());
    owner = new PrismaDatabase({
      connectionTimeoutMs: 15_000,
      databaseUrl: postgres.getConnectionUri(),
      maxConnections: 5,
    });
    runtime = new PrismaDatabase({
      connectionTimeoutMs: 15_000,
      databaseUrl: testRuntimeDatabaseUrl(postgres),
      maxConnections: 5,
    });
  });

  afterAll(async () => {
    await runtime?.close();
    await owner?.close();
    await postgres?.stop();
  });

  it('commits batch, fee snapshots, balanced settlement ledger, audit, outbox, and idempotency atomically', async () => {
    const merchantId = '00000000-0000-4000-8000-000000000201';
    const apiKeyId = '00000000-0000-4000-8000-000000000202';
    const paymentId = '00000000-0000-4000-8000-000000000203';
    await owner.getClient().merchant.create({ data: { code: 'settlement_test', id: merchantId } });
    await owner.getClient().apiKey.create({
      data: {
        id: apiKeyId,
        merchantId,
        prefix: 'sf_test_ABCDEFGHIJKL',
        scopes: [
          'settlements:write',
          'settlements:read',
          'reconciliation:write',
          'reconciliation:read',
        ],
        secretHash: `scrypt:v1:16384:8:1:${'A'.repeat(22)}:${'B'.repeat(43)}`,
      },
    });
    await owner.getClient().settlementStream.createMany({
      data: [
        { currency: 'ETB', merchantId },
        { currency: 'USD', merchantId },
      ],
    });
    const ledger = new LedgerService(
      new PrismaLedgerRepository(runtime),
      new MonotonicUlidGenerator(),
    );
    await runtime
      .getClient()
      .$transaction((transaction) => ledger.provisionAccounts(transaction, merchantId));
    await owner.getClient().paymentIntent.create({
      data: {
        amountMinor: 120_000n,
        availableAt: new Date('2026-08-01T10:00:00.000Z'),
        captureMethod: 'MANUAL',
        capturedAmountMinor: 120_000n,
        capturedAt: new Date('2026-08-01T10:00:00.000Z'),
        currency: 'ETB',
        externalRef: 'settlement-order-1',
        id: paymentId,
        merchantId,
        paymentStatus: 'CAPTURED',
        publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
    });
    await owner.getClient().settlementPosition.create({
      data: {
        availableAt: new Date('2026-08-01T10:00:00.000Z'),
        capturedAmountMinor: 120_000n,
        capturedAt: new Date('2026-08-01T10:00:00.000Z'),
        currency: 'ETB',
        lastEventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        lastEventOccurredAt: new Date('2026-08-01T10:00:00.000Z'),
        merchantId,
        paymentIntentId: paymentId,
        paymentPublicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        refundedAmountMinor: 0n,
      },
    });
    const idempotency = new IdempotencyService(
      new PrismaIdempotencyRepository(runtime, {
        leaseDurationMs: 30_000,
        lockTimeoutMs: 5_000,
        replayDurationMs: 86_400_000,
        statementTimeoutMs: 10_000,
      }),
    );
    const eventing = new EventingService(
      new PrismaOutboxRepository(),
      new MonotonicUlidGenerator(),
    );
    const service = new SettlementService(
      new PrismaSettlementRepository(runtime),
      idempotency,
      ledger,
      eventing,
      new AuditService(new PrismaAuditRepository()),
      new MonotonicUlidGenerator(),
      new PrismaPaymentSettlementReader(),
      () => new Date('2026-08-03T10:00:00.000Z'),
    );
    const result = await service.run({
      actorApiKeyId: apiKeyId,
      currency: 'ETB',
      cutoffDate: '2026-08-01',
      idempotencyKey: 'settlement-key-1',
      merchantId,
      requestId: 'req_settlement_integration',
    });
    expect(result).toMatchObject({ currency: 'ETB', status: 'COMPLETED' });
    const batch = await owner.getClient().settlementBatch.findUniqueOrThrow({
      include: { items: true, ledgerTransaction: { include: { entries: true } } },
      where: { publicId: result.batchId! },
    });
    expect(batch).toMatchObject({
      feeMinor: 3_000n,
      grossMinor: 120_000n,
      netMinor: 117_000n,
      status: 'SETTLED',
    });
    expect(batch.items[0]).toMatchObject({
      basisPoints: 200,
      feePolicyVersion: 'settlement_fee_v1',
      flatFeeMinor: 600n,
    });
    expect(
      batch.ledgerTransaction.entries.reduce(
        (sum, entry) => sum + (entry.side === 'DEBIT' ? entry.amountMinor : -entry.amountMinor),
        0n,
      ),
    ).toBe(0n);
    expect(
      await owner.getClient().outboxEvent.count({
        where: { aggregateId: batch.publicId, eventType: 'settlement.finalized.v1' },
      }),
    ).toBe(1);
    expect(
      await owner
        .getClient()
        .auditEvent.count({ where: { action: 'settlement.run_executed', targetId: result.id } }),
    ).toBe(1);
    expect(
      await service.run({
        actorApiKeyId: apiKeyId,
        currency: 'ETB',
        cutoffDate: '2026-08-01',
        idempotencyKey: 'settlement-key-1',
        merchantId,
        requestId: 'req_settlement_integration',
      }),
    ).toEqual(result);
    await expect(
      service.getBatch('00000000-0000-4000-8000-000000000299', batch.publicId),
    ).rejects.toBeInstanceOf(SettlementBatchNotFoundError);
    await expect(
      runtime.getClient().settlementBatch.delete({ where: { id: batch.id } }),
    ).rejects.toBeDefined();
    await expect(
      owner.getClient().settlementBatch.update({
        data: { grossMinor: { increment: 1 } },
        where: { id: batch.id },
      }),
    ).rejects.toBeDefined();
    await expect(
      owner.getClient().settlementBatch.update({
        data: { ledgerTransactionPublicId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FZZ' },
        where: { id: batch.id },
      }),
    ).rejects.toBeDefined();

    const reconciliationRepository = new PrismaReconciliationRepository(runtime);
    const reconciliation = new ReconciliationService(
      reconciliationRepository,
      idempotency,
      new AuditService(new PrismaAuditRepository()),
      new MonotonicUlidGenerator(),
    );
    const reconciliationPeriod = utcDayInterval(batch.settledAt!);
    const csv = Buffer.from(
      [
        'provider_txn_id,merchant_code,provider_ref,external_ref,event_type,currency,gross_minor,fee_minor,net_minor,status,occurred_at',
        `mock_settlement_1,settlement_test,${batch.ledgerTransaction.publicId},${batch.publicId},settlement,ETB,120000,3000,117000,succeeded,${batch.settledAt!.toISOString()}`,
        '',
      ].join('\n'),
    );
    const staged = await reconciliation.stage({
      actorApiKeyId: apiKeyId,
      bytes: csv,
      idempotencyKey: 'reconciliation-key-1',
      merchantId,
      periodEnd: reconciliationPeriod.end,
      periodStart: reconciliationPeriod.start,
      requestId: 'req_reconciliation_integration',
    });
    expect(staged.status).toBe('STAGED');
    const reconciliationProcessor = new ReconciliationProcessor(
      reconciliationRepository,
      eventing,
      new ReconciliationPlatformReadAdapter(
        new PrismaPaymentReconciliationReader(),
        new PrismaSettlementReconciliationReader(),
        new PrismaLedgerReconciliationReader(),
      ),
    );
    expect(await reconciliationProcessor.processNext('reconciliation_test_worker')).toBe(true);
    const report = await reconciliation.getReport(merchantId, staged.id);
    expect(report.mismatches).toEqual([]);
    expect(report.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currency: 'ETB',
          matchedExactCount: 1,
          unexplainedDifferenceMinor: 0,
        }),
        expect.objectContaining({
          currency: 'USD',
          matchedExactCount: 0,
          unexplainedDifferenceMinor: 0,
        }),
      ]),
    );
    expect(
      await owner.getClient().outboxEvent.count({
        where: { aggregateId: staged.id, eventType: 'reconciliation.completed.v1' },
      }),
    ).toBe(1);

    const failed = await reconciliation.stage({
      actorApiKeyId: apiKeyId,
      bytes: Buffer.from('wrong_header\nwrong_value\n'),
      idempotencyKey: 'reconciliation-key-invalid',
      merchantId,
      periodEnd: reconciliationPeriod.end,
      periodStart: reconciliationPeriod.start,
      requestId: 'req_reconciliation_invalid',
    });
    expect(failed.status).toBe('FAILED');
    expect(
      await owner.getClient().reconciliationProviderRow.count({
        where: { reconciliationImport: { publicId: failed.id } },
      }),
    ).toBe(0);

    const invalidParsedRows = [
      {
        idempotencyKey: 'reconciliation-key-out-of-window',
        merchantCode: 'settlement_test',
        occurredAt: reconciliationPeriod.end,
        providerTransactionId: 'mock_settlement_out_of_window',
        requestId: 'req_reconciliation_out_of_window',
      },
      {
        idempotencyKey: 'reconciliation-key-wrong-merchant',
        merchantCode: 'another_merchant',
        occurredAt: batch.settledAt!,
        providerTransactionId: 'mock_settlement_wrong_merchant',
        requestId: 'req_reconciliation_wrong_merchant',
      },
    ] as const;
    for (const invalidRow of invalidParsedRows) {
      const invalidCsv = Buffer.from(
        [
          'provider_txn_id,merchant_code,provider_ref,external_ref,event_type,currency,gross_minor,fee_minor,net_minor,status,occurred_at',
          `${invalidRow.providerTransactionId},${invalidRow.merchantCode},${batch.ledgerTransaction.publicId},${batch.publicId},settlement,ETB,120000,3000,117000,succeeded,${invalidRow.occurredAt.toISOString()}`,
          '',
        ].join('\n'),
      );
      const rejected = await reconciliation.stage({
        actorApiKeyId: apiKeyId,
        bytes: invalidCsv,
        idempotencyKey: invalidRow.idempotencyKey,
        merchantId,
        periodEnd: reconciliationPeriod.end,
        periodStart: reconciliationPeriod.start,
        requestId: invalidRow.requestId,
      });
      expect(rejected.status).toBe('FAILED');
      expect(
        await owner.getClient().reconciliationProviderRow.count({
          where: { reconciliationImport: { publicId: rejected.id } },
        }),
      ).toBe(0);
      expect(await reconciliationProcessor.processNext('reconciliation_test_worker')).toBe(false);
      expect(
        await owner.getClient().outboxEvent.count({
          where: {
            aggregateId: rejected.id,
            eventType: 'reconciliation.completed.v1',
          },
        }),
      ).toBe(0);
    }

    const projectionRepository = new PrismaSettlementRepository(runtime);
    const projection = new SettlementProjectionService(
      projectionRepository,
      new MonotonicUlidGenerator(),
      new PrismaPaymentSettlementReader(),
    );
    await owner.getClient().$transaction(async (transaction) => {
      await transaction.paymentIntent.update({
        data: {
          paymentStatus: 'PARTIALLY_REFUNDED',
          refundedAmountMinor: 20_000n,
          version: { increment: 1 },
        },
        where: { id: paymentId },
      });
      await transaction.refund.create({
        data: {
          amountMinor: 20_000n,
          createdAt: new Date('2026-08-03T11:00:00.000Z'),
          currency: 'ETB',
          externalRef: 'post-settlement-refund-1',
          merchantId,
          paymentIntentId: paymentId,
          publicId: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        },
      });
    });
    await runtime.getClient().$transaction((transaction) =>
      projection.process(transaction, {
        amountMinor: 20_000,
        cumulativeRefundedAmountMinor: 20_000,
        currency: 'ETB',
        eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW',
        eventType: 'payment.refunded.v1',
        merchantId,
        occurredAt: new Date('2026-08-03T11:00:00.000Z'),
        paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        refundId: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    );
    expect(await service.getPaymentStatus(merchantId, 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      'ADJUSTMENT_PENDING',
    );

    const secondPaymentId = '00000000-0000-4000-8000-000000000204';
    await owner.getClient().paymentIntent.create({
      data: {
        amountMinor: 50_000n,
        availableAt: new Date('2026-08-02T10:00:00.000Z'),
        captureMethod: 'MANUAL',
        capturedAmountMinor: 50_000n,
        capturedAt: new Date('2026-08-02T10:00:00.000Z'),
        currency: 'ETB',
        externalRef: 'settlement-order-2',
        id: secondPaymentId,
        merchantId,
        paymentStatus: 'CAPTURED',
        publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      },
    });
    await runtime.getClient().$transaction((transaction) =>
      projection.process(transaction, {
        amountMinor: 50_000,
        availableOn: new Date('2026-08-02T10:00:00.000Z'),
        currency: 'ETB',
        eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAX',
        eventType: 'payment.captured.v1',
        merchantId,
        occurredAt: new Date('2026-08-02T10:00:00.000Z'),
        paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      }),
    );
    const adjustedRun = await service.run({
      actorApiKeyId: apiKeyId,
      currency: 'ETB',
      cutoffDate: '2026-08-02',
      idempotencyKey: 'settlement-key-2',
      merchantId,
      requestId: 'req_settlement_adjustment',
    });
    const adjustedBatch = await owner
      .getClient()
      .settlementBatch.findUniqueOrThrow({ where: { publicId: adjustedRun.batchId! } });
    expect(adjustedBatch).toMatchObject({
      adjustmentCount: 1,
      adjustmentMinor: 20_000n,
      feeMinor: 1_600n,
      grossMinor: 30_000n,
      netMinor: 28_400n,
      paymentGrossMinor: 50_000n,
    });
    expect(
      await owner
        .getClient()
        .settlementAdjustment.count({ where: { batchId: adjustedBatch.id, status: 'SETTLED' } }),
    ).toBe(1);
    expect(await service.getPaymentStatus(merchantId, 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      'SETTLED',
    );

    const racingPayments = [
      {
        id: '00000000-0000-4000-8000-000000000205',
        publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAY',
      },
      {
        id: '00000000-0000-4000-8000-000000000206',
        publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      },
    ] as const;
    for (const [index, racingPayment] of racingPayments.entries()) {
      const occurredAt = new Date(`2026-08-02T1${index}:00:00.000Z`);
      await owner.getClient().paymentIntent.create({
        data: {
          amountMinor: 10_000n,
          availableAt: occurredAt,
          captureMethod: 'MANUAL',
          capturedAmountMinor: 10_000n,
          capturedAt: occurredAt,
          currency: 'ETB',
          externalRef: `settlement-race-${index}`,
          id: racingPayment.id,
          merchantId,
          paymentStatus: 'CAPTURED',
          publicId: racingPayment.publicId,
        },
      });
      await runtime.getClient().$transaction((transaction) =>
        projection.process(transaction, {
          amountMinor: 10_000,
          availableOn: occurredAt,
          currency: 'ETB',
          eventId: `evt_01ARZ3NDEKTSV4RRFFQ69G5F${index === 0 ? 'B0' : 'B1'}`,
          eventType: 'payment.captured.v1',
          merchantId,
          occurredAt,
          paymentId: racingPayment.publicId,
        }),
      );
    }
    const competing = await Promise.all([
      service.run({
        actorApiKeyId: apiKeyId,
        currency: 'ETB',
        cutoffDate: '2026-08-02',
        idempotencyKey: 'settlement-race-a',
        merchantId,
        requestId: 'req_settlement_race_a',
      }),
      service.run({
        actorApiKeyId: apiKeyId,
        currency: 'ETB',
        cutoffDate: '2026-08-02',
        idempotencyKey: 'settlement-race-b',
        merchantId,
        requestId: 'req_settlement_race_b',
      }),
    ]);
    expect(competing.map((run) => run.status).sort()).toEqual(['COMPLETED', 'NO_ELIGIBLE_ITEMS']);
    expect(
      await owner.getClient().settlementBatchItem.count({
        where: { paymentIntentId: { in: racingPayments.map((payment) => payment.id) } },
      }),
    ).toBe(2);

    const bulkIdentifiers = new MonotonicUlidGenerator();
    const bulkPayments = Array.from({ length: 501 }, (_, index) => {
      const publicId = `pi_${bulkIdentifiers.generate(Date.UTC(2026, 7, 2, 12, 0, 0) + index)}`;
      return {
        externalRef: `settlement-bulk-${index}`,
        id: randomUUID(),
        publicId,
      };
    });
    await owner.getClient().paymentIntent.createMany({
      data: bulkPayments.map((payment) => ({
        amountMinor: 100_000n,
        availableAt: new Date('2026-08-02T12:00:00.000Z'),
        captureMethod: 'MANUAL',
        capturedAmountMinor: 100_000n,
        capturedAt: new Date('2026-08-02T12:00:00.000Z'),
        currency: 'ETB',
        externalRef: payment.externalRef,
        id: payment.id,
        merchantId,
        paymentStatus: 'CAPTURED',
        publicId: payment.publicId,
      })),
    });
    await owner.getClient().settlementPosition.createMany({
      data: bulkPayments.map((payment, index) => ({
        availableAt: new Date('2026-08-02T12:00:00.000Z'),
        capturedAmountMinor: 100_000n,
        capturedAt: new Date('2026-08-02T12:00:00.000Z'),
        currency: 'ETB',
        lastEventId: `evt_${bulkIdentifiers.generate(Date.UTC(2026, 7, 2, 12, 10, 0) + index)}`,
        lastEventOccurredAt: new Date('2026-08-02T12:00:00.000Z'),
        merchantId,
        paymentIntentId: payment.id,
        paymentPublicId: payment.publicId,
        refundedAmountMinor: 0n,
      })),
    });
    const firstBulkRun = await service.run({
      actorApiKeyId: apiKeyId,
      currency: 'ETB',
      cutoffDate: '2026-08-02',
      idempotencyKey: 'settlement-bulk-1',
      merchantId,
      requestId: 'req_settlement_bulk_1',
    });
    expect(firstBulkRun).toMatchObject({ moreEligible: true, status: 'COMPLETED' });
    expect(
      await owner.getClient().settlementBatch.findUniqueOrThrow({
        select: { itemCount: true },
        where: { publicId: firstBulkRun.batchId! },
      }),
    ).toEqual({ itemCount: 500 });

    const secondBulkRun = await service.run({
      actorApiKeyId: apiKeyId,
      currency: 'ETB',
      cutoffDate: '2026-08-02',
      idempotencyKey: 'settlement-bulk-2',
      merchantId,
      requestId: 'req_settlement_bulk_2',
    });
    expect(secondBulkRun).toMatchObject({ moreEligible: false, status: 'COMPLETED' });
    expect(
      await owner.getClient().settlementBatch.findUniqueOrThrow({
        select: { itemCount: true },
        where: { publicId: secondBulkRun.batchId! },
      }),
    ).toEqual({ itemCount: 1 });
  });
});
