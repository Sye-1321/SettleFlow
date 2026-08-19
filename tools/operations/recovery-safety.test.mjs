import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { assertOutputLocation } from './backup.mjs';
import {
  assertBackupArtifact,
  assertBackupManifest,
  newBackupId,
  parseNamedArguments,
  POSTGRES_IMAGE,
  secureJsonWrite,
  sha256File,
  verifyBackupArtifact,
} from './recovery-safety.mjs';

function fixture(overrides = {}) {
  return {
    artifact: {
      bytes: 16,
      file: 'database.dump',
      format: 'postgresql-custom',
      noAcl: true,
      noOwner: true,
      sha256: 'a'.repeat(64),
    },
    backupId: 'bkp_20260819T120000000Z_abcdef123456',
    createdAt: '2026-08-19T12:00:01.000Z',
    dataCutoffAt: '2026-08-19T12:00:00.000Z',
    formatVersion: 1,
    kind: 'settleflow-postgresql-logical-backup',
    schema: {
      latestMigration: '20260803110000_settlement_ledger_reference_snapshot',
      migrationCount: 11,
    },
    source: {
      databaseName: 'settleflow_demo',
      environment: 'demo',
      projectName: 'settleflow-demo',
      releaseVersion: '0.0.0-demo',
      sourceCommit: 'b'.repeat(40),
    },
    status: 'COMPLETE',
    tools: {
      pgDumpVersion: 'pg_dump (PostgreSQL) 18.4 (Debian 18.4-1.pgdg13+1)',
      postgresImage: POSTGRES_IMAGE,
      serverVersion: '18.4 (Debian 18.4-1.pgdg13+1)',
    },
    ...overrides,
  };
}

test('accepts only the closed complete backup manifest contract', () => {
  assert.equal(assertBackupManifest(fixture()).status, 'COMPLETE');
  assert.throws(
    () => assertBackupManifest({ ...fixture(), credential: 'forbidden' }),
    /backup_manifest_shape_invalid/u,
  );
  assert.throws(
    () =>
      assertBackupManifest({
        ...fixture(),
        artifact: { ...fixture().artifact, sha256: 'short' },
      }),
    /backup_manifest_artifact_invalid/u,
  );
  assert.throws(
    () => assertBackupManifest({ ...fixture(), dataCutoffAt: '2026-08-20T00:00:00.000Z' }),
    /backup_manifest_time_invalid/u,
  );
});

test('requires explicit acknowledgement and an ignored in-repository output path', () => {
  const root = resolve(tmpdir(), newBackupId());
  mkdirSync(root, { recursive: true });
  try {
    assert.throws(
      () => assertOutputLocation(root, '.settleflow/recovery', false),
      /acknowledgement_required/u,
    );
    let inspected;
    const output = assertOutputLocation(
      root,
      '.settleflow/recovery',
      true,
      (_root, executable, arguments_) => {
        inspected = { arguments_, executable };
        return '';
      },
    );
    assert.equal(output, resolve(root, '.settleflow/recovery'));
    assert.equal(inspected.executable, 'git');
    assert.ok(inspected.arguments_.includes('check-ignore'));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('detects dump size and checksum corruption before restore', async () => {
  const directory = resolve(tmpdir(), newBackupId());
  mkdirSync(directory, { recursive: true });
  try {
    const dump = resolve(directory, 'database.dump');
    writeFileSync(dump, Buffer.from('0123456789abcdef'));
    const manifest = fixture({
      artifact: { ...fixture().artifact, sha256: await sha256File(dump) },
    });
    secureJsonWrite(resolve(directory, 'manifest.json'), manifest);
    assert.equal(assertBackupArtifact(resolve(directory, 'manifest.json'), manifest), dump);
    assert.equal(await verifyBackupArtifact(resolve(directory, 'manifest.json'), manifest), dump);
    writeFileSync(dump, Buffer.from('fedcba9876543210'));
    await assert.rejects(
      () => verifyBackupArtifact(resolve(directory, 'manifest.json'), manifest),
      /recovery_backup_checksum_mismatch/u,
    );
    writeFileSync(dump, Buffer.from('corrupt'));
    assert.throws(
      () => assertBackupArtifact(resolve(directory, 'manifest.json'), manifest),
      /backup_artifact_size_mismatch/u,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('parses named arguments without accepting duplicate or positional values', () => {
  assert.deepEqual(parseNamedArguments(['--source', 'demo', '--acknowledge-sensitive-storage']), {
    'acknowledge-sensitive-storage': true,
    source: 'demo',
  });
  assert.throws(() => parseNamedArguments(['demo']), /recovery_argument_invalid/u);
  assert.throws(
    () => parseNamedArguments(['--source', 'demo', '--source', 'release-simulation']),
    /recovery_argument_invalid/u,
  );
});
