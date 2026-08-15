import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  buildDemoImages,
  inspectDemoCompose,
  startDemoApplications,
  startDemoDependencies,
  startRabbitMq,
  stopDemo,
  stopRabbitMq,
  workerReadinessStatus,
} from './demo-compose.mjs';
import {
  checkDemoConfiguration,
  createDemoConfiguration,
  hostRuntimeDatabaseUrl,
} from './demo-config.mjs';
import { createDemoDomainContext } from './demo-domain.mjs';
import {
  assertDemoEnvironment,
  assertSafeEvidenceManifest,
  completedEvidenceExists,
  demoPaths,
} from './demo-safety.mjs';
import { ContainerWebhookReceiverClient } from './webhook-receiver.mjs';

const API_PORT = 13_000;
const POSTGRES_PORT = 55_432;
const PROMETHEUS_PORT = 19_090;
const RECEIVER_PORT = 18_080;
const CURRENT_PAYMENT_MINOR = 50_000;
const CURRENT_REFUND_MINOR = 10_000;

function command(root, executable, arguments_, errorCode) {
  const result = spawnSync(executable, arguments_, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(errorCode);
}

function git(root, arguments_) {
  const result = spawnSync('git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('demo_source_revision_unavailable');
  return result.stdout.trim();
}

async function waitUntil(operation, predicate, errorCode, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (predicate(value)) return value;
    } catch {
      // Bounded polling intentionally treats dependency transition failures as not-ready.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(errorCode);
}

async function request(path, options = {}) {
  const response = await globalThis.fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    ...options,
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { body, headers: response.headers, status: response.status };
}

function authenticated(apiKey, idempotencyKey, body) {
  return {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    method: 'POST',
  };
}

function expectStatus(result, status, code) {
  if (result.status !== status) throw new Error(code);
  return result.body;
}

function utcDay(instant) {
  const start = new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
  return { end: new Date(start.getTime() + 86_400_000), start };
}

function createManifest({ checks, commit, counts, elapsedMs, terminalStates }) {
  return assertSafeEvidenceManifest({
    checks,
    commands: ['pnpm demo', 'pnpm demo:reset -- --yes'],
    counts,
    elapsedMs,
    formatVersion: 1,
    runbooks: [
      'docs/runbooks/outbox-backlog.md',
      'docs/runbooks/reconciliation-unexplained-difference.md',
      'docs/runbooks/settlement-mismatch.md',
      'docs/runbooks/webhook-delivery.md',
    ],
    sourceCommit: commit,
    sourceState: 'dirty-demo-build',
    status: 'PASS',
    terminalStates,
  });
}

export async function runDemo(root = process.cwd()) {
  const paths = demoPaths(root);
  assertDemoEnvironment(
    process.env,
    `postgresql://settleflow_app:local@127.0.0.1:${POSTGRES_PORT}/settleflow_demo`,
  );
  if (completedEvidenceExists(paths.evidence)) {
    process.stdout.write('PASS: the isolated demo already completed; reset explicitly to rerun.\n');
    return { kind: 'already-complete' };
  }

  const startedAt = Date.now();
  const revision = git(root, ['rev-parse', 'HEAD']);
  const fixtureClock = new Date();
  const configuration = createDemoConfiguration(root, paths.directory, {
    apiPort: API_PORT,
    createdAt: fixtureClock.toISOString(),
    postgresPort: POSTGRES_PORT,
    prometheusPort: PROMETHEUS_PORT,
    receiverPort: RECEIVER_PORT,
    revision,
  });
  const databaseUrl = hostRuntimeDatabaseUrl(configuration);
  assertDemoEnvironment(process.env, databaseUrl);
  checkDemoConfiguration(paths.directory);
  inspectDemoCompose(root);

  const corepackCli = resolve(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js');
  if (!existsSync(corepackCli)) {
    throw new Error('demo_pnpm_runtime_unavailable');
  }
  command(root, process.execPath, [corepackCli, 'pnpm', 'build'], 'demo_host_build_failed');
  buildDemoImages(root);
  startDemoDependencies(root);

  let context;
  let endpoint;
  let receiver;
  let apiKey;
  const checks = [];
  try {
    context = await createDemoDomainContext(databaseUrl, fixtureClock);
    const provisioned = await context.provision();
    apiKey = provisioned.apiKey;
    checks.push({ name: 'prerequisites-migrations', passed: true, state: 'PASS' });
    checks.push({ name: 'merchant-chart-key', passed: true, state: 'PASS' });

    const hookPath = `/hooks/${randomBytes(18).toString('base64url')}`;
    receiver = new ContainerWebhookReceiverClient({ port: RECEIVER_PORT });
    startDemoApplications(root);
    await waitUntil(
      () => request('/health/ready'),
      (result) => result.status === 200,
      'demo_api_readiness_timeout',
    );
    await waitUntil(
      () => Promise.resolve(workerReadinessStatus(root)),
      (status) => status === 200,
      'demo_worker_readiness_timeout',
    );
    await waitUntil(
      () =>
        globalThis.fetch(`http://127.0.0.1:${PROMETHEUS_PORT}/-/ready`, {
          signal: globalThis.AbortSignal.timeout(2_000),
        }),
      (response) => response.status === 200,
      'demo_prometheus_readiness_timeout',
    );
    await context.waitForSettlementPosition(
      provisioned.merchant.id,
      provisioned.historicalPayment.id,
    );
    checks.push({ name: 'runtime-telemetry-receiver', passed: true, state: 'READY' });

    const endpointResult = await request(
      '/v1/webhook-endpoints',
      authenticated(apiKey.plaintext, undefined, {
        subscriptions: [
          'payment.created.v1',
          'payment.captured.v1',
          'payment.refunded.v1',
          'settlement.finalized.v1',
          'reconciliation.completed.v1',
        ],
        url: `http://demo-webhook-receiver:${RECEIVER_PORT}${hookPath}`,
      }),
    );
    endpoint = {
      ...expectStatus(endpointResult, 201, 'demo_webhook_registration_failed'),
      etag: endpointResult.headers.get('etag'),
    };
    if (typeof endpoint.secret !== 'string' || endpoint.etag === null) {
      throw new Error('demo_webhook_secret_missing');
    }
    await receiver.configure(hookPath, endpoint.secret);

    const runToken = randomBytes(12).toString('base64url');
    const createKey = `demo-create-${runToken}`;
    const createBody = {
      amountMinor: CURRENT_PAYMENT_MINOR,
      captureMethod: 'manual',
      currency: 'USD',
      externalRef: `demo_order_${runToken}`,
    };
    const created = expectStatus(
      await request('/v1/payment-intents', authenticated(apiKey.plaintext, createKey, createBody)),
      201,
      'demo_payment_create_failed',
    );
    const replayed = expectStatus(
      await request('/v1/payment-intents', authenticated(apiKey.plaintext, createKey, createBody)),
      201,
      'demo_payment_replay_failed',
    );
    if (!isDeepStrictEqual(created, replayed)) {
      throw new Error('demo_payment_replay_not_equivalent');
    }

    const captureKey = `demo-capture-${runToken}`;
    const captureBody = { amountMinor: CURRENT_PAYMENT_MINOR, currency: 'USD' };
    const storm = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(
          `/v1/payment-intents/${created.id}/capture`,
          authenticated(apiKey.plaintext, captureKey, captureBody),
        ),
      ),
    );
    if (storm.some((result) => result.status !== 200 && result.status !== 409)) {
      throw new Error('demo_capture_storm_unexpected_result');
    }
    const captured = await waitUntil(
      () =>
        request(
          `/v1/payment-intents/${created.id}/capture`,
          authenticated(apiKey.plaintext, captureKey, captureBody),
        ),
      (result) => result.status === 200,
      'demo_capture_replay_timeout',
    );
    const successfulStorm = storm.filter((result) => result.status === 200);
    if (successfulStorm.some((result) => !isDeepStrictEqual(result.body, captured.body))) {
      throw new Error('demo_capture_replay_not_equivalent');
    }
    const captureEvidence = await context.assertPaymentEffects(provisioned.merchant.id, created.id);
    await receiver.waitFor({ eventType: 'payment.created.v1' });
    await receiver.waitFor({ eventType: 'payment.captured.v1' });
    receiver.assertSingleRetryThenSuccess();
    checks.push({ name: 'signed-webhook-retry', passed: true, state: 'DELIVERED' });
    checks.push({ name: 'idempotent-capture-storm', passed: true, state: 'CAPTURED' });

    expectStatus(
      await request(
        `/v1/payment-intents/${created.id}/refunds`,
        authenticated(apiKey.plaintext, `demo-refund-${runToken}`, {
          amountMinor: CURRENT_REFUND_MINOR,
          currency: 'USD',
          externalRef: `demo_refund_${runToken}`,
        }),
      ),
      201,
      'demo_refund_failed',
    );
    const refundEvidence = await context.assertRefundEffects(provisioned.merchant.id, created.id);
    await receiver.waitFor({ eventType: 'payment.refunded.v1' });
    checks.push({ name: 'partial-refund-evidence', passed: true, state: 'PARTIALLY_REFUNDED' });

    const settlementRun = await context.runSettlement({
      apiKeyId: apiKey.id,
      merchantId: provisioned.merchant.id,
    });
    const settlementEvidence = await context.assertSettlementEffects(
      provisioned.merchant.id,
      settlementRun,
    );
    await receiver.waitFor({ eventType: 'settlement.finalized.v1' });
    expectStatus(
      await request(
        `/v1/payment-intents/${provisioned.historicalPayment.id}/refunds`,
        authenticated(apiKey.plaintext, 'demo-historical-refund-v1', {
          amountMinor: context.historicalRefundMinor,
          currency: 'ETB',
          externalRef: 'demo_historical_refund_v1',
        }),
      ),
      201,
      'demo_historical_refund_failed',
    );
    await waitUntil(
      () =>
        context.database.getClient().settlementAdjustment.count({
          where: {
            merchantId: provisioned.merchant.id,
            paymentIntent: { publicId: provisioned.historicalPayment.id },
            status: 'PENDING',
          },
        }),
      (count) => count === 1,
      'demo_settlement_adjustment_timeout',
    );
    checks.push({ name: 'settlement-and-adjustment', passed: true, state: 'SETTLED' });

    const interval = utcDay(settlementEvidence.batch.settledAt);
    const csv = await context.buildReconciliationCsv(
      provisioned.merchant,
      interval.start,
      interval.end,
    );
    const form = new globalThis.FormData();
    form.append('periodStart', interval.start.toISOString());
    form.append('periodEnd', interval.end.toISOString());
    form.append(
      'file',
      new globalThis.Blob([csv.bytes], { type: 'text/csv' }),
      'demo-reconciliation.csv',
    );
    const reconciliation = expectStatus(
      await request('/v1/reconciliation-imports', {
        body: form,
        headers: {
          Authorization: `Bearer ${apiKey.plaintext}`,
          'Idempotency-Key': `demo-reconciliation-${runToken}`,
        },
        method: 'POST',
      }),
      202,
      'demo_reconciliation_stage_failed',
    );
    const reportResult = await waitUntil(
      () =>
        request(`/v1/reconciliation-imports/${reconciliation.id}/report`, {
          headers: { Authorization: `Bearer ${apiKey.plaintext}` },
        }),
      (result) => result.status === 200,
      'demo_reconciliation_report_timeout',
    );
    const etbSummary = reportResult.body?.summaries?.find((summary) => summary.currency === 'ETB');
    const usdSummary = reportResult.body?.summaries?.find((summary) => summary.currency === 'USD');
    if (
      etbSummary?.matchedExactCount !== csv.exactCountByCurrency.ETB ||
      etbSummary?.providerOnlyCount !== 1 ||
      etbSummary?.platformOnlyCount !== 0 ||
      etbSummary?.amountMismatchCount !== 0 ||
      etbSummary?.currencyMismatchCount !== 0 ||
      etbSummary?.statusMismatchCount !== 0 ||
      etbSummary?.duplicateProviderRowCount !== 0 ||
      etbSummary?.unexplainedDifferenceMinor !== 1 ||
      usdSummary?.matchedExactCount !== csv.exactCountByCurrency.USD ||
      usdSummary?.providerOnlyCount !== 0 ||
      usdSummary?.platformOnlyCount !== 0 ||
      usdSummary?.amountMismatchCount !== 0 ||
      usdSummary?.currencyMismatchCount !== 0 ||
      usdSummary?.statusMismatchCount !== 0 ||
      usdSummary?.duplicateProviderRowCount !== 0 ||
      usdSummary?.unexplainedDifferenceMinor !== 0
    ) {
      throw new Error('demo_reconciliation_buckets_unstable');
    }
    await receiver.waitFor({ eventType: 'reconciliation.completed.v1' });
    checks.push({ name: 'reconciliation-exact-mismatch', passed: true, state: 'COMPLETED' });

    stopRabbitMq(root);
    const apiUnready = await waitUntil(
      () => request('/health/ready'),
      (result) => result.status === 503,
      'demo_api_did_not_become_unready',
    );
    const workerUnready = await waitUntil(
      () => Promise.resolve(workerReadinessStatus(root)),
      (status) => status === 503,
      'demo_worker_did_not_become_unready',
    );
    const previousCreatedDeliveries = receiver
      .snapshot()
      .filter((attempt) => attempt.eventType === 'payment.created.v1' && attempt.succeeded).length;
    const outagePayment = expectStatus(
      await request(
        '/v1/payment-intents',
        authenticated(apiKey.plaintext, `demo-outage-${runToken}`, {
          amountMinor: CURRENT_PAYMENT_MINOR,
          captureMethod: 'manual',
          currency: 'USD',
          externalRef: `demo_outage_${runToken}`,
        }),
      ),
      201,
      'demo_outage_payment_failed',
    );
    const pending = await context.database.getClient().outboxEvent.findFirstOrThrow({
      select: { eventId: true, publishedAt: true },
      where: {
        aggregateId: outagePayment.id,
        eventType: 'payment.created.v1',
        merchantId: provisioned.merchant.id,
      },
    });
    if (pending.publishedAt !== null || apiUnready.status !== 503 || workerUnready !== 503) {
      throw new Error('demo_outage_pending_not_proven');
    }
    startRabbitMq(root);
    await waitUntil(
      () => request('/health/ready'),
      (result) => result.status === 200,
      'demo_api_recovery_timeout',
      120_000,
    );
    await waitUntil(
      () => Promise.resolve(workerReadinessStatus(root)),
      (status) => status === 200,
      'demo_worker_recovery_timeout',
      120_000,
    );
    await waitUntil(
      () =>
        context.database.getClient().outboxEvent.findUnique({
          select: { publishedAt: true },
          where: { eventId: pending.eventId },
        }),
      (row) => row?.publishedAt !== null,
      'demo_outbox_recovery_timeout',
      120_000,
    );
    await receiver.waitFor({
      eventType: 'payment.created.v1',
      minimumSuccesses: previousCreatedDeliveries + 1,
      timeoutMs: 120_000,
    });
    const dedupCount = await context.database.getClient().inboxMessage.count({
      where: { messageId: pending.eventId },
    });
    if (dedupCount !== 1) throw new Error('demo_outage_deduplication_failed');
    checks.push({ name: 'rabbitmq-outage-recovery', passed: true, state: 'RECOVERED' });

    checks.push({ name: 'sanitized-evidence', passed: true, state: 'PASS' });
    const manifest = createManifest({
      checks,
      commit: revision,
      counts: {
        apiScopes: apiKey.scopes.length,
        captureLedgerPosts: captureEvidence.ledgerCount,
        captureOutboxEffects: captureEvidence.outboxCount,
        chartAccounts: provisioned.accounts.accounts.length,
        demoChecks: checks.length,
        migrationCount: 11,
        reconciliationExactCases: csv.exactCount,
        reconciliationMismatchCases: 1,
        refundLedgerPosts: refundEvidence.ledgerCount,
        refundOutboxEffects: refundEvidence.outboxCount,
        settlementAuditRecords: settlementEvidence.auditCount,
        settlementOutboxEffects: settlementEvidence.outboxCount,
        webhookRetryFailures: 1,
      },
      elapsedMs: Date.now() - startedAt,
      terminalStates: [
        { name: 'api', state: 'READY' },
        { name: 'worker', state: 'READY' },
        { name: 'payment', state: 'PARTIALLY_REFUNDED' },
        { name: 'settlement', state: 'SETTLED' },
        { name: 'reconciliation', state: 'COMPLETED' },
        { name: 'outbox', state: 'PUBLISHED' },
        { name: 'webhook', state: 'DELIVERED' },
      ],
    });
    writeFileSync(paths.evidence, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (endpoint.etag !== null) {
      await request(`/v1/webhook-endpoints/${endpoint.id}`, {
        body: JSON.stringify({ status: 'inactive' }),
        headers: {
          Authorization: `Bearer ${apiKey.plaintext}`,
          'Content-Type': 'application/json',
          'If-Match': endpoint.etag,
        },
        method: 'PATCH',
      });
    }
    await context.merchantAccess.revokeApiKey(apiKey.id);
    process.stdout.write('PASS: sanitized evidence written to .settleflow/demo/evidence.json\n');
    return { kind: 'completed', manifest };
  } finally {
    if (apiKey !== undefined && context !== undefined) {
      await context.merchantAccess.revokeApiKey(apiKey.id).catch(() => undefined);
    }
    await receiver?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    try {
      stopDemo(root);
    } catch {
      // A failed shutdown does not hide the primary bounded demo failure.
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runDemo().catch((error) => {
    const code =
      error instanceof Error && /^demo_[a-z0-9_]{1,80}$/u.test(error.message)
        ? error.message
        : 'demo_execution_failed';
    process.stderr.write(`FAIL: ${code}\n`);
    process.exitCode = 1;
  });
}
