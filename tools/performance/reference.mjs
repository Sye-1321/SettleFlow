import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import {
  buildDemoImages,
  inspectDemoCompose,
  inspectDemoVolumes,
  resetDemo,
  startDemoApplications,
  startDemoDependencies,
  stopDemo,
  workerReadinessStatus,
} from '../demo/demo-compose.mjs';
import {
  checkDemoConfiguration,
  createDemoConfiguration,
  hostRuntimeDatabaseUrl,
} from '../demo/demo-config.mjs';
import { runDemo } from '../demo/run-demo.mjs';
import { assertDemoEnvironment, assertResetVolumes, demoPaths } from '../demo/demo-safety.mjs';
import { ContainerWebhookReceiverClient } from '../demo/webhook-receiver.mjs';
import { runScenarioAsync } from './k6.mjs';
import {
  createReferenceDomainContext,
  PAYMENT_SCOPES,
  RECONCILIATION_SCOPES,
  SETTLEMENT_SCOPES,
  WEBHOOK_SCOPES,
} from './reference-domain.mjs';
import {
  assertCleanCandidate,
  assertReferenceHost,
  buildProviderOnlyCsv,
  parseDockerStats,
  REFERENCE_SCENARIOS,
  sanitizeK6Summary,
  validateReferenceEvidence,
} from './reference-safety.mjs';

const API_PORT = 13_000;
const POSTGRES_PORT = 55_432;
const PROMETHEUS_PORT = 19_090;
const RECEIVER_PORT = 18_080;
const CANDIDATE_VERSION = 'v1.0.0-rc.1';
const SETTLEMENT_CODES = Array.from(
  { length: 10 },
  (_, index) => `demo_perf_settlement_${String(index + 1).padStart(2, '0')}`,
);
const OUTPUT_DIRECTORY = resolve('.settleflow', 'performance');
const EVIDENCE_DIRECTORY = resolve(OUTPUT_DIRECTORY, 'evidence');
const SETTLEMENT_STATE = resolve(OUTPUT_DIRECTORY, 'settlement-runtime.json');
const CONTAINERS = [
  'settleflow-demo-api-1',
  'settleflow-demo-worker-1',
  'settleflow-demo-postgres-1',
  'settleflow-demo-rabbitmq-1',
];

function execute(root, executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: root,
    encoding: 'utf8',
    env: options.environment ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(options.errorCode ?? 'performance_command_failed');
  return result.stdout?.trim() ?? '';
}

function git(root, arguments_) {
  return execute(root, 'git', arguments_, { errorCode: 'performance_git_command_failed' });
}

function candidate(root) {
  return {
    branch: git(root, ['branch', '--show-current']),
    porcelain: git(root, ['status', '--porcelain']),
    revision: git(root, ['rev-parse', 'HEAD']),
    upstreamRevision: git(root, ['rev-parse', '@{upstream}']),
  };
}

