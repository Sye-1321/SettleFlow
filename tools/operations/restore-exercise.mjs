import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { parseEnvironment } from '../release/create-release-config.mjs';
import {
  assertExactArguments,
  newRecoveryProject,
  parseNamedArguments,
  POSTGRES_IMAGE,
  RABBITMQ_IMAGE,
  readBackupManifest,
  RECOVERY_PROJECT_PREFIX,
  secureDirectory,
  secureJsonWrite,
  secureTextWrite,
  serializeEnvironment,
  verifyBackupArtifact,
} from './recovery-safety.mjs';

const API_PORT = 14_000;
const CONFIG_FILES = [
  'api.env',
  'migrator.env',
  'postgres.env',
  'rabbitmq.env',
  'restore.env',
  'role-provisioner.env',
  'verifier.env',
  'worker.env',
];

function execute(root, executable, arguments_, errorCode, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) throw new Error(errorCode);
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

function gitRevision(root) {
  const revision = execute(
    root,
    'git',
    ['rev-parse', 'HEAD'],
    'recovery_source_revision_unavailable',
  );
  if (!/^[a-f\d]{40}$/u.test(revision)) throw new Error('recovery_source_revision_invalid');
  return revision;
}

function readKeyring(path) {
  const environment = parseEnvironment(readFileSync(path, 'utf8'), 'keyring environment');
  if (
    environment.WEBHOOK_KEYRING_PROVIDER !== 'local' ||
    typeof environment.WEBHOOK_LOCAL_ACTIVE_KEY_ID !== 'string' ||
    typeof environment.WEBHOOK_LOCAL_KEYS_JSON !== 'string' ||
    typeof environment.WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS !== 'string' ||
    !['development', 'production'].includes(environment.WEBHOOK_URL_POLICY_MODE)
  ) {
    throw new Error('recovery_keyring_configuration_invalid');
  }
  const keys = JSON.parse(environment.WEBHOOK_LOCAL_KEYS_JSON);
  if (
    typeof keys !== 'object' ||
    keys === null ||
    Array.isArray(keys) ||
    typeof keys[environment.WEBHOOK_LOCAL_ACTIVE_KEY_ID] !== 'string'
  ) {
    throw new Error('recovery_keyring_configuration_invalid');
  }
  JSON.parse(environment.WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS);
  return {
    WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS: environment.WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS,
    WEBHOOK_KEYRING_PROVIDER: 'local',
    WEBHOOK_LOCAL_ACTIVE_KEY_ID: environment.WEBHOOK_LOCAL_ACTIVE_KEY_ID,
    WEBHOOK_LOCAL_KEYS_JSON: environment.WEBHOOK_LOCAL_KEYS_JSON,
    WEBHOOK_URL_POLICY_MODE: environment.WEBHOOK_URL_POLICY_MODE,
  };
}

function secureConfigurationWrite(directory, fileName, model) {
  secureTextWrite(resolve(directory, fileName), serializeEnvironment(model));
}

