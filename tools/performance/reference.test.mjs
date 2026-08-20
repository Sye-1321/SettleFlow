import assert from 'node:assert/strict';
import { test } from 'node:test';

import { referenceInternals } from './reference.mjs';

test('persists only the minimum resumable k6 environment', () => {
  const environment = referenceInternals.baseK6Environment('synthetic-key', 'settlement_batch');
  assert.deepEqual(environment, {
    SETTLEFLOW_API_KEY: 'synthetic-key',
    SETTLEFLOW_BASE_URL: 'http://host.docker.internal:13000',
    SETTLEFLOW_RUN_ID: 'settlement_batch',
  });
  assert.equal(Object.hasOwn(environment, 'GITHUB_TOKEN'), false);
  assert.equal(Object.hasOwn(environment, 'PATH'), false);
});
