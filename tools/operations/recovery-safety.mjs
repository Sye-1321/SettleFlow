import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';

export const BACKUP_FORMAT_VERSION = 1;
export const POSTGRES_IMAGE =
  'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
export const RABBITMQ_IMAGE =
  'rabbitmq:4.3.4-management@sha256:4e628d3cbc61ef45c5918e19bb9844874410d96d4ced897ced7d072d63ad555c';
export const RECOVERY_PROJECT_PREFIX = 'settleflow-recovery-';

const SHA256 = /^[a-f\d]{64}$/u;
const COMMIT = /^[a-f\d]{40}$/u;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/u;

export function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

export function parseNamedArguments(arguments_) {
  const parsed = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith('--')) throw new Error('recovery_argument_invalid');
    const name = argument.slice(2);
    if (!/^[a-z][a-z-]*$/u.test(name) || Object.hasOwn(parsed, name)) {
      throw new Error('recovery_argument_invalid');
    }
    const next = arguments_[index + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[name] = true;
      continue;
    }
    if (next.length === 0 || hasControlCharacter(next)) {
      throw new Error('recovery_argument_invalid');
    }
    parsed[name] = next;
    index += 1;
  }
  return parsed;
}

export function assertExactArguments(arguments_, allowed, required) {
  for (const name of Object.keys(arguments_)) {
    if (!allowed.includes(name)) throw new Error('recovery_argument_unknown');
  }
  for (const name of required) {
    if (typeof arguments_[name] !== 'string') throw new Error('recovery_argument_required');
  }
}

export function isInside(root, target) {
  const path = relative(resolve(root), resolve(target));
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

export function secureDirectory(path) {
  if (existsSync(path)) {
    const details = lstatSync(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('recovery_directory_unsafe');
    }
  } else {
    mkdirSync(path, { mode: 0o700, recursive: true });
  }
  if (process.platform !== 'win32') chmodSync(path, 0o700);
  return path;
}

export function secureJsonWrite(path, model) {
  writeFileSync(path, `${JSON.stringify(model, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

export function secureTextWrite(path, source) {
  writeFileSync(path, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function newBackupId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/gu, '').replace('Z', 'Z');
  return `bkp_${stamp}_${randomBytes(6).toString('hex')}`;
}

export function newRecoveryProject() {
  return `${RECOVERY_PROJECT_PREFIX}${randomBytes(6).toString('hex')}`;
}

function assertIso(value, code) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(code);
}

export function assertBackupManifest(model) {
  const expected = [
    'artifact',
    'backupId',
    'createdAt',
    'dataCutoffAt',
    'formatVersion',
    'kind',
    'schema',
    'source',
    'status',
    'tools',
  ].sort();
  if (JSON.stringify(Object.keys(model ?? {}).sort()) !== JSON.stringify(expected)) {
    throw new Error('backup_manifest_shape_invalid');
  }
  if (
    model.formatVersion !== BACKUP_FORMAT_VERSION ||
    model.kind !== 'settleflow-postgresql-logical-backup' ||
    model.status !== 'COMPLETE' ||
    typeof model.backupId !== 'string' ||
    !/^bkp_\d{8}T\d{9}Z_[a-f\d]{12}$/u.test(model.backupId)
  ) {
    throw new Error('backup_manifest_identity_invalid');
  }
  assertIso(model.createdAt, 'backup_manifest_time_invalid');
  assertIso(model.dataCutoffAt, 'backup_manifest_time_invalid');
  if (Date.parse(model.dataCutoffAt) > Date.parse(model.createdAt)) {
    throw new Error('backup_manifest_time_invalid');
  }
  if (
    model.artifact?.format !== 'postgresql-custom' ||
    model.artifact?.file !== 'database.dump' ||
    !Number.isSafeInteger(model.artifact?.bytes) ||
    model.artifact.bytes <= 0 ||
    !SHA256.test(model.artifact?.sha256 ?? '') ||
    model.artifact.noAcl !== true ||
    model.artifact.noOwner !== true
  ) {
    throw new Error('backup_manifest_artifact_invalid');
  }
  if (
    !Number.isSafeInteger(model.schema?.migrationCount) ||
    model.schema.migrationCount < 1 ||
    typeof model.schema.latestMigration !== 'string' ||
    !SAFE_NAME.test(model.schema.latestMigration)
  ) {
    throw new Error('backup_manifest_schema_invalid');
  }
  if (
    !['demo', 'release-simulation'].includes(model.source?.environment) ||
    typeof model.source?.projectName !== 'string' ||
    !SAFE_NAME.test(model.source.projectName) ||
    typeof model.source?.databaseName !== 'string' ||
    !SAFE_NAME.test(model.source.databaseName) ||
    typeof model.source?.releaseVersion !== 'string' ||
    !SAFE_NAME.test(model.source.releaseVersion) ||
    !COMMIT.test(model.source?.sourceCommit ?? '')
  ) {
    throw new Error('backup_manifest_source_invalid');
  }
  if (
    model.tools?.postgresImage !== POSTGRES_IMAGE ||
    typeof model.tools?.pgDumpVersion !== 'string' ||
    !/^pg_dump \(PostgreSQL\) 18\./u.test(model.tools.pgDumpVersion) ||
    typeof model.tools?.serverVersion !== 'string' ||
    !/^18\./u.test(model.tools.serverVersion)
  ) {
    throw new Error('backup_manifest_tool_invalid');
  }
  return model;
}

export function readBackupManifest(path) {
  const model = JSON.parse(readFileSync(path, 'utf8'));
  return assertBackupManifest(model);
}

export function assertBackupArtifact(manifestPath, manifest) {
  const dumpPath = resolve(manifestPath, '..', manifest.artifact.file);
  const details = statSync(dumpPath);
  if (!details.isFile() || details.size !== manifest.artifact.bytes) {
    throw new Error('backup_artifact_size_mismatch');
  }
  return dumpPath;
}

export async function verifyBackupArtifact(manifestPath, manifest) {
  const dumpPath = assertBackupArtifact(manifestPath, manifest);
  if ((await sha256File(dumpPath)) !== manifest.artifact.sha256) {
    throw new Error('recovery_backup_checksum_mismatch');
  }
  return dumpPath;
}

export function serializeEnvironment(environment) {
  return `${Object.entries(environment)
    .map(([name, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || value.length === 0 || hasControlCharacter(value)) {
        throw new Error('recovery_environment_unsafe');
      }
      return `${name}=${value}`;
    })
    .join('\n')}\n`;
}