export function createRecoveryConfiguration(workspace, options) {
  const configDirectory = secureDirectory(resolve(workspace, 'config'));
  const ownerPassword = randomBytes(32).toString('base64url');
  const appPassword = randomBytes(32).toString('base64url');
  const rabbitPassword = randomBytes(32).toString('base64url');
  const databaseName = 'settleflow';
  const owner = 'settleflow';
  const appUser = 'settleflow_app';
  const databaseUrl = `postgresql://${appUser}:${encodeURIComponent(appPassword)}@postgres:5432/${databaseName}`;
  const migrationUrl = `postgresql://${owner}:${encodeURIComponent(ownerPassword)}@postgres:5432/${databaseName}`;
  const rabbitUrl = `amqp://settleflow:${encodeURIComponent(rabbitPassword)}@rabbitmq:5672/settleflow_recovery`;
  const common = {
    DATABASE_URL: databaseUrl,
    DEPENDENCY_READINESS_TIMEOUT_MS: '2000',
    INTERNAL_TELEMETRY_ENABLED: 'true',
    INTERNAL_TELEMETRY_HOST: '0.0.0.0',
    NODE_ENV: 'development',
    OTEL_DEMO_TRACE_MODE: 'false',
    OTEL_TRACE_SAMPLE_RATIO: '0.1',
    OTEL_TRACING_ENABLED: 'false',
    RABBITMQ_URL: rabbitUrl,
    RELEASE_COMMIT: options.revision,
    RELEASE_VERSION: options.imageVersion,
    SETTLEFLOW_DEPLOYMENT_MODE: 'release-simulation',
    SETTLEFLOW_RECOVERY_MODE: 'true',
    ...options.keyring,
  };
  const files = {
    'api.env': {
      ...common,
      API_HOST: '0.0.0.0',
      API_PORT: '3000',
      INTERNAL_TELEMETRY_PORT: '9464',
    },
    'migrator.env': {
      MIGRATION_DATABASE_URL: migrationUrl,
      POSTGRES_APP_USER: appUser,
      POSTGRES_DB: databaseName,
      POSTGRES_USER: owner,
    },
    'postgres.env': {
      POSTGRES_DB: databaseName,
      POSTGRES_PASSWORD: ownerPassword,
      POSTGRES_USER: owner,
    },
    'rabbitmq.env': {
      RABBITMQ_DEFAULT_PASS: rabbitPassword,
      RABBITMQ_DEFAULT_USER: 'settleflow',
      RABBITMQ_DEFAULT_VHOST: 'settleflow_recovery',
    },
    'restore.env': {
      PGDATABASE: databaseName,
      PGHOST: 'postgres',
      PGPASSWORD: ownerPassword,
      PGPORT: '5432',
      PGUSER: owner,
    },
    'role-provisioner.env': {
      PGDATABASE: databaseName,
      PGHOST: 'postgres',
      PGPASSWORD: ownerPassword,
      PGPORT: '5432',
      PGUSER: owner,
      POSTGRES_APP_PASSWORD: appPassword,
      POSTGRES_DB: databaseName,
    },
    'verifier.env': {
      MIGRATION_DATABASE_URL: migrationUrl,
      POSTGRES_APP_USER: appUser,
      POSTGRES_DB: databaseName,
      POSTGRES_USER: owner,
      SETTLEFLOW_RECOVERY_MODE: 'true',
    },
    'worker.env': {
      ...common,
      INTERNAL_TELEMETRY_PORT: '9465',
      WORKER_HEARTBEAT_INTERVAL_MS: '30000',
    },
  };
  for (const fileName of CONFIG_FILES)
    secureConfigurationWrite(configDirectory, fileName, files[fileName]);
  const composeEnvironment = {
    SETTLEFLOW_RECOVERY_API_PORT: String(options.apiPort),
    SETTLEFLOW_RECOVERY_CONFIG_DIR: configDirectory.replaceAll('\\', '/'),
    SETTLEFLOW_RECOVERY_DUMP_PATH: options.dumpPath.replaceAll('\\', '/'),
    SETTLEFLOW_RECOVERY_IMAGE_VERSION: options.imageVersion,
  };
  secureConfigurationWrite(workspace, 'compose.env', composeEnvironment);
  return { composeEnvironment, configDirectory, files };
}

function composeArguments(root, project, workspace, arguments_) {
  return [
    'compose',
    '--project-name',
    project,
    '--env-file',
    resolve(workspace, 'compose.env'),
    '--file',
    resolve(root, 'compose.recovery.yaml'),
    ...arguments_,
  ];
}

