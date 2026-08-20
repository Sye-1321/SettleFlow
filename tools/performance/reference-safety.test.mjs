import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertCleanCandidate,
  buildProviderOnlyCsv,
  parseDockerStats,
  sanitizeK6Summary,
  validateReferenceEvidence,
} from './reference-safety.mjs';

const revision = 'a'.repeat(40);

test('requires an exact clean main candidate', () => {
  assert.equal(
    assertCleanCandidate({ branch: 'main', porcelain: '', revision, upstreamRevision: revision }),
    revision,
  );
  assert.throws(
    () =>
      assertCleanCandidate({
        branch: 'feature',
        porcelain: '',
        revision,
        upstreamRevision: revision,
      }),
    /branch_invalid/u,
  );
  assert.throws(
    () =>
      assertCleanCandidate({
        branch: 'main',
        porcelain: ' M file',
        revision,
        upstreamRevision: revision,
      }),
    /candidate_dirty/u,
  );
  assert.throws(
    () =>
      assertCleanCandidate({
        branch: 'main',
        porcelain: '',
        revision,
        upstreamRevision: 'b'.repeat(40),
      }),
    /candidate_not_pushed/u,
  );
});

test('creates an exact bounded provider-only reconciliation fixture', () => {
  const fixture = buildProviderOnlyCsv({
    merchantCode: 'demo_performance_reconciliation',
    occurredAt: new Date('2026-08-20T08:00:00.000Z'),
    rowCount: 50_000,
  });
  assert.equal(fixture.rowCount, 50_000);
  assert.match(fixture.sha256, /^[a-f\d]{64}$/u);
  assert.ok(fixture.bytes.byteLength < 10 * 1024 * 1024);
  assert.equal(fixture.bytes.toString('utf8').split('\n').length, 50_002);
});

test('sanitizes only approved metrics and threshold outcomes', () => {
  const evidence = sanitizeK6Summary({
    candidate: {
      commit: revision,
      imageIds: { api: `sha256:${'b'.repeat(64)}` },
      version: 'v1.0.0-rc.1',
    },
    environment: { cpuCount: 8, memoryGiB: 16, operatingSystem: 'linux' },
    raw: {
      metrics: {
        checks: { fails: 0, passes: 100, thresholds: { 'rate>0.99': false }, value: 1 },
        http_req_duration: {
          avg: 10,
          'p(95)': 20,
          thresholds: { 'p(95)<300': false },
        },
        http_req_failed: { fails: 10, passes: 0, thresholds: { 'rate<0.01': false }, value: 0 },
        settleflow_financial_effect_failures: {
          fails: 10,
          passes: 0,
          thresholds: { 'rate==0': false },
          value: 0,
        },
        secret_metric: { value: 123 },
      },
    },
    scenario: 'payments-happy-path',
  });
  assert.equal(evidence.status, 'PASS');
  assert.equal(Object.hasOwn(evidence.metrics, 'secret_metric'), false);
});

test('records a crossed pinned-k6 threshold as a failed scenario', () => {
  const rawMetric = { fails: 0, passes: 1, thresholds: { 'rate==1': false }, value: 1 };
  const evidence = sanitizeK6Summary({
    candidate: {
      commit: revision,
      imageIds: { api: `sha256:${'b'.repeat(64)}` },
      version: 'v1.0.0-rc.1',
    },
    environment: { cpuCount: 8, memoryGiB: 16, operatingSystem: 'linux' },
    raw: {
      metrics: {
        checks: { ...rawMetric, thresholds: { 'rate>0.99': false } },
        http_req_duration: { 'p(95)': 4_414, thresholds: { 'p(95)<300': true } },
        http_req_failed: { ...rawMetric, thresholds: { 'rate<0.01': false }, value: 0 },
        settleflow_financial_effect_failures: {
          ...rawMetric,
          thresholds: { 'rate==0': false },
          value: 0,
        },
      },
    },
    scenario: 'payments-happy-path',
  });
  assert.equal(evidence.status, 'FAIL');
  assert.equal(evidence.metrics.http_req_duration.thresholds['p(95)<300'], false);
});

