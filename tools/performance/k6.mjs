import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

export const K6_IMAGE =
  'grafana/k6:1.8.0@sha256:b992f241070f3f3a7d78096fa6020db1edcda49297ee8ed9eb0ab847ef3dcb32';

export const SCENARIOS = Object.freeze({
  'idempotency-retry-storm': 'idempotency-retry-storm.js',
  'payments-happy-path': 'payments-happy-path.js',
  'reconciliation-import': 'reconciliation-import.js',
  'settlement-batch': 'settlement-batch.js',
  'webhook-fanout': 'webhook-fanout.js',
});

const PASSED_ENVIRONMENT = Object.freeze([
  'SETTLEFLOW_API_KEY',
  'SETTLEFLOW_BASE_URL',
  'SETTLEFLOW_RECONCILIATION_PERIOD_END',
  'SETTLEFLOW_RECONCILIATION_PERIOD_START',
  'SETTLEFLOW_RUN_ID',
  'SETTLEFLOW_SETTLEMENT_FIXTURES_JSON',
  'SETTLEFLOW_WEBHOOK_RECEIVER_URL',
]);

function requireEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`performance_configuration_missing:${name}`);
  }
  return value;
}

export function validateSafeLocalUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`performance_url_invalid:${name}`);
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'host.docker.internal', 'localhost'].includes(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`performance_url_not_local:${name}`);
  }
  return url.toString().replace(/\/$/u, '');
}

function inspectionEnvironment() {
  const fixtures = Array.from({ length: 10 }, (_, index) => ({
    apiKey: `inspection-placeholder-${index}`,
    currency: index % 2 === 0 ? 'ETB' : 'USD',
    cutoffDate: '2026-08-01',
  }));
  return {
    ...process.env,
    SETTLEFLOW_API_KEY: 'inspection-placeholder',
    SETTLEFLOW_BASE_URL: 'http://host.docker.internal:13000',
    SETTLEFLOW_RECONCILIATION_CSV: '/fixtures/mock-provider-golden.csv',
    SETTLEFLOW_RECONCILIATION_PERIOD_END: '2026-08-02T00:00:00.000Z',
    SETTLEFLOW_RECONCILIATION_PERIOD_START: '2026-08-01T00:00:00.000Z',
    SETTLEFLOW_RUN_ID: 'inspect',
    SETTLEFLOW_SETTLEMENT_FIXTURES_JSON: JSON.stringify(fixtures),
    SETTLEFLOW_WEBHOOK_RECEIVER_URL: 'http://host.docker.internal:18080',
  };
}

function runtimeEnvironment(scenario, environment) {
  requireEnvironment(environment, 'SETTLEFLOW_API_KEY');
  validateSafeLocalUrl(
    requireEnvironment(environment, 'SETTLEFLOW_BASE_URL'),
    'SETTLEFLOW_BASE_URL',
  );
  const runId = requireEnvironment(environment, 'SETTLEFLOW_RUN_ID');
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(runId)) {
    throw new Error('performance_run_id_invalid');
  }
  if (scenario === 'webhook-fanout') {
    validateSafeLocalUrl(
      requireEnvironment(environment, 'SETTLEFLOW_WEBHOOK_RECEIVER_URL'),
      'SETTLEFLOW_WEBHOOK_RECEIVER_URL',
    );
  }
  if (scenario === 'settlement-batch') {
    const fixtures = JSON.parse(
      requireEnvironment(environment, 'SETTLEFLOW_SETTLEMENT_FIXTURES_JSON'),
    );
    if (!Array.isArray(fixtures) || fixtures.length !== 10) {
      throw new Error('performance_settlement_fixtures_invalid');
    }
  }
  if (scenario === 'reconciliation-import') {
    requireEnvironment(environment, 'SETTLEFLOW_RECONCILIATION_CSV_HOST');
    requireEnvironment(environment, 'SETTLEFLOW_RECONCILIATION_PERIOD_START');
    requireEnvironment(environment, 'SETTLEFLOW_RECONCILIATION_PERIOD_END');
  }
  return { ...environment };
}

export function createDockerArguments(root, action, scenario, environment) {
  const file = SCENARIOS[scenario];
  if (file === undefined) throw new Error('performance_scenario_invalid');
  const arguments_ = [
    'run',
    '--rm',
    '--pull=always',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=32m',
    '--volume',
    `${resolve(root, 'perf')}:/perf:ro`,
    '--volume',
    `${resolve(root, 'examples/reconciliation')}:/fixtures:ro`,
  ];

  if (action === 'run') {
    const evidenceDirectory = resolve(root, '.settleflow', 'performance');
    mkdirSync(evidenceDirectory, { mode: 0o700, recursive: true });
    try {
      chmodSync(evidenceDirectory, 0o700);
    } catch {
      // Windows ACLs are not represented by POSIX mode bits; the path remains ignored and local.
    }
    arguments_.push('--volume', `${evidenceDirectory}:/evidence`);
    if (process.platform === 'linux') arguments_.push('--network', 'host');
    for (const name of PASSED_ENVIRONMENT) {
      if (environment[name] !== undefined) arguments_.push('--env', name);
    }
    if (scenario === 'reconciliation-import') {
      arguments_.push(
        '--volume',
        `${resolve(environment.SETTLEFLOW_RECONCILIATION_CSV_HOST)}:/input/reconciliation.csv:ro`,
        '--env',
        'SETTLEFLOW_RECONCILIATION_CSV=/input/reconciliation.csv',
      );
    }
  } else {
    for (const name of [...PASSED_ENVIRONMENT, 'SETTLEFLOW_RECONCILIATION_CSV']) {
      arguments_.push('--env', `${name}=${environment[name]}`);
    }
  }

  const user =
    process.platform === 'linux' && process.getuid
      ? `${process.getuid()}:${process.getgid()}`
      : '10001:10001';
  arguments_.push('--user', user, K6_IMAGE);
  if (action === 'inspect') {
    arguments_.push('inspect', '--include-system-env-vars', `/perf/k6/${file}`);
  } else {
    arguments_.push(
      'run',
      '--summary-export',
      `/evidence/${scenario}-summary.json`,
      `/perf/k6/${file}`,
    );
  }
  return arguments_;
}

function execute(root, arguments_, environment) {
  const result = spawnSync('docker', arguments_, {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('performance_k6_command_failed');
}

export function inspectScenarios(root = process.cwd()) {
  const environment = inspectionEnvironment();
  for (const scenario of Object.keys(SCENARIOS)) {
    execute(root, createDockerArguments(root, 'inspect', scenario, environment), environment);
  }
}

export function runScenario(scenario, root = process.cwd(), environment = process.env) {
  const validatedEnvironment = runtimeEnvironment(scenario, environment);
  execute(
    root,
    createDockerArguments(root, 'run', scenario, validatedEnvironment),
    validatedEnvironment,
  );
}

export const performanceInternals = { inspectionEnvironment, runtimeEnvironment };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [action, scenario] = process.argv.slice(2);
  if (action === 'check' && scenario === undefined) inspectScenarios();
  else if (action === 'run' && scenario !== undefined) runScenario(scenario);
  else throw new Error('usage: node tools/performance/k6.mjs check | run <scenario>');
}