export function assertRecoveryComposeModel(model, project, expectedDumpPath) {
  if (!project.startsWith(RECOVERY_PROJECT_PREFIX) || model?.name !== project) {
    throw new Error('recovery_project_identity_invalid');
  }
  const services = model.services ?? {};
  if (model.networks?.backend?.internal !== true) throw new Error('recovery_network_unsafe');
  for (const name of ['postgres', 'rabbitmq', 'worker']) {
    if ((services[name]?.ports ?? []).length !== 0)
      throw new Error('recovery_port_boundary_unsafe');
  }
  if (services.api?.ports?.length !== 1 || services.api.ports[0].host_ip !== '127.0.0.1') {
    throw new Error('recovery_port_boundary_unsafe');
  }
  for (const name of ['api', 'worker', 'migrator', 'recovery-verifier']) {
    const service = services[name];
    if (
      service?.user !== '10001:10001' ||
      service.read_only !== true ||
      !service.cap_drop?.includes('ALL') ||
      !service.security_opt?.includes('no-new-privileges:true')
    ) {
      throw new Error('recovery_runtime_security_unsafe');
    }
  }
  if (
    services.postgres?.image !== POSTGRES_IMAGE ||
    services.rabbitmq?.image !== RABBITMQ_IMAGE ||
    services.restorer?.image !== POSTGRES_IMAGE
  ) {
    throw new Error('recovery_dependency_image_unpinned');
  }
  const dumpMount = services.restorer?.volumes?.find(
    (volume) => volume.target === '/backup/database.dump',
  );
  if (
    dumpMount?.type !== 'bind' ||
    resolve(dumpMount.source) !== resolve(expectedDumpPath) ||
    dumpMount.read_only !== true
  ) {
    throw new Error('recovery_dump_mount_unsafe');
  }
  const verifierMount = services['recovery-verifier']?.volumes?.find(
    (volume) => volume.target === '/app/tools/operations/verify-restored-database.mjs',
  );
  if (verifierMount?.type !== 'bind' || verifierMount.read_only !== true) {
    throw new Error('recovery_verifier_mount_unsafe');
  }
  const restoreCommand = services.restorer?.command ?? [];
  for (const argument of ['--exit-on-error', '--no-owner', '--no-acl', '--single-transaction']) {
    if (!restoreCommand.includes(argument)) throw new Error('recovery_restore_command_unsafe');
  }
  if (
    services.restorer?.depends_on?.['role-provisioner']?.condition !==
      'service_completed_successfully' ||
    services['grant-provisioner']?.depends_on?.restorer?.condition !==
      'service_completed_successfully' ||
    services.migrator?.depends_on?.['grant-provisioner']?.condition !==
      'service_completed_successfully' ||
    services['recovery-verifier']?.depends_on?.migrator?.condition !==
      'service_completed_successfully' ||
    services.api?.depends_on?.['recovery-verifier']?.condition !==
      'service_completed_successfully' ||
    services.worker?.depends_on?.['recovery-verifier']?.condition !==
      'service_completed_successfully'
  ) {
    throw new Error('recovery_startup_sequence_invalid');
  }
  for (const name of ['api', 'worker']) {
    if (
      Object.hasOwn(services[name].environment ?? {}, 'MIGRATION_DATABASE_URL') ||
      Object.hasOwn(services[name].environment ?? {}, 'POSTGRES_PASSWORD')
    ) {
      throw new Error('recovery_owner_credential_leaked');
    }
  }
  for (const volume of Object.values(model.volumes ?? {})) {
    if (!String(volume.name ?? '').startsWith(`${project}_`)) {
      throw new Error('recovery_volume_identity_invalid');
    }
  }
  return model;
}

function inspectImages(root, imageVersion, revision) {
  for (const name of ['api', 'worker', 'migrator']) {
    const source = execute(
      root,
      'docker',
      [
        'image',
        'inspect',
        `settleflow-${name}:${imageVersion}`,
        '--format',
        '{{json .Config.Labels}}',
      ],
      'recovery_image_unavailable',
    );
    const labels = JSON.parse(source);
    if (
      labels?.['org.opencontainers.image.revision'] !== revision ||
      labels?.['org.opencontainers.image.version'] !== imageVersion
    ) {
      throw new Error('recovery_image_metadata_mismatch');
    }
  }
}

