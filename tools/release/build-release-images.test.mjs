import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { RELEASE_IMAGE_TARGETS, releaseImageBuildCommands } from './build-release-images.mjs';

test('keeps the Compose model portable and applies attestations through Buildx', () => {
  const root = process.cwd();
  const source = readFileSync(resolve(root, 'compose.release.yaml'), 'utf8');
  assert.doesNotMatch(source, /^\s+(?:provenance|sbom):/mu);

  const commands = releaseImageBuildCommands(
    root,
    {
      SETTLEFLOW_IMAGE_CREATED: '2026-08-15T00:00:00.000Z',
      SETTLEFLOW_IMAGE_REVISION: 'a'.repeat(40),
      SETTLEFLOW_IMAGE_VERSION: '0.0.0-sim',
    },
    'settleflow-release-1234',
  );

  assert.deepEqual(commands.create, [
    'buildx',
    'create',
    '--driver',
    'docker-container',
    '--name',
    'settleflow-release-1234',
  ]);
  assert.deepEqual(commands.bootstrap, [
    'buildx',
    'inspect',
    '--builder',
    'settleflow-release-1234',
    '--bootstrap',
  ]);
  assert.deepEqual(commands.build, [
    'buildx',
    'bake',
    '--builder',
    'settleflow-release-1234',
    '--file',
    resolve(root, 'compose.release.yaml'),
    '--load',
    '--pull',
    '--provenance=mode=max',
    '--sbom=true',
    ...RELEASE_IMAGE_TARGETS,
  ]);
  assert.deepEqual(commands.cleanup, ['buildx', 'rm', 'settleflow-release-1234']);
  assert.ok(!commands.build.includes('--push'));
  assert.equal(commands.environment.SETTLEFLOW_IMAGE_VERSION, '0.0.0-sim');
});

test('fails closed for missing metadata or a mutable latest tag', () => {
  assert.throws(
    () => releaseImageBuildCommands(process.cwd(), {}, 'settleflow-release-1234'),
    /missing SETTLEFLOW_IMAGE_CREATED/u,
  );
  assert.throws(
    () =>
      releaseImageBuildCommands(
        process.cwd(),
        {
          SETTLEFLOW_IMAGE_CREATED: '2026-08-15T00:00:00.000Z',
          SETTLEFLOW_IMAGE_REVISION: 'a'.repeat(40),
          SETTLEFLOW_IMAGE_VERSION: 'latest',
        },
        'settleflow-release-1234',
      ),
    /must not use latest/u,
  );
  assert.throws(
    () =>
      releaseImageBuildCommands(
        process.cwd(),
        {
          SETTLEFLOW_IMAGE_CREATED: '2026-08-15T00:00:00.000Z',
          SETTLEFLOW_IMAGE_REVISION: 'a'.repeat(40),
          SETTLEFLOW_IMAGE_VERSION: '0.0.0-sim',
        },
        'unsafe',
      ),
    /builder name is invalid/u,
  );
});
