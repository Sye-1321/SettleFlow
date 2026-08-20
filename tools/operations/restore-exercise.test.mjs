import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { assertRecoveryComposeModel, createRecoveryConfiguration } from './restore-exercise.mjs';
import {
  newBackupId,
  POSTGRES_IMAGE,
  RABBITMQ_IMAGE,
  RECOVERY_PROJECT_PREFIX,
  secureDirectory,
} from './recovery-safety.mjs';
import { expectedMigrations, verificationQueries } from './verify-restored-database.mjs';

const keyring = {
  WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS: '[]',
  WEBHOOK_KEYRING_PROVIDER: 'local',
  WEBHOOK_LOCAL_ACTIVE_KEY_ID: 'recovery-test-v1',
  WEBHOOK_LOCAL_KEYS_JSON: JSON.stringify({ 'recovery-test-v1': 'a'.repeat(43) }),
  WEBHOOK_URL_POLICY_MODE: 'production',
};

test('generates isolated credentials and withholds the owner URL from runtimes', () => {
  const workspace = secureDirectory(resolve(tmpdir(), newBackupId()));
  try {
    const result = createRecoveryConfiguration(workspace, {
      apiPort: 14_000,
      dumpPath: resolve(workspace, 'database.dump'),
      imageVersion: '0.0.0-sim',
      keyring,
      revision: 'a'.repeat(40),
    });
    assert.equal(result.files['api.env'].SETTLEFLOW_RECOVERY_MODE, 'true');
    assert.equal(result.files['api.env'].DATABASE_MAX_CONNECTIONS, '30');
    assert.equal(result.files['worker.env'].DATABASE_URL, result.files['api.env'].DATABASE_URL);
    assert.notEqual(
      result.files['api.env'].DATABASE_URL,
      result.files['migrator.env'].MIGRATION_DATABASE_URL,
    );
    const ownerPassword = result.files['postgres.env'].POSTGRES_PASSWORD;
    assert.ok(
      !readFileSync(resolve(result.configDirectory, 'api.env'), 'utf8').includes(ownerPassword),
    );
    assert.ok(
      !readFileSync(resolve(result.configDirectory, 'worker.env'), 'utf8').includes(ownerPassword),
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

function composeFixture(project, dumpPath) {
  const secure = {
    cap_drop: ['ALL'],
    read_only: true,
    security_opt: ['no-new-privileges:true'],
    user: '10001:10001',
  };
  return {
    name: project,
    networks: { backend: { internal: true } },
    services: {
      api: {
        ...secure,
        depends_on: { 'recovery-verifier': { condition: 'service_completed_successfully' } },
        environment: { DATABASE_URL: 'runtime' },
        ports: [{ host_ip: '127.0.0.1', published: '14000', target: 3000 }],
      },
      'grant-provisioner': {
        depends_on: { restorer: { condition: 'service_completed_successfully' } },
      },
      migrator: {
        ...secure,
        depends_on: { 'grant-provisioner': { condition: 'service_completed_successfully' } },
      },
      postgres: { image: POSTGRES_IMAGE },
      rabbitmq: { image: RABBITMQ_IMAGE },
      'recovery-verifier': {
        ...secure,
        depends_on: { migrator: { condition: 'service_completed_successfully' } },
        volumes: [
          {
            read_only: true,
            source: resolve(process.cwd(), 'tools/operations/verify-restored-database.mjs'),
            target: '/app/tools/operations/verify-restored-database.mjs',
            type: 'bind',
          },
        ],
      },
      restorer: {
        command: ['--exit-on-error', '--no-owner', '--no-acl', '--single-transaction'],
        depends_on: { 'role-provisioner': { condition: 'service_completed_successfully' } },
        image: POSTGRES_IMAGE,
        volumes: [
          { read_only: true, source: dumpPath, target: '/backup/database.dump', type: 'bind' },
        ],
      },
      worker: {
        ...secure,
        depends_on: { 'recovery-verifier': { condition: 'service_completed_successfully' } },
        environment: { DATABASE_URL: 'runtime' },
      },
    },
    volumes: {
      recovery_postgres_data: { name: `${project}_recovery_postgres_data` },
      recovery_rabbitmq_data: { name: `${project}_recovery_rabbitmq_data` },
    },
  };
}

test('accepts only isolated topology and the fail-closed restore sequence', () => {
  const project = `${RECOVERY_PROJECT_PREFIX}abcdef123456`;
  const dumpPath = resolve(tmpdir(), 'database.dump');
  const model = composeFixture(project, dumpPath);
  assert.equal(assertRecoveryComposeModel(model, project, dumpPath), model);
  assert.throws(
    () =>
      assertRecoveryComposeModel(
        {
          ...model,
          services: { ...model.services, postgres: { ...model.services.postgres, ports: [5432] } },
        },
        project,
        dumpPath,
      ),
    /recovery_port_boundary_unsafe/u,
  );
  assert.throws(
    () =>
      assertRecoveryComposeModel(
        {
          ...model,
          services: {
            ...model.services,
            migrator: { ...model.services.migrator, depends_on: {} },
          },
        },
        project,
        dumpPath,
      ),
    /recovery_startup_sequence_invalid/u,
  );
});

test('recovery database checks are read-only and cover the committed history', () => {
  assert.equal(expectedMigrations(process.cwd()).length, 11);
  for (const sql of Object.values(verificationQueries)) {
    assert.match(sql, /SELECT/iu);
    assert.doesNotMatch(sql, /\b(?:DELETE|INSERT|TRUNCATE|UPDATE)\s+(?:INTO|FROM|TABLE|[a-z_])/iu);
  }
});
