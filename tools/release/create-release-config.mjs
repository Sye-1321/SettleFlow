import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FILE_NAMES = [
  'api.env',
  'compose.env',
  'migrator.env',
  'postgres.env',
  'rabbitmq.env',
  'role-provisioner.env',
  'worker.env',
];

function serialize(environment) {
  return `${Object.entries(environment)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`;
}

function hasUnsafeControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

export function parseEnvironment(source, label) {
  const result = {};
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    if (rawLine.length === 0) continue;
    const separator = rawLine.indexOf('=');
    if (separator <= 0) throw new Error(`${label}:${index + 1} is not NAME=value`);
    const name = rawLine.slice(0, separator);
    const value = rawLine.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) throw new Error(`${label} has invalid key ${name}`);
    if (value.length === 0 || hasUnsafeControlCharacter(value)) {
      throw new Error(`${label} has an empty or unsafe ${name}`);
    }
    if (Object.hasOwn(result, name)) throw new Error(`${label} repeats ${name}`);
    result[name] = value;
  }
  return result;
}

function secureWrite(path, source) {
  writeFileSync(path, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function revision(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !/^[a-f\d]{40}\s*$/iu.test(result.stdout)) {
    throw new Error('Cannot determine the Git revision for OCI metadata');
  }
  return result.stdout.trim();
}

export function createReleaseConfiguration(root, outputDirectory) {
  if (existsSync(outputDirectory)) {
    checkReleaseConfiguration(outputDirectory);
    return { created: false, outputDirectory };
  }

  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(outputDirectory, 0o700);

  const ownerPassword = randomBytes(32).toString('base64url');
  const appPassword = randomBytes(32).toString('base64url');
  const rabbitPassword = randomBytes(32).toString('base64url');
  const webhookKey = randomBytes(32).toString('base64url');
  const imageRevision = revision(root);
  const imageVersion = '0.0.0-sim';
  const databaseName = 'settleflow';
  const ownerUser = 'settleflow';
  const appUser = 'settleflow_app';
  const rabbitUser = 'settleflow';
  const rabbitVhost = 'settleflow';
  const databaseUrl = `postgresql://${appUser}:${encodeURIComponent(appPassword)}@postgres:5432/${databaseName}`;
  const migrationDatabaseUrl = `postgresql://${ownerUser}:${encodeURIComponent(ownerPassword)}@postgres:5432/${databaseName}`;
  const rabbitUrl = `amqp://${rabbitUser}:${encodeURIComponent(rabbitPassword)}@rabbitmq:5672/${rabbitVhost}`;
  const commonRuntime = {
    DATABASE_URL: databaseUrl,
    DEPENDENCY_READINESS_TIMEOUT_MS: '2000',
    INTERNAL_TELEMETRY_ENABLED: 'true',
    INTERNAL_TELEMETRY_HOST: '0.0.0.0',
    NODE_ENV: 'development',
    OTEL_DEMO_TRACE_MODE: 'false',
    OTEL_TRACE_SAMPLE_RATIO: '0.1',
    OTEL_TRACING_ENABLED: 'false',
    RABBITMQ_URL: rabbitUrl,
    RELEASE_COMMIT: imageRevision,
    RELEASE_VERSION: imageVersion,
    SETTLEFLOW_DEPLOYMENT_MODE: 'release-simulation',
    WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS: '[]',
    WEBHOOK_KEYRING_PROVIDER: 'local',
    WEBHOOK_LOCAL_ACTIVE_KEY_ID: 'release-simulation-v1',
    WEBHOOK_LOCAL_KEYS_JSON: JSON.stringify({ 'release-simulation-v1': webhookKey }),
    WEBHOOK_URL_POLICY_MODE: 'production',
  };

  const files = {
    'api.env': serialize({
      ...commonRuntime,
      API_HOST: '0.0.0.0',
      API_PORT: '3000',
      DATABASE_MAX_CONNECTIONS: '30',
      INTERNAL_TELEMETRY_PORT: '9464',
    }),
    'compose.env': serialize({
      SETTLEFLOW_API_PORT: '3000',
      SETTLEFLOW_IMAGE_CREATED: new Date().toISOString(),
      SETTLEFLOW_IMAGE_REVISION: imageRevision,
      SETTLEFLOW_IMAGE_VERSION: imageVersion,
      SETTLEFLOW_PROMETHEUS_PORT: '9091',
    }),
    'migrator.env': serialize({
      MIGRATION_DATABASE_URL: migrationDatabaseUrl,
      POSTGRES_APP_USER: appUser,
      POSTGRES_DB: databaseName,
      POSTGRES_USER: ownerUser,
    }),
    'postgres.env': serialize({
      POSTGRES_DB: databaseName,
      POSTGRES_PASSWORD: ownerPassword,
      POSTGRES_USER: ownerUser,
    }),
    'rabbitmq.env': serialize({
      RABBITMQ_DEFAULT_PASS: rabbitPassword,
      RABBITMQ_DEFAULT_USER: rabbitUser,
      RABBITMQ_DEFAULT_VHOST: rabbitVhost,
    }),
    'role-provisioner.env': serialize({
      PGDATABASE: databaseName,
      PGHOST: 'postgres',
      PGPASSWORD: ownerPassword,
      PGPORT: '5432',
      PGUSER: ownerUser,
      POSTGRES_APP_PASSWORD: appPassword,
      POSTGRES_DB: databaseName,
    }),
    'worker.env': serialize({
      ...commonRuntime,
      INTERNAL_TELEMETRY_PORT: '9465',
      WORKER_HEARTBEAT_INTERVAL_MS: '30000',
    }),
  };

  for (const fileName of FILE_NAMES)
    secureWrite(resolve(outputDirectory, fileName), files[fileName]);
  checkReleaseConfiguration(outputDirectory);
  return { created: true, outputDirectory };
}

export function checkReleaseConfiguration(outputDirectory) {
  const parsed = {};
  for (const fileName of FILE_NAMES) {
    const path = resolve(outputDirectory, fileName);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing ${fileName}`);
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
      throw new Error(`${fileName} must not be group/world accessible`);
    }
    const source = readFileSync(path, 'utf8');
    if (/replace|placeholder|changeme/iu.test(source))
      throw new Error(`${fileName} contains a placeholder`);
    parsed[fileName] = parseEnvironment(source, fileName);
  }

  const api = parsed['api.env'];
  const worker = parsed['worker.env'];
  const postgres = parsed['postgres.env'];
  const role = parsed['role-provisioner.env'];
  const migrator = parsed['migrator.env'];
  const rabbit = parsed['rabbitmq.env'];
  for (const runtime of [api, worker]) {
    if (
      runtime.NODE_ENV !== 'development' ||
      runtime.SETTLEFLOW_DEPLOYMENT_MODE !== 'release-simulation'
    ) {
      throw new Error('Release-simulation runtime must remain explicitly non-production');
    }
    if (runtime.INTERNAL_TELEMETRY_HOST !== '0.0.0.0')
      throw new Error('Container probes must bind internally');
    if (runtime.WEBHOOK_URL_POLICY_MODE !== 'production')
      throw new Error('Release URL policy must be production-safe');
    if (runtime.DATABASE_URL.includes(postgres.POSTGRES_PASSWORD))
      throw new Error('Owner credential leaked to runtime');
  }
  if (postgres.POSTGRES_PASSWORD !== role.PGPASSWORD)
    throw new Error('Provisioner owner credential mismatch');
  if (!api.DATABASE_URL.includes(encodeURIComponent(role.POSTGRES_APP_PASSWORD))) {
    throw new Error('API runtime credential mismatch');
  }
  if (api.DATABASE_URL !== worker.DATABASE_URL || api.RABBITMQ_URL !== worker.RABBITMQ_URL) {
    throw new Error('API and worker dependency identities differ');
  }
  if (!migrator.MIGRATION_DATABASE_URL.includes(encodeURIComponent(postgres.POSTGRES_PASSWORD))) {
    throw new Error('Migration owner credential mismatch');
  }
  if (!api.RABBITMQ_URL.includes(encodeURIComponent(rabbit.RABBITMQ_DEFAULT_PASS))) {
    throw new Error('RabbitMQ runtime credential mismatch');
  }
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.cwd();
  const outputDirectory = resolve(root, '.settleflow/release-simulation');
  const mode = process.argv[2];
  if (mode === 'create') {
    const result = createReleaseConfiguration(root, outputDirectory);
    process.stdout.write(
      result.created
        ? `Created ignored release-simulation configuration in ${outputDirectory}.\n`
        : `Existing release-simulation configuration is valid in ${outputDirectory}.\n`,
    );
  } else if (mode === 'check') {
    checkReleaseConfiguration(outputDirectory);
    process.stdout.write('Release-simulation configuration is complete and safe.\n');
  } else {
    throw new Error('Expected mode: create or check');
  }
}
