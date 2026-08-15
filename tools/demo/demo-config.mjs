import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { DEMO_DATABASE_NAME } from './demo-safety.mjs';

const FILES = [
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

export function parseEnvironment(source, label) {
  const result = {};
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    if (rawLine === '') continue;
    const separator = rawLine.indexOf('=');
    if (separator <= 0) throw new Error(`${label}:${index + 1} is invalid`);
    const name = rawLine.slice(0, separator);
    const value = rawLine.slice(separator + 1);
    const containsControlCharacter = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || value === '' || containsControlCharacter) {
      throw new Error(`${label} contains unsafe configuration`);
    }
    if (Object.hasOwn(result, name)) throw new Error(`${label} repeats a setting`);
    result[name] = value;
  }
  return result;
}

function secureWrite(path, source) {
  writeFileSync(path, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

export function createDemoConfiguration(_root, outputDirectory, options) {
  if (existsSync(outputDirectory)) return checkDemoConfiguration(outputDirectory);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(outputDirectory, 0o700);

  const ownerPassword = randomBytes(32).toString('base64url');
  const appPassword = randomBytes(32).toString('base64url');
  const rabbitPassword = randomBytes(32).toString('base64url');
  const webhookKey = randomBytes(32).toString('base64url');
  const ownerUser = 'settleflow';
  const appUser = 'settleflow_app';
  const rabbitUser = 'settleflow';
  const containerDatabaseUrl = `postgresql://${appUser}:${encodeURIComponent(appPassword)}@postgres:5432/${DEMO_DATABASE_NAME}`;
  const migrationDatabaseUrl = `postgresql://${ownerUser}:${encodeURIComponent(ownerPassword)}@postgres:5432/${DEMO_DATABASE_NAME}`;
  const rabbitmqUrl = `amqp://${rabbitUser}:${encodeURIComponent(rabbitPassword)}@rabbitmq:5672/settleflow_demo`;
  const receiverOrigin = `http://demo-webhook-receiver:${options.receiverPort}`;
  const common = {
    DATABASE_URL: containerDatabaseUrl,
    DEPENDENCY_READINESS_TIMEOUT_MS: '2000',
    INTERNAL_TELEMETRY_ENABLED: 'true',
    INTERNAL_TELEMETRY_HOST: '0.0.0.0',
    NODE_ENV: 'development',
    OTEL_DEMO_TRACE_MODE: 'true',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://otel-collector:4318/v1/traces',
    OTEL_TRACE_SAMPLE_RATIO: '0.1',
    OTEL_TRACING_ENABLED: 'true',
    RABBITMQ_URL: rabbitmqUrl,
    RELEASE_COMMIT: options.revision,
    RELEASE_VERSION: '0.0.0-demo',
    SETTLEFLOW_DEMO_MODE: 'true',
    SETTLEFLOW_DEPLOYMENT_MODE: 'release-simulation',
    WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS: JSON.stringify([receiverOrigin]),
    WEBHOOK_KEYRING_PROVIDER: 'local',
    WEBHOOK_LOCAL_ACTIVE_KEY_ID: 'demo-v1',
    WEBHOOK_LOCAL_KEYS_JSON: JSON.stringify({ 'demo-v1': webhookKey }),
    WEBHOOK_URL_POLICY_MODE: 'development',
  };
  const model = {
    'api.env': serialize({
      ...common,
      API_HOST: '0.0.0.0',
      API_PORT: '3000',
      INTERNAL_TELEMETRY_PORT: '9464',
    }),
    'compose.env': serialize({
      SETTLEFLOW_API_PORT: String(options.apiPort),
      SETTLEFLOW_DEMO_POSTGRES_PORT: String(options.postgresPort),
      SETTLEFLOW_DEMO_RECEIVER_PORT: String(options.receiverPort),
      SETTLEFLOW_IMAGE_CREATED: options.createdAt,
      SETTLEFLOW_IMAGE_REVISION: options.revision,
      SETTLEFLOW_IMAGE_VERSION: '0.0.0-demo',
      SETTLEFLOW_PROMETHEUS_PORT: String(options.prometheusPort),
    }),
    'migrator.env': serialize({
      MIGRATION_DATABASE_URL: migrationDatabaseUrl,
      NODE_ENV: 'development',
      POSTGRES_APP_USER: appUser,
      POSTGRES_DB: DEMO_DATABASE_NAME,
      POSTGRES_USER: ownerUser,
      SETTLEFLOW_DEMO_MODE: 'true',
    }),
    'postgres.env': serialize({
      POSTGRES_DB: DEMO_DATABASE_NAME,
      POSTGRES_PASSWORD: ownerPassword,
      POSTGRES_USER: ownerUser,
    }),
    'rabbitmq.env': serialize({
      RABBITMQ_DEFAULT_PASS: rabbitPassword,
      RABBITMQ_DEFAULT_USER: rabbitUser,
      RABBITMQ_DEFAULT_VHOST: 'settleflow_demo',
    }),
    'role-provisioner.env': serialize({
      PGDATABASE: DEMO_DATABASE_NAME,
      PGHOST: 'postgres',
      PGPASSWORD: ownerPassword,
      PGPORT: '5432',
      PGUSER: ownerUser,
      POSTGRES_APP_PASSWORD: appPassword,
      POSTGRES_DB: DEMO_DATABASE_NAME,
    }),
    'worker.env': serialize({
      ...common,
      INTERNAL_TELEMETRY_PORT: '9465',
      WORKER_HEARTBEAT_INTERVAL_MS: '30000',
    }),
  };
  for (const fileName of FILES) secureWrite(resolve(outputDirectory, fileName), model[fileName]);
  return checkDemoConfiguration(outputDirectory);
}

export function checkDemoConfiguration(outputDirectory) {
  const parsed = {};
  for (const fileName of FILES) {
    const path = resolve(outputDirectory, fileName);
    if (!existsSync(path) || !statSync(path).isFile())
      throw new Error('demo_configuration_incomplete');
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
      throw new Error('demo_configuration_permissions_unsafe');
    }
    parsed[fileName] = parseEnvironment(readFileSync(path, 'utf8'), fileName);
  }
  const api = parsed['api.env'];
  const worker = parsed['worker.env'];
  const postgres = parsed['postgres.env'];
  const role = parsed['role-provisioner.env'];
  if (
    api.NODE_ENV !== 'development' ||
    api.SETTLEFLOW_DEMO_MODE !== 'true' ||
    api.WEBHOOK_URL_POLICY_MODE !== 'development' ||
    worker.SETTLEFLOW_DEMO_MODE !== 'true' ||
    postgres.POSTGRES_DB !== DEMO_DATABASE_NAME ||
    role.POSTGRES_DB !== DEMO_DATABASE_NAME ||
    api.DATABASE_URL !== worker.DATABASE_URL ||
    api.RABBITMQ_URL !== worker.RABBITMQ_URL
  ) {
    throw new Error('demo_configuration_unsafe');
  }
  const allowedOrigins = JSON.parse(api.WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS);
  if (
    !Array.isArray(allowedOrigins) ||
    allowedOrigins.length !== 1 ||
    allowedOrigins[0] !== 'http://demo-webhook-receiver:18080'
  ) {
    throw new Error('demo_receiver_origin_unsafe');
  }
  if (api.DATABASE_URL.includes(postgres.POSTGRES_PASSWORD)) {
    throw new Error('demo_owner_credential_leaked');
  }
  return parsed;
}

export function hostRuntimeDatabaseUrl(configuration) {
  const compose = configuration['compose.env'];
  const role = configuration['role-provisioner.env'];
  return `postgresql://settleflow_app:${encodeURIComponent(role.POSTGRES_APP_PASSWORD)}@127.0.0.1:${compose.SETTLEFLOW_DEMO_POSTGRES_PORT}/${DEMO_DATABASE_NAME}`;
}