async function waitForApi(port) {
  for (const path of ['/health/live', '/health/ready']) {
    const response = await globalThis.fetch(`http://127.0.0.1:${port}${path}`, {
      signal: globalThis.AbortSignal.timeout(5_000),
    });
    if (response.status !== 200) throw new Error('recovery_api_smoke_failed');
  }
}

function assertProjectAbsent(root, project) {
  const containers = execute(
    root,
    'docker',
    ['ps', '--all', '--filter', `label=com.docker.compose.project=${project}`, '--quiet'],
    'recovery_project_inspection_failed',
  );
  const volumes = execute(
    root,
    'docker',
    ['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--quiet'],
    'recovery_project_inspection_failed',
  );
  if (containers !== '' || volumes !== '') throw new Error('recovery_project_not_fresh');
}

function cleanup(root, project, workspace) {
  if (!project.startsWith(RECOVERY_PROJECT_PREFIX)) throw new Error('recovery_cleanup_refused');
  execute(
    root,
    'docker',
    composeArguments(root, project, workspace, ['down', '--volumes', '--remove-orphans']),
    'recovery_cleanup_failed',
  );
  assertProjectAbsent(root, project);
}

function removeSuccessfulConfiguration(root, project, workspace) {
  const expected = resolve(root, '.settleflow/recovery/exercises', project);
  if (resolve(workspace) !== expected || !project.startsWith(RECOVERY_PROJECT_PREFIX)) {
    throw new Error('recovery_configuration_cleanup_refused');
  }
  rmSync(resolve(workspace, 'config'), { force: true, recursive: true });
  rmSync(resolve(workspace, 'compose.env'), { force: true });
}

function safeToolVersion(root, arguments_, errorCode) {
  return execute(root, arguments_[0], arguments_.slice(1), errorCode)
    .split(/\r?\n/u)[0]
    .slice(0, 160);
}

