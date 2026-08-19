import assert from 'node:assert/strict';
import process from 'node:process';
import { test } from 'node:test';

import {
  createDockerArguments,
  K6_IMAGE,
  performanceInternals,
  SCENARIOS,
  validateSafeLocalUrl,
} from './k6.mjs';

test('pins the exact multi-platform k6 image and five approved scenarios', () => {
  assert.match(K6_IMAGE, /^grafana\/k6:1\.8\.0@sha256:[a-f\d]{64}$/u);
  assert.deepEqual(Object.keys(SCENARIOS).sort(), [
    'idempotency-retry-storm',
    'payments-happy-path',
    'reconciliation-import',
    'settlement-batch',
    'webhook-fanout',
  ]);
});

test('accepts only explicit local HTTP performance targets', () => {
  assert.equal(validateSafeLocalUrl('http://127.0.0.1:13000/', 'target'), 'http://127.0.0.1:13000');
  assert.equal(
    validateSafeLocalUrl('http://host.docker.internal:13000', 'target'),
    'http://host.docker.internal:13000',
  );
  for (const target of [
    'https://127.0.0.1:13000',
    'http://10.0.0.4:13000',
    'http://user:secret@localhost:13000',
    'http://localhost:13000/#fragment',
  ]) {
    assert.throws(() => validateSafeLocalUrl(target, 'target'), /performance_url_/u);
  }
});

test('passes secret-bearing values by inherited environment name, never command-line value', () => {
  const environment = {
    ...performanceInternals.inspectionEnvironment(),
    SETTLEFLOW_API_KEY: 'must-not-appear-in-arguments',
  };
  const arguments_ = createDockerArguments(
    process.cwd(),
    'run',
    'payments-happy-path',
    environment,
  );
  assert.ok(arguments_.includes('SETTLEFLOW_API_KEY'));
  assert.ok(!arguments_.join(' ').includes(environment.SETTLEFLOW_API_KEY));
  assert.ok(arguments_.includes('--read-only'));
  assert.ok(arguments_.includes('no-new-privileges:true'));
  assert.ok(arguments_.includes('--cap-drop=ALL'));
  assert.ok(arguments_.includes(K6_IMAGE));
});

test('passes explicit non-secret placeholders for portable scenario inspection', () => {
  const environment = performanceInternals.inspectionEnvironment();
  const arguments_ = createDockerArguments(
    process.cwd(),
    'inspect',
    'payments-happy-path',
    environment,
  );
  assert.ok(arguments_.includes('SETTLEFLOW_API_KEY=inspection-placeholder'));
  assert.ok(arguments_.includes('SETTLEFLOW_BASE_URL=http://host.docker.internal:13000'));
  assert.ok(arguments_.includes('--include-system-env-vars'));
});

test('requires bounded runtime configuration for scenario-specific inputs', () => {
  assert.throws(
    () => performanceInternals.runtimeEnvironment('payments-happy-path', {}),
    /SETTLEFLOW_API_KEY/u,
  );
  assert.throws(
    () =>
      performanceInternals.runtimeEnvironment('settlement-batch', {
        SETTLEFLOW_API_KEY: 'local',
        SETTLEFLOW_BASE_URL: 'http://127.0.0.1:13000',
        SETTLEFLOW_RUN_ID: 'run',
        SETTLEFLOW_SETTLEMENT_FIXTURES_JSON: '[]',
      }),
    /performance_settlement_fixtures_invalid/u,
  );
});
