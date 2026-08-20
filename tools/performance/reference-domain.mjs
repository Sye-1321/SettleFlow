import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';

const require = createRequire(import.meta.url);

export const PAYMENT_SCOPES = Object.freeze(['payments:read', 'payments:write']);
export const RECONCILIATION_SCOPES = Object.freeze(['reconciliation:read', 'reconciliation:write']);
export const SETTLEMENT_SCOPES = Object.freeze(['settlements:read', 'settlements:write']);
export const WEBHOOK_SCOPES = Object.freeze([
  'payments:read',
  'payments:write',
  'webhooks:manage',
  'webhooks:read',
]);

function runtimeModules() {
  return {
    ...require('../../packages/infrastructure/dist'),
    ...require('../../packages/modules/merchant-access/dist'),
    ...require('../../packages/modules/idempotency/dist'),
    ...require('../../packages/modules/eventing/dist'),
    ...require('../../packages/modules/ledger/dist'),
    ...require('../../packages/modules/operations/dist'),
    ...require('../../packages/modules/payments/dist'),
    ...require('../../packages/modules/settlements/dist'),
  };
}

async function runBounded(total, concurrency, operation) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(total, concurrency) }, async () => {
      while (next < total) {
        const index = next;
        next += 1;
        await operation(index);
      }
    }),
  );
}

function assertMerchantCode(code) {
  if (!/^demo_[a-z0-9_]{1,58}$/u.test(code)) {
    throw new Error('performance_merchant_code_invalid');
  }
}

