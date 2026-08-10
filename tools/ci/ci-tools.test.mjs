import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidence } from './create-release-evidence.mjs';
import { integrationCommandArguments, integrationRuns } from './run-repeated-integration.mjs';

test('scheduled concurrency evidence is exactly three non-retry runs', () => {
  const runs = integrationRuns('concurrency', 3);
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((run) => run.index),
    [1, 2, 3],
  );
  assert.ok(
    runs.every((run) => run.files.includes('test/integration/payment-intents.int-spec.ts')),
  );
  assert.throws(() => integrationRuns('concurrency', 4), /one through three/u);
  assert.deepEqual(integrationCommandArguments(runs[0]).slice(0, 2), [
    'test:integration',
    '--runTestsByPath',
  ]);
  assert.equal(integrationCommandArguments(runs[0]).includes('--'), false);
});

test('release evidence contains only bounded image and toolchain metadata', () => {
  const evidence = createEvidence({
    configuration: {
      'compose.env': {
        SETTLEFLOW_IMAGE_CREATED: '2026-08-10T00:00:00.000Z',
        SETTLEFLOW_IMAGE_VERSION: '0.0.0-sim',
      },
    },
    imageSecuritySummary: {
      file: 'image-security-summary.json',
      sha256: 'b'.repeat(64),
    },
    images: [{ imageId: 'sha256:abc', name: 'api' }],
    revision: 'a'.repeat(40),
    toolModel: {
      tools: { scanner: { image: 'scanner:v1.0.0@sha256:abc' } },
    },
  });
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.images[0].name, 'api');
  assert.deepEqual(Object.keys(evidence.toolchain).sort(), ['node', 'pnpm', 'scanners']);
  assert.equal(JSON.stringify(evidence).includes('PASSWORD'), false);
});