export async function exerciseRestore(root, options) {
  const manifestPath = resolve(root, options.manifestPath);
  const manifest = readBackupManifest(manifestPath);
  if (
    manifest.source.sourceCommit !== options.expectedSourceCommit ||
    manifest.source.releaseVersion !== options.expectedSourceVersion
  ) {
    throw new Error('recovery_expected_source_metadata_mismatch');
  }
  const dumpPath = await verifyBackupArtifact(manifestPath, manifest);
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(options.imageVersion) || options.imageVersion === 'latest') {
    throw new Error('recovery_image_version_invalid');
  }
  if (!existsSync(options.keyringPath)) throw new Error('recovery_keyring_file_missing');
  const keyring = readKeyring(options.keyringPath);
  const revision = gitRevision(root);
  inspectImages(root, options.imageVersion, revision);
  const project = newRecoveryProject();
  const workspace = secureDirectory(resolve(root, '.settleflow/recovery/exercises', project));
  createRecoveryConfiguration(workspace, {
    apiPort: options.apiPort,
    dumpPath,
    imageVersion: options.imageVersion,
    keyring,
    revision,
  });
  const rendered = execute(
    root,
    'docker',
    composeArguments(root, project, workspace, ['config', '--format', 'json']),
    'recovery_compose_invalid',
  );
  assertRecoveryComposeModel(JSON.parse(rendered), project, dumpPath);
  assertProjectAbsent(root, project);
  const startedAt = new Date();
  let clean = false;
  try {
    execute(
      root,
      'docker',
      composeArguments(root, project, workspace, [
        'up',
        '--detach',
        '--wait',
        '--wait-timeout',
        '300',
      ]),
      'recovery_startup_failed',
    );
    await waitForApi(options.apiPort);
    const workerStatus = execute(
      root,
      'docker',
      composeArguments(root, project, workspace, [
        'exec',
        '-T',
        'worker',
        '/nodejs/bin/node',
        '-e',
        "fetch('http://127.0.0.1:9465/health/ready').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('0'))",
      ]),
      'recovery_worker_smoke_failed',
    );
    if (workerStatus !== '200') throw new Error('recovery_worker_smoke_failed');
    execute(
      root,
      'docker',
      composeArguments(root, project, workspace, ['run', '--rm', '--no-deps', 'recovery-verifier']),
      'recovery_post_start_verification_failed',
    );
    const completedAt = new Date();
    const restoreSeconds = Math.ceil((completedAt.getTime() - startedAt.getTime()) / 1000);
    const simulatedRpoSeconds = Math.max(
      0,
      Math.ceil((startedAt.getTime() - Date.parse(manifest.dataCutoffAt)) / 1000),
    );
    const evidence = {
      backupAgeSeconds: Math.max(
        0,
        Math.ceil((startedAt.getTime() - Date.parse(manifest.createdAt)) / 1000),
      ),
      backupId: manifest.backupId,
      brokerRecovery: 'TOPOLOGY_ONLY_NO_MESSAGE_BACKUP',
      checks: [
        'CHECKSUM_AND_METADATA',
        'FRESH_ISOLATED_TARGET',
        'ROLE_PROVISIONING',
        'LOGICAL_RESTORE',
        'MIGRATION_AND_INVARIANTS',
        'API_READINESS',
        'WORKER_READINESS',
        'POST_START_INVARIANTS',
      ],
      completedAt: completedAt.toISOString(),
      formatVersion: 1,
      migrationCount: manifest.schema.migrationCount,
      restoreSeconds,
      rpoClaim: 'NOT_CLAIMED_ONE_OFF_EXERCISE',
      rpoTargetSeconds: 900,
      rtoResult: restoreSeconds <= 3600 ? 'PASS' : 'FAIL',
      rtoTargetSeconds: 3600,
      simulatedRpoSeconds,
      sourceCommit: manifest.source.sourceCommit,
      sourceReleaseVersion: manifest.source.releaseVersion,
      startedAt: startedAt.toISOString(),
      status: 'PASS',
      toolVersions: {
        compose: safeToolVersion(
          root,
          ['docker', 'compose', 'version'],
          'recovery_tool_version_failed',
        ),
        docker: safeToolVersion(
          root,
          ['docker', 'version', '--format', '{{.Server.Version}}'],
          'recovery_tool_version_failed',
        ),
        node: process.version,
        pgDump: manifest.tools.pgDumpVersion,
        postgresServer: manifest.tools.serverVersion,
      },
    };
    secureJsonWrite(resolve(workspace, 'evidence.json'), evidence);
    cleanup(root, project, workspace);
    removeSuccessfulConfiguration(root, project, workspace);
    clean = true;
    return { evidence, evidencePath: resolve(workspace, 'evidence.json') };
  } finally {
    if (!clean) {
      try {
        cleanup(root, project, workspace);
      } catch {
        // Preserve the original failure code. The runbook covers explicit residual cleanup.
      }
    }
  }
}

async function main() {
  const arguments_ = parseNamedArguments(process.argv.slice(2));
  assertExactArguments(
    arguments_,
    [
      'api-port',
      'expected-source-commit',
      'expected-source-version',
      'image-version',
      'keyring-env-file',
      'manifest',
    ],
    [
      'expected-source-commit',
      'expected-source-version',
      'image-version',
      'keyring-env-file',
      'manifest',
    ],
  );
  const apiPort = arguments_['api-port'] === undefined ? API_PORT : Number(arguments_['api-port']);
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65_535) {
    throw new Error('recovery_api_port_invalid');
  }
  const result = await exerciseRestore(process.cwd(), {
    apiPort,
    expectedSourceCommit: arguments_['expected-source-commit'],
    expectedSourceVersion: arguments_['expected-source-version'],
    imageVersion: arguments_['image-version'],
    keyringPath: resolve(process.cwd(), arguments_['keyring-env-file']),
    manifestPath: arguments_.manifest,
  });
  process.stdout.write(
    `PASS: isolated PostgreSQL recovery completed in ${result.evidence.restoreSeconds}s; evidence is ${result.evidencePath}. RPO remains unclaimed until a 15-minute schedule is evidenced.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : 'recovery_unexpected_failure'}\n`,
    );
    process.exitCode = 1;
  });
}
