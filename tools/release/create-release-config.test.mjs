import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  checkReleaseConfiguration,
  createReleaseConfiguration,
  parseEnvironment,
} from './create-release-config.mjs';

test('rejects control characters in generated-style environment values', () => {
  assert.throws(
    () => parseEnvironment(`SAFE=before${String.fromCharCode(1)}after\n`, 'test.env'),
    /unsafe SAFE/u,
  );
});

test('creates a complete ignored-style configuration without sharing owner credentials', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'settleflow-release-config-'));
  try {
    const result = createReleaseConfiguration(
      process.cwd(),
      resolve(directory, 'release-simulation'),
    );
    assert.equal(result.created, true);
    const parsed = checkReleaseConfiguration(result.outputDirectory);
    assert.equal(parsed['api.env'].NODE_ENV, 'development');
    assert.equal(parsed['api.env'].SETTLEFLOW_DEPLOYMENT_MODE, 'release-simulation');
    assert.equal(parsed['api.env'].INTERNAL_TELEMETRY_HOST, '0.0.0.0');
    assert.doesNotMatch(parsed['api.env'].DATABASE_URL, /settleflow:@/u);
    assert.ok(
      !readFileSync(resolve(result.outputDirectory, 'api.env'), 'utf8').includes(
        parsed['postgres.env'].POSTGRES_PASSWORD,
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fails closed for an incomplete or placeholder configuration', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'settleflow-release-config-'));
  try {
    const output = resolve(directory, 'release-simulation');
    createReleaseConfiguration(process.cwd(), output);
    writeFileSync(resolve(output, 'api.env'), 'NODE_ENV=placeholder\n', 'utf8');
    assert.throws(() => checkReleaseConfiguration(output), /placeholder/u);
    assert.throws(() => createReleaseConfiguration(process.cwd(), output), /placeholder/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
