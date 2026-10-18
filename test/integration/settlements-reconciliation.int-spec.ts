import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  EventingService,
  InboxService,
  PrismaInboxRepository,
  PrismaOutboxRepository,
  type ValidatedPaymentEventMessage,
} from '@settleflow/eventing';
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

  it('keeps settlement refund projections correct across out-of-order and duplicate delivery', async () => {
    const merchantId = '00000000-0000-4000-8000-000000000211';
    const paymentId = '00000000-0000-4000-8000-000000000212';
    const paymentPublicId = 'pi_01ARZ3NDEKTSV4RRFFQ69G5FB0';
    const availableOn = new Date('2026-08-04T10:00:00.000Z');
    await owner.getClient().merchant.create({ data: { code: 'projection_order', id: merchantId } });
    await owner.getClient().paymentIntent.create({
      data: {
        amountMinor: 10_000n,
        availableAt: availableOn,
        captureMethod: 'MANUAL',
        capturedAmountMinor: 10_000n,
        capturedAt: availableOn,
        currency: 'ETB',
        externalRef: 'projection-order-payment',
        id: paymentId,
        merchantId,
        paymentStatus: 'PARTIALLY_REFUNDED',
        publicId: paymentPublicId,
        refundedAmountMinor: 3_000n,
      },
    });
    const refunds = [
      {
        amountMinor: 1_000n,
        createdAt: new Date('2026-08-04T11:00:00.000Z'),
        externalRef: 'projection-order-refund-1',
        publicId: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FB0',
      },
      {
        amountMinor: 2_000n,
        createdAt: new Date('2026-08-04T12:00:00.000Z'),
        externalRef: 'projection-order-refund-2',
        publicId: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FB1',
      },
    ] as const;
    await owner.getClient().refund.createMany({
      data: refunds.map((refund) => ({
        ...refund,
        currency: 'ETB',
        merchantId,
        paymentIntentId: paymentId,
      })),
    });
    const inbox = new InboxService(
      new PrismaInboxRepository(runtime, {
        lockTimeoutMs: 5_000,
        statementTimeoutMs: 10_000,
        transactionTimeoutMs: 15_000,
      }),
      { retryAttempts: 3 },
    );
    const projection = new SettlementProjectionService(
      new PrismaSettlementRepository(runtime),
      new MonotonicUlidGenerator(),
      new PrismaPaymentSettlementReader(),
      inbox,
    );
    const message = (
      event: ValidatedPaymentEventMessage['event'],
    ): ValidatedPaymentEventMessage => {
      const payloadBytes = Buffer.from(JSON.stringify(event));
      return {
        event,
        payloadBytes,
        payloadSha256: createHash('sha256').update(payloadBytes).digest(),
        publishAttempt: 1,
        redelivered: false,
        schemaVersion: 1,
      } as ValidatedPaymentEventMessage;
    };
    const olderRefund = message({
      amountMinor: 1_000,
      cumulativeRefundedAmountMinor: 1_000,
      currency: 'ETB',
      eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FB0',
      eventType: 'payment.refunded.v1',
      ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FB0',
      merchantId,
      occurredAt: refunds[0].createdAt,
      paymentId: paymentPublicId,
      refundId: refunds[0].publicId,
      requestId: 'req_projection_order_refund_1',
    });
    const newerRefund = message({
      amountMinor: 2_000,
      cumulativeRefundedAmountMinor: 3_000,
      currency: 'ETB',
      eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FB1',
      eventType: 'payment.refunded.v1',
      ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FB1',
      merchantId,
      occurredAt: refunds[1].createdAt,
      paymentId: paymentPublicId,
      refundId: refunds[1].publicId,
      requestId: 'req_projection_order_refund_2',
    });
    const capture = message({
      availableOn,
      capturedAmountMinor: 10_000,
      currency: 'ETB',
      eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FB2',
      eventType: 'payment.captured.v1',
      ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FB2',
      merchantId,
      occurredAt: availableOn,
      paymentId: paymentPublicId,
      requestId: 'req_projection_order_capture',
    });

    await expect(projection.handle(newerRefund)).resolves.toMatchObject({ kind: 'processed' });
    expect(
      await owner.getClient().settlementPosition.count({ where: { paymentIntentId: paymentId } }),
    ).toBe(0);
    expect(
      await owner.getClient().inboxMessage.count({
        where: { consumerName: 'settlement-projection.payment-refunded.v1' },
      }),
    ).toBe(1);

    await expect(projection.handle(capture)).resolves.toMatchObject({ kind: 'processed' });
    expect(
      await owner.getClient().settlementPosition.findUniqueOrThrow({
        where: { paymentIntentId: paymentId },
      }),
    ).toMatchObject({ capturedAmountMinor: 10_000n, refundedAmountMinor: 3_000n });

    const apiKeyId = '00000000-0000-4000-8000-000000000214';
    await owner.getClient().apiKey.create({
      data: {
        id: apiKeyId,
        merchantId,
        prefix: 'sf_test_PROJECTORDER',
        scopes: ['settlements:write', 'settlements:read'],
        secretHash: `scrypt:v1:16384:8:1:${'C'.repeat(22)}:${'D'.repeat(43)}`,
      },
    });
    const ledger = new LedgerService(
      new PrismaLedgerRepository(runtime),
      new MonotonicUlidGenerator(),
    );
    await runtime
      .getClient()
      .$transaction((transaction) => ledger.provisionAccounts(transaction, merchantId));
    const settlement = new SettlementService(
      new PrismaSettlementRepository(runtime),
      new IdempotencyService(
        new PrismaIdempotencyRepository(runtime, {
          leaseDurationMs: 30_000,
          lockTimeoutMs: 5_000,
          replayDurationMs: 86_400_000,
          statementTimeoutMs: 10_000,
        }),
      ),
      ledger,
      new EventingService(new PrismaOutboxRepository(), new MonotonicUlidGenerator()),
      new AuditService(new PrismaAuditRepository()),
      new MonotonicUlidGenerator(),
      new PrismaPaymentSettlementReader(),
      () => new Date('2026-08-06T10:00:00.000Z'),
    );
    const settled = await settlement.run({
      actorApiKeyId: apiKeyId,
      currency: 'ETB',
      cutoffDate: '2026-08-04',
      idempotencyKey: 'projection-order-settlement',
      merchantId,
      requestId: 'req_projection_order_settlement',
    });
    const settledBatch = await owner.getClient().settlementBatch.findUniqueOrThrow({
      include: { items: true },
      where: { publicId: settled.batchId! },
    });
    expect(settledBatch.items).toEqual([
      expect.objectContaining({ grossMinor: 7_000n, refundedAmountMinor: 3_000n }),
    ]);

    await expect(projection.handle(olderRefund)).resolves.toMatchObject({ kind: 'processed' });
    await expect(projection.handle(olderRefund)).resolves.toEqual({ kind: 'duplicate' });
    expect(
      await owner
        .getClient()
        .settlementPosition.findUniqueOrThrow({ where: { paymentIntentId: paymentId } }),
    ).toMatchObject({ refundedAmountMinor: 3_000n });
    expect(
      await owner.getClient().settlementAdjustment.count({
        where: { paymentIntentId: paymentId },
      }),
    ).toBe(0);

    const orderedPaymentId = '00000000-0000-4000-8000-000000000213';
    const orderedPaymentPublicId = 'pi_01ARZ3NDEKTSV4RRFFQ69G5FB3';
    await owner.getClient().paymentIntent.create({
      data: {
        amountMinor: 5_000n,
        availableAt: availableOn,
        captureMethod: 'MANUAL',
        capturedAmountMinor: 5_000n,
        capturedAt: availableOn,
        currency: 'ETB',
        externalRef: 'projection-ordered-payment',
        id: orderedPaymentId,
        merchantId,
        paymentStatus: 'CAPTURED',
        publicId: orderedPaymentPublicId,
      },
    });
    await projection.handle(
      message({
        availableOn,
        capturedAmountMinor: 5_000,
        currency: 'ETB',
        eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FB3',
        eventType: 'payment.captured.v1',
        ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FB3',
        merchantId,
        occurredAt: availableOn,
        paymentId: orderedPaymentPublicId,
        requestId: 'req_projection_ordered_capture',
      }),
    );
    const orderedRefundId = 'rf_01ARZ3NDEKTSV4RRFFQ69G5FB2';
    await owner.getClient().$transaction(async (transaction) => {
      await transaction.paymentIntent.update({
        data: {
          paymentStatus: 'PARTIALLY_REFUNDED',
          refundedAmountMinor: 1_000n,
          version: { increment: 1 },
        },
        where: { id: orderedPaymentId },
      });
      await transaction.refund.create({
        data: {
          amountMinor: 1_000n,
          createdAt: new Date('2026-08-04T13:00:00.000Z'),
          currency: 'ETB',
          externalRef: 'projection-ordered-refund',
          merchantId,
          paymentIntentId: orderedPaymentId,
          publicId: orderedRefundId,
        },
      });
    });
    await projection.handle(
      message({
        amountMinor: 1_000,
        cumulativeRefundedAmountMinor: 1_000,
        currency: 'ETB',
        eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FB4',
        eventType: 'payment.refunded.v1',
        ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FB4',
        merchantId,
        occurredAt: new Date('2026-08-04T13:00:00.000Z'),
        paymentId: orderedPaymentPublicId,
        refundId: orderedRefundId,
        requestId: 'req_projection_ordered_refund',
      }),
    );
    expect(
      await owner.getClient().settlementPosition.findUniqueOrThrow({
        where: { paymentIntentId: orderedPaymentId },
      }),
    ).toMatchObject({ capturedAmountMinor: 5_000n, refundedAmountMinor: 1_000n });
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
    await expect(reconciliationRepository.readBacklogMetrics(5_000)).resolves.toEqual([]);
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
    await expect(
      new PrismaSettlementRepository(runtime).readBacklogMetrics(5_000),
    ).resolves.toEqual([{ currency: 'ETB', pending: 1 }]);

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
    await expect(
      new PrismaSettlementRepository(runtime).readBacklogMetrics(5_000),
    ).resolves.toEqual([]);

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
