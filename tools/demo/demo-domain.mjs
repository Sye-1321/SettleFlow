import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers';

const require = createRequire(import.meta.url);

export const DEMO_SCOPES = Object.freeze([
  'payments:read',
  'payments:write',
  'webhooks:read',
  'webhooks:manage',
  'settlements:read',
  'settlements:write',
  'reconciliation:read',
  'reconciliation:write',
]);

const HISTORICAL_AMOUNT_MINOR = 120_000;
const HISTORICAL_REFUND_MINOR = 20_000;

function runtimeModules() {
  const infrastructure = require('../../packages/infrastructure/dist');
  const merchantAccess = require('../../packages/modules/merchant-access/dist');
  const idempotency = require('../../packages/modules/idempotency/dist');
  const eventing = require('../../packages/modules/eventing/dist');
  const ledger = require('../../packages/modules/ledger/dist');
  const operations = require('../../packages/modules/operations/dist');
  const payments = require('../../packages/modules/payments/dist');
  const settlements = require('../../packages/modules/settlements/dist');
  return {
    ...infrastructure,
    ...merchantAccess,
    ...idempotency,
    ...eventing,
    ...ledger,
    ...operations,
    ...payments,
    ...settlements,
  };
}

function utcDate(value) {
  return value.toISOString().slice(0, 10);
}

function addDays(value, days) {
  return new Date(value.getTime() + days * 86_400_000);
}