function secureWrite(path, value) {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function clearScenarioArtifacts(root, scenario) {
  rmSync(resolve(root, OUTPUT_DIRECTORY, `${scenario}-summary.json`), { force: true });
  rmSync(resolve(root, EVIDENCE_DIRECTORY, `${scenario}.json`), { force: true });
}

function corepack(root, script, environment = process.env) {
  const cli = resolve(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js');
  if (!existsSync(cli)) throw new Error('performance_pnpm_runtime_unavailable');
  execute(root, process.execPath, [cli, 'pnpm', script], {
    environment,
    errorCode: `performance_${script.replaceAll(':', '_')}_failed`,
    inherit: true,
  });
}

function safeReset(root) {
  const paths = demoPaths(root);
  if (!existsSync(paths.directory)) return;
  const configuration = checkDemoConfiguration(paths.directory);
  const databaseUrl = hostRuntimeDatabaseUrl(configuration);
  assertDemoEnvironment(process.env, databaseUrl);
  inspectDemoCompose(root);
  assertResetVolumes(inspectDemoVolumes(root));
  resetDemo(root);
  rmSync(paths.directory, { force: true, recursive: true });
}

function createConfiguration(root, revision) {
  const paths = demoPaths(root);
  return createDemoConfiguration(root, paths.directory, {
    apiPort: API_PORT,
    createdAt: new Date().toISOString(),
    imageVersion: CANDIDATE_VERSION,
    postgresPort: POSTGRES_PORT,
    prometheusPort: PROMETHEUS_PORT,
    receiverPort: RECEIVER_PORT,
    revision,
  });
}

function ownerDatabaseUrl(configuration) {
  const compose = configuration['compose.env'];
  const postgres = configuration['postgres.env'];
  return `postgresql://${postgres.POSTGRES_USER}:${encodeURIComponent(postgres.POSTGRES_PASSWORD)}@127.0.0.1:${compose.SETTLEFLOW_DEMO_POSTGRES_PORT}/${postgres.POSTGRES_DB}`;
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

async function waitUntil(operation, predicate, errorCode, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (predicate(value)) return value;
    } catch {
      // Bounded startup polling treats transition failures as not ready.
    }
    await setTimeout(250);
  }
  throw new Error(errorCode);
}

async function waitForRuntime(root) {
  await waitUntil(
    () => request('/health/ready'),
    (result) => result.status === 200,
    'performance_api_readiness_timeout',
  );
  await waitUntil(
    () => Promise.resolve(workerReadinessStatus(root)),
    (status) => status === 200,
    'performance_worker_readiness_timeout',
  );
}

function imageModel(root, version, expectedRevision = git(root, ['rev-parse', 'HEAD'])) {
  const imageIds = {};
  for (const name of ['api', 'worker', 'migrator']) {
    const model = JSON.parse(
      execute(root, 'docker', ['image', 'inspect', `settleflow-${name}:${version}`], {
        errorCode: 'performance_image_inspection_failed',
      }),
    )[0];
    if (
      model?.Config?.Labels?.['org.opencontainers.image.revision'] !== expectedRevision ||
      model.Config.Labels['org.opencontainers.image.version'] !== version
    ) {
      throw new Error('performance_image_metadata_invalid');
    }
    imageIds[name] = model.Id;
  }
  return imageIds;
}

function environmentEvidence(root) {
  return {
    architecture: process.arch,
    cpuCount: cpus().length,
    dockerVersion: execute(root, 'docker', ['version', '--format', '{{.Server.Version}}'], {
      errorCode: 'performance_docker_version_unavailable',
    }),
    freeMemoryGiB: Math.floor(freemem() / 1024 ** 3),
    nodeVersion: process.version,
    operatingSystem: `${platform()} ${release()}`,
    totalMemoryGiB: Math.floor(totalmem() / 1024 ** 3),
  };
}

function verifyReferenceHost(root) {
  const names = execute(root, 'docker', ['ps', '--format', '{{.Names}}'], {
    errorCode: 'performance_docker_inventory_unavailable',
  })
    .split(/\r?\n/u)
    .filter(Boolean);
  assertReferenceHost({
    containerNames: names,
    cpuCount: cpus().length,
    totalMemoryGiB: Math.floor(totalmem() / 1024 ** 3),
  });
}

function sampleResources(root, peaks) {
  try {
    const source = execute(
      root,
      'docker',
      ['stats', '--no-stream', '--format', '{{json .}}', ...CONTAINERS],
      { errorCode: 'performance_resource_sample_failed' },
    );
    for (const row of parseDockerStats(source)) {
      const current = peaks[row.service] ?? { cpuPercent: 0, memoryBytes: 0 };
      peaks[row.service] = {
        cpuPercent: Math.max(current.cpuPercent, row.cpuPercent),
        memoryBytes: Math.max(current.memoryBytes, row.memoryBytes),
      };
    }
  } catch {
    // A missing resource sample fails final evidence validation below without interrupting k6 cleanup.
  }
}

async function measuredScenario(root, scenario, environment) {
  const summaryPath = resolve(root, OUTPUT_DIRECTORY, `${scenario}-summary.json`);
  const evidencePath = resolve(root, EVIDENCE_DIRECTORY, `${scenario}.json`);
  const peaks = {};
  sampleResources(root, peaks);
  const timer = setInterval(() => sampleResources(root, peaks), 2_000);
  const startedAt = Date.now();
  let failure;
  try {
    await runScenarioAsync(scenario, root, { ...process.env, ...environment });
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(timer);
    sampleResources(root, peaks);
  }
  if (!existsSync(summaryPath)) throw failure ?? new Error('performance_summary_missing');
  const evidence = sanitizeK6Summary({
    candidate: {
      commit: git(root, ['rev-parse', 'HEAD']),
      imageIds: imageModel(root, CANDIDATE_VERSION),
      version: CANDIDATE_VERSION,
    },
    environment: {
      ...environmentEvidence(root),
      elapsedMilliseconds: Date.now() - startedAt,
      peakResources: peaks,
      referenceCpuLimit: 1,
      referencePostgresMemoryMiB: 512,
      referenceBrokerMemoryMiB: 512,
      referenceWorkerMemoryMiB: 512,
    },
    raw: JSON.parse(readFileSync(summaryPath, 'utf8')),
    scenario,
  });
  if (Object.keys(peaks).length !== 4) throw new Error('performance_resource_evidence_incomplete');
  if (failure !== undefined || evidence.status !== 'PASS') {
    evidence.status = 'FAIL';
    secureWrite(evidencePath, evidence);
    throw failure ?? new Error('performance_threshold_failed');
  }
  return evidence;
}

function databaseEnvironment(configuration) {
  return {
    ...process.env,
    DATABASE_URL: hostRuntimeDatabaseUrl(configuration),
    MIGRATION_DATABASE_URL: ownerDatabaseUrl(configuration),
    POSTGRES_APP_USER: 'settleflow_app',
  };
}

function verifyDatabase(root, configuration) {
  const environment = databaseEnvironment(configuration);
  corepack(root, 'db:migrate:verify', environment);
  corepack(root, 'db:permissions:check', environment);
  corepack(root, 'db:invariants:check', environment);
}

function baseK6Environment(apiKey, runId) {
  return {
    SETTLEFLOW_API_KEY: apiKey,
    SETTLEFLOW_BASE_URL: `http://host.docker.internal:${API_PORT}`,
    SETTLEFLOW_RUN_ID: runId,
  };
}

async function registerWebhook(apiKey) {
  const hookPath = `/hooks/${randomBytes(18).toString('base64url')}`;
  const response = await request('/v1/webhook-endpoints', {
    body: JSON.stringify({
      subscriptions: ['payment.created.v1'],
      url: `http://demo-webhook-receiver:${RECEIVER_PORT}${hookPath}`,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  if (response.status !== 201 || typeof response.body?.secret !== 'string') {
    throw new Error('performance_webhook_registration_failed');
  }
  const receiver = new ContainerWebhookReceiverClient({ port: RECEIVER_PORT });
  await receiver.configure(hookPath, response.body.secret);
  return receiver;
}

async function prepareScenario(root, scenario, revision, buildImages) {
  safeReset(root);
  verifyReferenceHost(root);
  const configuration = createConfiguration(root, revision);
  inspectDemoCompose(root);
  if (buildImages) buildDemoImages(root);
  startDemoDependencies(root);
  const context = await createReferenceDomainContext(hostRuntimeDatabaseUrl(configuration));
  let receiver;
  let environment;
  try {
    if (scenario === 'payments-happy-path' || scenario === 'idempotency-retry-storm') {
      const code = `demo_perf_${scenario === 'payments-happy-path' ? 'payments' : 'idempotency'}`;
      const fixture = await context.provisionMerchant(code, PAYMENT_SCOPES);
      startDemoApplications(root);
      await waitForRuntime(root);
      environment = baseK6Environment(fixture.apiKey.plaintext, scenario.replaceAll('-', '_'));
      return { code, configuration, context, environment };
    }
    if (scenario === 'webhook-fanout') {
      const code = 'demo_perf_webhook';
      const fixture = await context.provisionMerchant(code, WEBHOOK_SCOPES);
      startDemoApplications(root);
      await waitForRuntime(root);
      receiver = await registerWebhook(fixture.apiKey.plaintext);
      environment = {
        ...baseK6Environment(fixture.apiKey.plaintext, 'webhook_fanout'),
        SETTLEFLOW_WEBHOOK_RECEIVER_URL: `http://host.docker.internal:${RECEIVER_PORT}/__settleflow_demo/receiver`,
      };
      return { code, configuration, context, environment, receiver };
    }
    if (scenario === 'reconciliation-import') {
      const code = 'demo_perf_reconciliation';
      const fixture = await context.provisionMerchant(code, RECONCILIATION_SCOPES);
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const end = new Date(start.getTime() + 86_400_000);
      const csv = buildProviderOnlyCsv({
        merchantCode: code,
        occurredAt: new Date(start.getTime() + 1_000),
      });
      const csvPath = resolve(root, OUTPUT_DIRECTORY, 'reconciliation-50000.csv');
      mkdirSync(dirname(csvPath), { mode: 0o700, recursive: true });
      writeFileSync(csvPath, csv.bytes, { mode: 0o600 });
      startDemoApplications(root);
      await waitForRuntime(root);
      environment = {
        ...baseK6Environment(fixture.apiKey.plaintext, 'reconciliation_import'),
        SETTLEFLOW_RECONCILIATION_CSV_HOST: csvPath,
        SETTLEFLOW_RECONCILIATION_PERIOD_END: end.toISOString(),
        SETTLEFLOW_RECONCILIATION_PERIOD_START: start.toISOString(),
      };
      return { code, configuration, context, environment };
    }
    if (scenario === 'settlement-batch') {
      const fixtures = [];
      for (const [index, code] of SETTLEMENT_CODES.entries()) {
        const fixture = await context.provisionMerchant(code, SETTLEMENT_SCOPES);
        fixtures.push({
          apiKey: fixture.apiKey.plaintext,
          code,
          currency: index % 2 === 0 ? 'ETB' : 'USD',
        });
      }
      startDemoApplications(root);
      await waitForRuntime(root);
      await Promise.all(
        fixtures.map((fixture, index) =>
          context.createCapturedPayments({
            code: fixture.code,
            count: 500,
            currency: fixture.currency,
            runId: `settlement_${String(index + 1).padStart(2, '0')}`,
          }),
        ),
      );
      await context.waitForCount(
        () => context.database.getClient().settlementPosition.count(),
        5_000,
        'performance_settlement_projection_timeout',
        600_000,
      );
      await context.waitForOutboxDrain(600_000);
      const latest = await context.database.getClient().settlementPosition.aggregate({
        _max: { availableAt: true },
      });
      const availableAt = latest._max.availableAt;
      if (availableAt === null) throw new Error('performance_settlement_fixture_missing');
      const cutoffDate = availableAt.toISOString().slice(0, 10);
      const cutoffAt = new Date(`${cutoffDate}T21:00:00.000Z`);
      if (availableAt >= cutoffAt) {
        throw new Error('performance_settlement_fixture_crossed_cutoff');
      }
      environment = {
        ...baseK6Environment(fixtures[0].apiKey, 'settlement_batch'),
        SETTLEFLOW_SETTLEMENT_FIXTURES_JSON: JSON.stringify(
          fixtures.map((fixture) => ({
            apiKey: fixture.apiKey,
            currency: fixture.currency,
            cutoffDate,
          })),
        ),
      };
      return { code: undefined, configuration, context, cutoffAt, environment };
    }
    throw new Error('performance_scenario_invalid');
  } catch (error) {
    await receiver?.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    throw error;
  }
}

async function verifyScenario(root, scenario, prepared) {
  await prepared.context.waitForOutboxDrain(600_000);
  let correctness;
  if (scenario === 'payments-happy-path' || scenario === 'idempotency-retry-storm') {
    const payments = await prepared.context.verifyCapturedPayments(prepared.code);
    correctness = {
      capturedPayments: payments,
      captureLedgers: payments,
      captureOutboxEvents: payments,
    };
  } else if (scenario === 'webhook-fanout') {
    correctness = await prepared.context.verifyWebhookFanout(prepared.code);
  } else if (scenario === 'reconciliation-import') {
    correctness = await prepared.context.verifyReconciliation(prepared.code);
  } else if (scenario === 'settlement-batch') {
    correctness = await prepared.context.verifySettlementFixture(SETTLEMENT_CODES);
  }
  verifyDatabase(root, prepared.configuration);
  return correctness;
}

async function executePrepared(root, scenario, prepared) {
  try {
    const evidence = await measuredScenario(root, scenario, prepared.environment);
    evidence.correctness = await verifyScenario(root, scenario, prepared);
    evidence.postRunChecks = {
      invariants: 'PASS',
      migrations: 'PASS',
      runtimePermissions: 'PASS',
    };
    validateReferenceEvidence(evidence);
    secureWrite(resolve(root, EVIDENCE_DIRECTORY, `${scenario}.json`), evidence);
    return evidence;
  } finally {
    await prepared.receiver?.close().catch(() => undefined);
    await prepared.context.close().catch(() => undefined);
    try {
      stopDemo(root);
    } catch {
      // Reset performs the final bounded cleanup and preserves the primary failure.
    }
  }
}

async function warmup(root) {
  safeReset(root);
  verifyReferenceHost(root);
  rmSync(resolve(root, OUTPUT_DIRECTORY, 'warmup-evidence.json'), { force: true });
  const previous = process.env.SETTLEFLOW_DEMO_MODE;
  process.env.SETTLEFLOW_DEMO_MODE = 'true';
  try {
    await runDemo(root);
    const source = demoPaths(root).evidence;
    if (!existsSync(source)) throw new Error('performance_warmup_evidence_missing');
    mkdirSync(resolve(root, OUTPUT_DIRECTORY), { mode: 0o700, recursive: true });
    copyFileSync(source, resolve(root, OUTPUT_DIRECTORY, 'warmup-evidence.json'));
  } finally {
    try {
      process.env.SETTLEFLOW_DEMO_MODE = 'true';
      safeReset(root);
    } finally {
      if (previous === undefined) delete process.env.SETTLEFLOW_DEMO_MODE;
      else process.env.SETTLEFLOW_DEMO_MODE = previous;
    }
  }
}

async function runImmediate(root, scenario, revision, buildImages = true) {
  clearScenarioArtifacts(root, scenario);
  const prepared = await prepareScenario(root, scenario, revision, buildImages);
  return executePrepared(root, scenario, prepared);
}

async function prepareSettlement(root, revision, buildImages = true) {
  rmSync(resolve(root, SETTLEMENT_STATE), { force: true });
  clearScenarioArtifacts(root, 'settlement-batch');
  const prepared = await prepareScenario(root, 'settlement-batch', revision, buildImages);
  const state = {
    candidate: { imageIds: imageModel(root, CANDIDATE_VERSION), revision },
    cutoffAt: prepared.cutoffAt.toISOString(),
    environment: prepared.environment,
    preparedAt: new Date().toISOString(),
    version: CANDIDATE_VERSION,
  };
  secureWrite(resolve(root, SETTLEMENT_STATE), state);
  await prepared.context.close();
  process.stdout.write(
    `Settlement fixture prepared safely. Resume after ${state.cutoffAt}; containers and ignored credentials remain local.\n`,
  );
}

async function resumeSettlement(root, revision) {
  if (!existsSync(resolve(root, SETTLEMENT_STATE))) {
    throw new Error('performance_settlement_state_missing');
  }
  const state = JSON.parse(readFileSync(resolve(root, SETTLEMENT_STATE), 'utf8'));
  if (
    state.candidate?.revision !== revision ||
    state.version !== CANDIDATE_VERSION ||
    JSON.stringify(state.candidate.imageIds) !== JSON.stringify(imageModel(root, CANDIDATE_VERSION))
  ) {
    throw new Error('performance_settlement_candidate_changed');
  }
  const cutoffAt = new Date(state.cutoffAt);
  if (!Number.isFinite(cutoffAt.getTime()) || new Date() < cutoffAt) {
    throw new Error('performance_settlement_cutoff_not_closed');
  }
  verifyReferenceHost(root);
  clearScenarioArtifacts(root, 'settlement-batch');
  const configuration = checkDemoConfiguration(demoPaths(root).directory);
  const context = await createReferenceDomainContext(hostRuntimeDatabaseUrl(configuration));
  const prepared = { configuration, context, environment: state.environment };
  await waitForRuntime(root);
  await executePrepared(root, 'settlement-batch', prepared);
  rmSync(resolve(root, SETTLEMENT_STATE), { force: true });
}

async function main(root = process.cwd()) {
  process.env.SETTLEFLOW_DEMO_MODE = 'true';
  const [action, scenario] = process.argv.slice(2);
  if (action === 'check') {
    if (REFERENCE_SCENARIOS.length !== 5) throw new Error('performance_scenario_inventory_invalid');
    process.stdout.write('Reference performance orchestration policy is valid.\n');
    return;
  }
  const state = candidate(root);
  const revision = assertCleanCandidate(state);
  if (action === 'warmup') {
    await warmup(root);
    return;
  }
  if (action === 'run' && scenario !== undefined && scenario !== 'settlement-batch') {
    await runImmediate(root, scenario, revision);
    safeReset(root);
    return;
  }
  if (action === 'run-ready') {
    await warmup(root);
    corepack(root, 'build');
    let buildImages = true;
    for (const readyScenario of REFERENCE_SCENARIOS.filter((name) => name !== 'settlement-batch')) {
      await runImmediate(root, readyScenario, revision, buildImages);
      buildImages = false;
      safeReset(root);
    }
    process.stdout.write(
      'Four immediately runnable scenarios passed; settlement remains a blocking prepared-then-resume gate.\n',
    );
    return;
  }
  if (action === 'prepare' && scenario === 'settlement-batch') {
    corepack(root, 'build');
    await prepareSettlement(root, revision);
    return;
  }
  if (action === 'resume' && scenario === 'settlement-batch') {
    await resumeSettlement(root, revision);
    safeReset(root);
    return;
  }
  throw new Error(
    'usage: reference.mjs check | warmup | run-ready | run <non-settlement-scenario> | prepare settlement-batch | resume settlement-batch',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    const code =
      error instanceof Error && /^performance_[a-z0-9_:]{1,100}$/u.test(error.message)
        ? error.message
        : 'performance_reference_failed';
    process.stderr.write(`FAIL: ${code}\n`);
    process.exitCode = 1;
  });
}

export const referenceInternals = {
  baseK6Environment,
  databaseEnvironment,
  environmentEvidence,
  ownerDatabaseUrl,
};