test('rejects secret-bearing or unsafe public evidence fields', () => {
  assert.throws(
    () =>
      validateReferenceEvidence({
        apiKey: 'not-public',
        scenario: 'payments-happy-path',
        schemaVersion: 1,
        status: 'PASS',
      }),
    /field_forbidden/u,
  );
  assert.throws(
    () =>
      validateReferenceEvidence({
        databaseChecks: { migrations: 'PASS' },
        scenario: 'payments-happy-path',
        schemaVersion: 1,
        status: 'PASS',
      }),
    /field_forbidden/u,
  );
  assert.throws(
    () =>
      validateReferenceEvidence({
        rabbitmq: { password: 'not-public' },
        scenario: 'payments-happy-path',
        schemaVersion: 1,
        status: 'FAIL',
      }),
    /field_forbidden/u,
  );
});

test('accepts bounded correctness and post-run integrity evidence', () => {
  const evidence = {
    candidate: {
      commit: revision,
      imageIds: {
        api: `sha256:${'b'.repeat(64)}`,
        migrator: `sha256:${'c'.repeat(64)}`,
        worker: `sha256:${'d'.repeat(64)}`,
      },
      version: 'v1.0.0-rc.1',
    },
    correctness: {
      completionEvents: 1,
      persistedRows: 50_000,
      reconciliationResults: 50_000,
      unmatchedRows: 50_000,
    },
    environment: {
      peakResources: {
        api: { cpuPercent: 10, memoryBytes: 100 },
        postgres: { cpuPercent: 10, memoryBytes: 100 },
        rabbitmq: { cpuPercent: 10, memoryBytes: 100 },
        worker: { cpuPercent: 10, memoryBytes: 100 },
      },
    },
    k6Image:
      'grafana/k6:1.8.0@sha256:b992f241070f3f3a7d78096fa6020db1edcda49297ee8ed9eb0ab847ef3dcb32',
    metrics: {
      checks: { thresholds: { 'rate==1': true }, values: { rate: 1 } },
      http_req_failed: { thresholds: { 'rate==0': true }, values: { rate: 0 } },
      settleflow_reconciliation_completion_failures: {
        thresholds: { 'rate==0': true },
        values: { rate: 0 },
      },
      settleflow_reconciliation_completion_seconds: {
        thresholds: { 'max<300': true },
        values: { max: 10 },
      },
    },
    postRunChecks: {
      invariants: 'PASS',
      migrations: 'PASS',
      runtimePermissions: 'PASS',
    },
    scenario: 'reconciliation-import',
    schemaVersion: 1,
    status: 'PASS',
  };
  assert.equal(validateReferenceEvidence(evidence), evidence);
  assert.throws(
    () =>
      validateReferenceEvidence({
        ...evidence,
        postRunChecks: {
          invariants: 'PASS',
          migrations: 'FAIL',
          runtimePermissions: 'PASS',
        },
      }),
    /evidence_incomplete/u,
  );
});

test('parses only bounded reference-container resource samples', () => {
  const rows = parseDockerStats(
    [
      JSON.stringify({
        CPUPerc: '12.50%',
        MemUsage: '128.5MiB / 384MiB',
        Name: 'settleflow-demo-api-1',
      }),
      JSON.stringify({
        CPUPerc: '2.00%',
        MemUsage: '1GiB / 2GiB',
        Name: 'settleflow-demo-postgres-1',
      }),
    ].join('\n'),
  );
  assert.deepEqual(rows, [
    { cpuPercent: 12.5, memoryBytes: 134_742_016, service: 'api' },
    { cpuPercent: 2, memoryBytes: 1_073_741_824, service: 'postgres' },
  ]);
  assert.throws(
    () =>
      parseDockerStats(JSON.stringify({ CPUPerc: '1%', MemUsage: '1MiB / 2MiB', Name: 'unknown' })),
    /sample_invalid/u,
  );
});
