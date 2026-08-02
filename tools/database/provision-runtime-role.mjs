import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

const localEnvironmentPath = resolve(process.cwd(), '.env');
if (existsSync(localEnvironmentPath)) {
  process.loadEnvFile(localEnvironmentPath);
}

const required = ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_APP_USER', 'POSTGRES_APP_PASSWORD'];
for (const name of required) {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || hasControlCharacters(value)) {
    throw new Error(`${name} must be a nonempty value without control characters`);
  }
}

if (process.env.POSTGRES_APP_USER !== 'settleflow_app') {
  throw new Error('POSTGRES_APP_USER must be exactly settleflow_app');
}

const postgresUser = process.env.POSTGRES_USER;
const child = spawn(
  'docker',
  [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '--username',
    postgresUser,
    '--dbname',
    process.env.POSTGRES_DB,
    '--file',
    '/opt/settleflow/database/provision-runtime-role.sql',
  ],
  { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true },
);

child.on('error', (error) => {
  process.stderr.write(`Unable to run PostgreSQL role provisioning: ${error.message}\n`);
  process.exitCode = 1;
});

child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
