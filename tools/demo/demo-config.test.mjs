import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  checkDemoConfiguration,
  createDemoConfiguration,
  hostRuntimeDatabaseUrl,
} from './demo-config.mjs';

test('creates isolated ignored configuration without sharing owner credentials', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'settleflow-demo-config-'));
  try {
    const directory = resolve(root, 'demo');
    const configuration = createDemoConfiguration(root, directory, {
      apiPort: 13_000,
      createdAt: '2026-08-12T00:00:00.000Z',
      imageVersion: 'v1.0.0-rc.1',
      postgresPort: 55_432,
      prometheusPort: 19_090,
      receiverPort: 18_080,
      revision: 'a'.repeat(40),
    });
    assert.deepEqual(checkDemoConfiguration(directory), configuration);
    assert.match(hostRuntimeDatabaseUrl(configuration), /127\.0\.0\.1:55432\/settleflow_demo$/u);
    assert.ok(
      !configuration['api.env'].DATABASE_URL.includes(
        configuration['postgres.env'].POSTGRES_PASSWORD,
      ),
    );
    assert.equal(configuration['api.env'].SETTLEFLOW_DEMO_MODE, 'true');
    assert.equal(configuration['api.env'].RELEASE_VERSION, 'v1.0.0-rc.1');
    assert.equal(configuration['compose.env'].SETTLEFLOW_IMAGE_VERSION, 'v1.0.0-rc.1');
    assert.equal(configuration['api.env'].WEBHOOK_URL_POLICY_MODE, 'development');
    assert.equal(
      configuration['api.env'].WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS,
      '["http://demo-webhook-receiver:18080"]',
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
