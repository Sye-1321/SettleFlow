import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { runDemo } from './run-demo.mjs';
import {
  assertDemoComposeModel,
  assertDemoEnvironment,
  assertResetVolumes,
  assertSafeEvidenceManifest,
} from './demo-safety.mjs';

const safeDatabase = 'postgresql://settleflow_app:demo@127.0.0.1:55432/settleflow_demo';

function evidence() {
  return {
    checks: [{ name: 'complete', passed: true, state: 'PASS' }],
    commands: ['pnpm demo'],
    counts: { demoChecks: 1 },
    elapsedMs: 1,
    formatVersion: 1,
    runbooks: ['docs/runbooks/outbox-backlog.md'],
    sourceCommit: 'a'.repeat(40),
    sourceState: 'dirty-demo-build',
    status: 'PASS',
    terminalStates: [{ name: 'demo', state: 'PASS' }],
  };
}

test('refuses production, missing or false sentinels, and unsafe database targets', () => {
  assert.throws(
    () =>
      assertDemoEnvironment({ NODE_ENV: 'production', SETTLEFLOW_DEMO_MODE: 'true' }, safeDatabase),
    /demo_production_refused/u,
  );
  for (const sentinel of [undefined, 'false']) {
    assert.throws(
      () =>
        assertDemoEnvironment(
          { NODE_ENV: 'development', SETTLEFLOW_DEMO_MODE: sentinel },
          safeDatabase,
        ),
      /demo_sentinel_required/u,
    );
  }
  for (const databaseUrl of [
    'postgresql://settleflow_app:demo@db.example/settleflow_demo',
    'postgresql://settleflow_app:demo@127.0.0.1/settleflow',
    'postgresql://settleflow:demo@127.0.0.1/settleflow_demo',
  ]) {
    assert.throws(
      () =>
        assertDemoEnvironment(
          { NODE_ENV: 'development', SETTLEFLOW_DEMO_MODE: 'true' },
          databaseUrl,
        ),
      /demo_database_target_unsafe/u,
    );
  }
});

test('accepts only the isolated project and exact demo volume identities', () => {
  const model = {
    name: 'settleflow-demo',
    volumes: Object.fromEntries(
      ['demo_postgres_data', 'demo_prometheus_data', 'demo_rabbitmq_data'].map((key) => [
        key,
        { name: `settleflow-demo_${key}` },
      ]),
    ),
  };
  assert.doesNotThrow(() => assertDemoComposeModel(model));
  assert.throws(
    () => assertDemoComposeModel({ ...model, name: 'settleflow' }),
    /demo_project_identity_unsafe/u,
  );
  assert.throws(
    () =>
      assertResetVolumes([
        { key: 'postgres_data', name: 'settleflow_postgres_data', project: 'settleflow' },
      ]),
    /demo_reset_target_unsafe/u,
  );
});

test('allows only bounded sanitized evidence fields and rejects secret-bearing additions', () => {
  assert.equal(assertSafeEvidenceManifest(evidence()).status, 'PASS');
  assert.throws(
    () => assertSafeEvidenceManifest({ ...evidence(), apiKey: 'sf_test_forbidden' }),
    /demo_evidence_shape_unsafe/u,
  );
  assert.throws(
    () =>
      assertSafeEvidenceManifest({
        ...evidence(),
        counts: { demoChecks: 1, endpointUrl: 'http://127.0.0.1' },
      }),
    /demo_evidence_field_forbidden/u,
  );
});

test('repeated invocation detects completed evidence and performs no orchestration', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'settleflow-demo-repeat-'));
  const previousMode = process.env.SETTLEFLOW_DEMO_MODE;
  const previousNodeEnvironment = process.env.NODE_ENV;
  try {
    const directory = resolve(root, '.settleflow', 'demo');
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'evidence.json'), `${JSON.stringify(evidence())}\n`, 'utf8');
    process.env.SETTLEFLOW_DEMO_MODE = 'true';
    process.env.NODE_ENV = 'development';
    await assert.doesNotReject(async () => {
      assert.deepEqual(await runDemo(root), { kind: 'already-complete' });
    });
  } finally {
    if (previousMode === undefined) delete process.env.SETTLEFLOW_DEMO_MODE;
    else process.env.SETTLEFLOW_DEMO_MODE = previousMode;
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
    rmSync(root, { force: true, recursive: true });
  }
});
