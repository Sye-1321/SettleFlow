import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { RELEASE_IMAGE_TARGETS, releaseImageBuildInvocation } from './build-release-images.mjs';

test('keeps the Compose model portable and applies attestations through Buildx', () => {
  const root = process.cwd();
  const source = readFileSync(resolve(root, 'compose.release.yaml'), 'utf8');
  assert.doesNotMatch(source, /^\s+(?:provenance|sbom):/mu);

  const invocation = releaseImageBuildInvocation(root, {
    SETTLEFLOW_IMAGE_CREATED: '2026-08-15T00:00:00.000Z',
    SETTLEFLOW_IMAGE_REVISION: 'a'.repeat(40),
    SETTLEFLOW_IMAGE_VERSION: '0.0.0-sim',
  });

  assert.deepEqual(invocation.arguments, [
    'buildx',
    'bake',
    '--file',
    resolve(root, 'compose.release.yaml'),
    '--load',
    '--pull',
    '--provenance=mode=max',
    '--sbom=true',
    ...RELEASE_IMAGE_TARGETS,
  ]);
  assert.ok(!invocation.arguments.includes('--push'));
  assert.equal(invocation.environment.SETTLEFLOW_IMAGE_VERSION, '0.0.0-sim');
});

test('fails closed for missing metadata or a mutable latest tag', () => {
  assert.throws(
    () => releaseImageBuildInvocation(process.cwd(), {}),
    /missing SETTLEFLOW_IMAGE_CREATED/u,
  );
  assert.throws(
    () =>
      releaseImageBuildInvocation(process.cwd(), {
        SETTLEFLOW_IMAGE_CREATED: '2026-08-15T00:00:00.000Z',
        SETTLEFLOW_IMAGE_REVISION: 'a'.repeat(40),
        SETTLEFLOW_IMAGE_VERSION: 'latest',
      }),
    /must not use latest/u,
  );
});
