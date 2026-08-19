import { spawn, spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, openSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { checkDemoConfiguration } from '../demo/demo-config.mjs';
import { DEMO_COMPOSE_PROJECT } from '../demo/demo-safety.mjs';
import { checkReleaseConfiguration } from '../release/create-release-config.mjs';
import {
  assertBackupManifest,
  assertExactArguments,
  isInside,
  newBackupId,
  parseNamedArguments,
  POSTGRES_IMAGE,
  secureDirectory,
  secureJsonWrite,
  sha256File,
} from './recovery-safety.mjs';

const SOURCES = {
  demo: {
    composeFile: 'compose.demo.yaml',
    configDirectory: '.settleflow/demo',
    projectName: DEMO_COMPOSE_PROJECT,
  },
  'release-simulation': {
    composeFile: 'compose.release.yaml',
    configDirectory: '.settleflow/release-simulation',
    projectName: 'settleflow-release-simulation',
  },
};

function command(root, executable, arguments_, errorCode) {
  const result = spawnSync(executable, arguments_, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(errorCode);
  return result.stdout.trim();
}

export function assertOutputLocation(root, outputDirectory, acknowledged, git = command) {
  if (acknowledged !== true) throw new Error('backup_sensitive_storage_acknowledgement_required');
  const absolute = resolve(root, outputDirectory);
  if (absolute === resolve(root)) throw new Error('backup_output_directory_unsafe');
  if (isInside(root, absolute)) {
    git(
      root,
      'git',
      ['check-ignore', '--quiet', '--no-index', '--', absolute],
      'backup_output_must_be_ignored',
    );
  }
  return secureDirectory(absolute);
}

function loadSource(root, name) {
  const source = SOURCES[name];
  if (source === undefined) throw new Error('backup_source_invalid');
  const configDirectory = resolve(root, source.configDirectory);
  const configuration =
    name === 'demo'
      ? checkDemoConfiguration(configDirectory)
      : checkReleaseConfiguration(configDirectory);
  return {
    ...source,
    composeFile: resolve(root, source.composeFile),
    configDirectory,
    configuration,
    databaseName: configuration['postgres.env'].POSTGRES_DB,
    owner: configuration['postgres.env'].POSTGRES_USER,
    releaseVersion: configuration['compose.env'].SETTLEFLOW_IMAGE_VERSION,
    sourceCommit: configuration['compose.env'].SETTLEFLOW_IMAGE_REVISION,
  };
}

function composeArguments(source, arguments_) {
  return [
    'compose',
    '--project-name',
    source.projectName,
    '--env-file',
    resolve(source.configDirectory, 'compose.env'),
    '--file',
    source.composeFile,
    ...arguments_,
  ];
}

function parseMetadata(source) {
  let model;
  try {
    model = JSON.parse(source);
  } catch {
    throw new Error('backup_metadata_invalid');
  }
  if (
    typeof model.dataCutoffAt !== 'string' ||
    Number.isNaN(Date.parse(model.dataCutoffAt)) ||
    !Number.isSafeInteger(model.migrationCount) ||
    model.migrationCount < 1 ||
    typeof model.latestMigration !== 'string' ||
    typeof model.serverVersion !== 'string'
  ) {
    throw new Error('backup_metadata_invalid');
  }
  return model;
}

function inspectSource(root, source) {
  const running = command(
    root,
    'docker',
    composeArguments(source, ['ps', '--services', '--status', 'running', 'postgres']),
    'backup_source_not_running',
  );
  if (running !== 'postgres') throw new Error('backup_source_not_running');
  const sql = `SELECT json_build_object(
    'dataCutoffAt', clock_timestamp(),
    'serverVersion', current_setting('server_version'),
    'migrationCount', (SELECT count(*)::integer FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
    'latestMigration', (SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1)
  )::text;`;
  const metadata = parseMetadata(
    command(
      root,
      'docker',
      composeArguments(source, [
        'exec',
        '-T',
        'postgres',
        'psql',
        '--username',
        source.owner,
        '--dbname',
        source.databaseName,
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        sql,
      ]),
      'backup_source_metadata_failed',
    ),
  );
  const pgDumpVersion = command(
    root,
    'docker',
    composeArguments(source, ['exec', '-T', 'postgres', 'pg_dump', '--version']),
    'backup_tool_version_failed',
  );
  return { metadata, pgDumpVersion };
}

function createDump(root, source, dumpPath) {
  return new Promise((resolveDump, reject) => {
    const descriptor = openSync(dumpPath, 'wx', 0o600);
    const child = spawn(
      'docker',
      composeArguments(source, [
        'exec',
        '-T',
        'postgres',
        'pg_dump',
        '--username',
        source.owner,
        '--dbname',
        source.databaseName,
        '--format=custom',
        '--no-owner',
        '--no-acl',
      ]),
      {
        cwd: root,
        stdio: ['ignore', descriptor, 'ignore'],
        windowsHide: true,
      },
    );
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      if (error !== undefined) {
        rmSync(dumpPath, { force: true });
        reject(error);
      } else {
        resolveDump();
      }
    };
    child.once('error', () => finish(new Error('backup_dump_failed')));
    child.once('exit', (code) => finish(code === 0 ? undefined : new Error('backup_dump_failed')));
  });
}

export async function createBackup(root, options) {
  const output = assertOutputLocation(root, options.outputDirectory, options.acknowledged);
  const source = loadSource(root, options.source);
  const { metadata, pgDumpVersion } = inspectSource(root, source);
  const backupId = newBackupId();
  const backupDirectory = secureDirectory(resolve(output, backupId));
  const dumpPath = resolve(backupDirectory, 'database.dump');
  await createDump(root, source, dumpPath);
  const createdAt = new Date().toISOString();
  const manifest = assertBackupManifest({
    artifact: {
      bytes: statSync(dumpPath).size,
      file: 'database.dump',
      format: 'postgresql-custom',
      noAcl: true,
      noOwner: true,
      sha256: await sha256File(dumpPath),
    },
    backupId,
    createdAt,
    dataCutoffAt: metadata.dataCutoffAt,
    formatVersion: 1,
    kind: 'settleflow-postgresql-logical-backup',
    schema: {
      latestMigration: metadata.latestMigration,
      migrationCount: metadata.migrationCount,
    },
    source: {
      databaseName: source.databaseName,
      environment: options.source,
      projectName: source.projectName,
      releaseVersion: source.releaseVersion,
      sourceCommit: source.sourceCommit,
    },
    status: 'COMPLETE',
    tools: {
      pgDumpVersion,
      postgresImage: POSTGRES_IMAGE,
      serverVersion: metadata.serverVersion,
    },
  });
  secureJsonWrite(resolve(backupDirectory, 'manifest.json'), manifest);
  return { backupDirectory, manifest };
}

async function main() {
  const arguments_ = parseNamedArguments(process.argv.slice(2));
  assertExactArguments(
    arguments_,
    ['acknowledge-sensitive-storage', 'output-dir', 'source'],
    ['output-dir', 'source'],
  );
  if (arguments_['acknowledge-sensitive-storage'] !== true) {
    throw new Error('backup_sensitive_storage_acknowledgement_required');
  }
  const result = await createBackup(process.cwd(), {
    acknowledged: true,
    outputDirectory: arguments_['output-dir'],
    source: arguments_.source,
  });
  process.stdout.write(
    `PASS: PostgreSQL logical backup ${result.manifest.backupId} created in the acknowledged sensitive storage directory.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : 'backup_unexpected_failure'}\n`,
    );
    process.exitCode = 1;
  });
}