function csv(value) {
  const source = String(value ?? '');
  return /[",\r\n]/u.test(source) ? `"${source.replaceAll('"', '""')}"` : source;
}

export async function createDemoDomainContext(databaseUrl, fixtureClock) {
  const modules = runtimeModules();
  const database = new modules.PrismaDatabase({
    connectionTimeoutMs: 5_000,
    databaseUrl,
    maxConnections: 5,
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
    () => new Date(fixtureClock),
  );
  const settlementClock = addDays(fixtureClock, 3);
  const settlement = new modules.SettlementService(
    new modules.PrismaSettlementRepository(database),
    idempotency,
    ledger,
    eventing,
    new modules.AuditService(new modules.PrismaAuditRepository()),
    identifiers,
    new modules.PrismaPaymentSettlementReader(),
    () => new Date(settlementClock),
  );

  return {
    database,
    merchantAccess,
    payments,
    settlement,
    async close() {
      await database.close();
    },
    async provision() {
      const merchant = await merchantAccess.provisionSyntheticMerchant('demo_reviewer');
      const accounts = await database
        .getClient()
        .$transaction((transaction) => ledger.provisionAccounts(transaction, merchant.id));
      if (accounts.accounts.length !== 8) throw new Error('demo_chart_incomplete');
      const apiKey = await merchantAccess.issueApiKey({
        merchantId: merchant.id,
        scopes: DEMO_SCOPES,
      });
      if (JSON.stringify(apiKey.scopes) !== JSON.stringify([...DEMO_SCOPES].sort())) {
        throw new Error('demo_api_key_scope_mismatch');
      }
      const storedKey = await database.getClient().apiKey.findUniqueOrThrow({
        select: { secretHash: true },
        where: { id: apiKey.id },
      });
      if (storedKey.secretHash.includes(apiKey.plaintext)) {
        throw new Error('demo_api_key_plaintext_persisted');
      }
      const historicalPayment = await payments.create({
        amountMinor: HISTORICAL_AMOUNT_MINOR,
        captureMethod: 'manual',
        currency: 'ETB',
        externalRef: 'demo_historical_capture_v1',
        idempotencyKey: 'demo-historical-payment-v1',
        merchantId: merchant.id,
        requestId: 'demo_historical_create',
      });
      const historicalCapture = await payments.capture({
        amountMinor: HISTORICAL_AMOUNT_MINOR,
        currency: 'ETB',
        idempotencyKey: 'demo-historical-capture-v1',
        merchantId: merchant.id,
        paymentId: historicalPayment.id,
        requestId: 'demo_historical_capture',
      });
      return { accounts, apiKey, historicalCapture, historicalPayment, merchant };
    },
    async runSettlement(identity) {
      return settlement.run({
        actorApiKeyId: identity.apiKeyId,
        currency: 'ETB',
        cutoffDate: utcDate(fixtureClock),
        idempotencyKey: 'demo-historical-settlement-v1',
        merchantId: identity.merchantId,
        requestId: 'demo_historical_settlement',
      });
    },
    async waitForSettlementPosition(merchantId, paymentId, timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const position = await database.getClient().settlementPosition.findFirst({
          select: { id: true },
          where: { merchantId, paymentPublicId: paymentId },
        });
        if (position !== null) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      throw new Error('demo_settlement_projection_timeout');
    },
    async assertPaymentEffects(merchantId, paymentId) {
      const payment = await database.getClient().paymentIntent.findFirstOrThrow({
        select: { id: true, paymentStatus: true, version: true },
        where: { merchantId, publicId: paymentId },
      });
      const [captureLedger, captureOutbox] = await Promise.all([
        database.getClient().ledgerTransaction.findMany({
          include: { entries: true },
          where: { businessReference: paymentId, businessType: 'CAPTURE', merchantId },
        }),
        database.getClient().outboxEvent.count({
          where: { aggregateId: paymentId, eventType: 'payment.captured.v1', merchantId },
        }),
      ]);
      if (payment.paymentStatus !== 'CAPTURED' || payment.version !== 1) {
        throw new Error('demo_capture_transition_not_unique');
      }
      if (captureLedger.length !== 1 || captureOutbox !== 1) {
        throw new Error('demo_capture_effect_not_unique');
      }
      const balance = captureLedger[0].entries.reduce(
        (total, entry) => total + (entry.side === 'DEBIT' ? entry.amountMinor : -entry.amountMinor),
        0n,
      );
      if (balance !== 0n || captureLedger[0].entries.length < 2) {
        throw new Error('demo_ledger_unbalanced');
      }
      return { ledgerCount: captureLedger.length, outboxCount: captureOutbox };
    },
    async assertRefundEffects(merchantId, paymentId) {
      const payment = await database.getClient().paymentIntent.findFirstOrThrow({
        select: {
          capturedAmountMinor: true,
          id: true,
          paymentStatus: true,
          refundedAmountMinor: true,
        },
        where: { merchantId, publicId: paymentId },
      });
      const refunds = await database.getClient().refund.findMany({
        where: { merchantId, paymentIntentId: payment.id },
      });
      if (
        payment.paymentStatus !== 'PARTIALLY_REFUNDED' ||
        payment.refundedAmountMinor <= 0n ||
        payment.refundedAmountMinor >= payment.capturedAmountMinor ||
        refunds.length !== 1
      ) {
        throw new Error('demo_refund_projection_invalid');
      }
      const ledger = await database.getClient().ledgerTransaction.findFirstOrThrow({
        include: { entries: true },
        where: { businessReference: refunds[0].publicId, businessType: 'REFUND', merchantId },
      });
      const balance = ledger.entries.reduce(
        (total, entry) => total + (entry.side === 'DEBIT' ? entry.amountMinor : -entry.amountMinor),
        0n,
      );
      const outboxCount = await database.getClient().outboxEvent.count({
        where: { aggregateId: paymentId, eventType: 'payment.refunded.v1', merchantId },
      });
      if (balance !== 0n || outboxCount !== 1) throw new Error('demo_refund_evidence_invalid');
      return { ledgerCount: 1, outboxCount, refundCount: refunds.length };
    },
    async assertSettlementEffects(merchantId, run) {
      if (run.status !== 'COMPLETED' || run.batchId === undefined) {
        throw new Error('demo_settlement_not_completed');
      }
      const batch = await database.getClient().settlementBatch.findFirstOrThrow({
        include: { items: true, ledgerTransaction: { include: { entries: true } } },
        where: { merchantId, publicId: run.batchId },
      });
      const [auditCount, outboxCount] = await Promise.all([
        database.getClient().auditEvent.count({
          where: { action: 'settlement.run_executed', merchantId, targetId: run.id },
        }),
        database.getClient().outboxEvent.count({
          where: { aggregateId: run.batchId, eventType: 'settlement.finalized.v1', merchantId },
        }),
      ]);
      const balance = batch.ledgerTransaction.entries.reduce(
        (total, entry) => total + (entry.side === 'DEBIT' ? entry.amountMinor : -entry.amountMinor),
        0n,
      );
      if (
        batch.items.length !== 1 ||
        batch.items.some((item) => item.feePolicyVersion !== 'settlement_fee_v1') ||
        new Set(batch.items.map((item) => item.paymentIntentId)).size !== batch.items.length ||
        balance !== 0n ||
        auditCount !== 1 ||
        outboxCount !== 1
      ) {
        throw new Error('demo_settlement_evidence_invalid');
      }
      return { batch, auditCount, outboxCount };
    },
    async buildReconciliationCsv(merchant, periodStart, periodEnd) {
      const paymentReader = new modules.PrismaPaymentReconciliationReader();
      const settlementReader = new modules.PrismaSettlementReconciliationReader();
      const ledgerReader = new modules.PrismaLedgerReconciliationReader();
      const evidence = await database.getClient().$transaction(async (transaction) => {
        const [paymentRows, settlementRows] = await Promise.all([
          paymentReader.readPaymentEvidence(transaction, merchant.id, periodStart, periodEnd),
          settlementReader.readSettlementEvidence(transaction, merchant.id, periodStart, periodEnd),
        ]);
        const rows = [...paymentRows, ...settlementRows];
        const references = await ledgerReader.resolveReconciliationReferences(
          transaction,
          merchant.id,
          rows.map((row) => ({
            businessReference: row.businessReference,
            businessType: row.eventType === 'adjustment' ? 'settlement' : row.eventType,
          })),
        );
        const byReference = new Map(
          references.map((row) => [
            `${row.businessType}:${row.businessReference}`,
            row.providerRef,
          ]),
        );
        return rows.map((row) => ({
          ...row,
          providerRef: byReference.get(
            `${row.eventType === 'adjustment' ? 'settlement' : row.eventType}:${row.businessReference}`,
          ),
        }));
      });
      if (evidence.length === 0 || evidence.some((row) => row.providerRef === undefined)) {
        throw new Error('demo_reconciliation_evidence_missing');
      }
      const header =
        'provider_txn_id,merchant_code,provider_ref,external_ref,event_type,currency,gross_minor,fee_minor,net_minor,status,occurred_at';
      const lines = evidence.map((row, index) =>
        [
          `demo_exact_${index + 1}`,
          merchant.code,
          row.providerRef,
          row.externalRef,
          row.eventType,
          row.currency,
          row.grossMinor,
          'feeMinor' in row ? row.feeMinor : 0n,
          'netMinor' in row ? row.netMinor : row.grossMinor,
          'succeeded',
          row.occurredAt.toISOString(),
        ]
          .map(csv)
          .join(','),
      );
      const fakeReference = `ltx_${identifiers.generate(fixtureClock.getTime())}`;
      lines.push(
        [
          'demo_provider_only_1',
          merchant.code,
          fakeReference,
          '',
          'capture',
          'ETB',
          1,
          0,
          1,
          'succeeded',
          new Date(periodStart.getTime() + 1_000).toISOString(),
        ]
          .map(csv)
          .join(','),
      );
      return {
        bytes: Buffer.from(`${header}\n${lines.join('\n')}\n`, 'utf8'),
        exactCount: evidence.length,
        exactCountByCurrency: {
          ETB: evidence.filter((row) => row.currency === 'ETB').length,
          USD: evidence.filter((row) => row.currency === 'USD').length,
        },
      };
    },
    historicalRefundMinor: HISTORICAL_REFUND_MINOR,
  };
}

export const demoDomainInternals = {
  HISTORICAL_AMOUNT_MINOR,
  HISTORICAL_REFUND_MINOR,
  addDays,
  csv,
  utcDate,
};