export async function createReferenceDomainContext(databaseUrl) {
  const modules = runtimeModules();
  const database = new modules.PrismaDatabase({
    connectionTimeoutMs: 5_000,
    databaseUrl,
    maxConnections: 20,
  });
  await database.connect();
  const identifiers = new modules.MonotonicUlidGenerator();
  const merchantAccess = new modules.MerchantAccessService(
    new modules.PrismaMerchantAccessRepository(database),
    new modules.ApiKeyCredentialService(),
  );
  const ledger = new modules.LedgerService(
    new modules.PrismaLedgerRepository(database),
    identifiers,
  );
  const idempotency = new modules.IdempotencyService(
    new modules.PrismaIdempotencyRepository(database, {
      leaseDurationMs: 30_000,
      lockTimeoutMs: 5_000,
      replayDurationMs: 7 * 86_400_000,
      statementTimeoutMs: 10_000,
    }),
  );
  const eventing = new modules.EventingService(new modules.PrismaOutboxRepository(), identifiers);
  const payments = new modules.PaymentIntentService(
    new modules.PrismaPaymentIntentRepository(database),
    idempotency,
    eventing,
    ledger,
    new modules.DeterministicMockPaymentExecution(),
    identifiers,
  );

  async function merchantByCode(code) {
    assertMerchantCode(code);
    return database.getClient().merchant.findUniqueOrThrow({ where: { code } });
  }

  return {
    database,
    merchantAccess,
    async close() {
      await database.close();
    },
    async provisionMerchant(code, scopes) {
      assertMerchantCode(code);
      const merchant = await merchantAccess.provisionSyntheticMerchant(code);
      const chart = await database
        .getClient()
        .$transaction((transaction) => ledger.provisionAccounts(transaction, merchant.id));
      if (chart.accounts.length !== 8) throw new Error('performance_chart_incomplete');
      const apiKey = await merchantAccess.issueApiKey({ merchantId: merchant.id, scopes });
      return { apiKey, chart, merchant };
    },
    async createCapturedPayments({ code, count, currency, runId }) {
      const merchant = await merchantByCode(code);
      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > 5_000 ||
        (currency !== 'ETB' && currency !== 'USD') ||
        !/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(runId)
      ) {
        throw new Error('performance_capture_fixture_invalid');
      }
      await runBounded(count, 2, async (index) => {
        const ordinal = String(index + 1).padStart(4, '0');
        const payment = await payments.create({
          amountMinor: 10_000,
          captureMethod: 'manual',
          currency,
          externalRef: `${runId}_${ordinal}`,
          idempotencyKey: `${runId}-${ordinal}-create`,
          merchantId: merchant.id,
          requestId: `perf_${runId}`,
        });
        await payments.capture({
          amountMinor: 10_000,
          currency,
          idempotencyKey: `${runId}-${ordinal}-capture`,
          merchantId: merchant.id,
          paymentId: payment.id,
          requestId: `perf_${runId}`,
        });
      });
    },
    async waitForCount(operation, expected, errorCode, timeoutMs = 300_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((await operation()) === expected) return;
        await setTimeout(250);
      }
      throw new Error(errorCode);
    },
    async waitForOutboxDrain(timeoutMs = 300_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const pending = await database.getClient().outboxEvent.count({
          where: { publishedAt: null },
        });
        if (pending === 0) return;
        await setTimeout(250);
      }
      throw new Error('performance_outbox_drain_timeout');
    },
    async verifyCapturedPayments(code) {
      const merchant = await merchantByCode(code);
      const rows = await database.getClient().paymentIntent.findMany({
        select: { externalRef: true, id: true, paymentStatus: true, publicId: true },
        where: { merchantId: merchant.id },
      });
      const captured = rows.filter((row) => row.paymentStatus === 'CAPTURED');
      const [captureLedgers, captureEvents] = await Promise.all([
        database.getClient().ledgerTransaction.count({
          where: { businessType: 'CAPTURE', merchantId: merchant.id },
        }),
        database.getClient().outboxEvent.count({
          where: { eventType: 'payment.captured.v1', merchantId: merchant.id },
        }),
      ]);
      if (
        rows.length === 0 ||
        captured.length !== rows.length ||
        new Set(rows.map((row) => row.externalRef)).size !== rows.length ||
        new Set(rows.map((row) => row.publicId)).size !== rows.length ||
        captureLedgers !== rows.length ||
        captureEvents !== rows.length
      ) {
        throw new Error('performance_payment_effect_invalid');
      }
      return rows.length;
    },
    async verifySettlementFixture(codes) {
      const merchants = await Promise.all(codes.map((code) => merchantByCode(code)));
      const merchantIds = merchants.map((merchant) => merchant.id);
      const [batches, items, positions, settlementLedgers] = await Promise.all([
        database.getClient().settlementBatch.findMany({
          select: { itemCount: true, merchantId: true, status: true },
          where: { merchantId: { in: merchantIds } },
        }),
        database.getClient().settlementBatchItem.findMany({
          select: { paymentIntentId: true },
          where: { merchantId: { in: merchantIds } },
        }),
        database.getClient().settlementPosition.count({
          where: { merchantId: { in: merchantIds } },
        }),
        database.getClient().ledgerTransaction.count({
          where: { businessType: 'SETTLEMENT', merchantId: { in: merchantIds } },
        }),
      ]);
      if (
        positions !== 5_000 ||
        batches.length !== 10 ||
        batches.some((batch) => batch.status !== 'SETTLED' || batch.itemCount !== 500) ||
        items.length !== 5_000 ||
        new Set(items.map((item) => item.paymentIntentId)).size !== 5_000 ||
        settlementLedgers !== 10
      ) {
        throw new Error('performance_settlement_effect_invalid');
      }
      return {
        batchItems: items.length,
        batches: batches.length,
        settlementLedgers,
        settlementPositions: positions,
      };
    },
    async verifyWebhookFanout(code) {
      const merchant = await merchantByCode(code);
      const [paymentsCount, deliveries, attempts] = await Promise.all([
        database.getClient().paymentIntent.count({ where: { merchantId: merchant.id } }),
        database.getClient().webhookDelivery.findMany({
          select: { eventId: true, status: true },
          where: { merchantId: merchant.id },
        }),
        database.getClient().webhookDeliveryAttempt.count({
          where: { delivery: { merchantId: merchant.id } },
        }),
      ]);
      if (
        paymentsCount !== 1_000 ||
        deliveries.length !== 1_000 ||
        deliveries.some((delivery) => delivery.status !== 'DELIVERED') ||
        new Set(deliveries.map((delivery) => delivery.eventId)).size !== 1_000 ||
        attempts !== 1_001
      ) {
        throw new Error('performance_webhook_effect_invalid');
      }
      return {
        delivered: deliveries.length,
        deliveryAttempts: attempts,
        payments: paymentsCount,
      };
    },
    async verifyReconciliation(code) {
      const merchant = await merchantByCode(code);
      const imported = await database.getClient().reconciliationImport.findFirstOrThrow({
        include: { summaries: true },
        where: { merchantId: merchant.id },
      });
      const [providerRows, results, completionEvents] = await Promise.all([
        database.getClient().reconciliationProviderRow.count({ where: { importId: imported.id } }),
        database.getClient().reconciliationResult.count({ where: { importId: imported.id } }),
        database.getClient().outboxEvent.count({
          where: {
            aggregateId: imported.publicId,
            eventType: 'reconciliation.completed.v1',
            merchantId: merchant.id,
          },
        }),
      ]);
      const providerOnly = imported.summaries.reduce(
        (total, summary) => total + summary.providerOnlyCount,
        0,
      );
      if (
        imported.status !== 'COMPLETED' ||
        imported.rowCount !== 50_000 ||
        providerRows !== 50_000 ||
        results !== 50_000 ||
        providerOnly !== 50_000 ||
        completionEvents !== 1
      ) {
        throw new Error('performance_reconciliation_effect_invalid');
      }
      return {
        completionEvents,
        persistedRows: providerRows,
        reconciliationResults: results,
        unmatchedRows: providerOnly,
      };
    },
  };
}

export const referenceDomainInternals = { assertMerchantCode, runBounded, runtimeModules };
