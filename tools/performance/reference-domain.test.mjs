import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { referenceDomainInternals } from './reference-domain.mjs';

test('runs fixture operations with a strict concurrency bound', async () => {
  let active = 0;
  let peak = 0;
  const observed = [];
  await referenceDomainInternals.runBounded(20, 3, async (index) => {
    active += 1;
    peak = Math.max(peak, active);
    observed.push(index);
    await setImmediate();
    active -= 1;
  });
  assert.equal(peak, 3);
  assert.deepEqual(
    observed.sort((left, right) => left - right),
    [...Array(20).keys()],
  );
});

test('accepts only explicit synthetic merchant codes', () => {
  assert.doesNotThrow(() => referenceDomainInternals.assertMerchantCode('demo_perf_reference'));
  for (const code of ['merchant', 'demo_', 'demo_UPPER', 'demo_bad-code']) {
    assert.throws(
      () => referenceDomainInternals.assertMerchantCode(code),
      /merchant_code_invalid/u,
    );
  }
});
