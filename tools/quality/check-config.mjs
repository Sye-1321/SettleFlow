import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { checkReleaseConfiguration } from '../release/create-release-config.mjs';

export function parseEnvironmentExample(source) {
  const environment = {};
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`Invalid environment example line ${index + 1}`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) throw new Error(`Invalid environment key ${key}`);
    if (environment[key] !== undefined) throw new Error(`Duplicate environment key ${key}`);
    environment[key] = line.slice(separator + 1).trim();
  }
  return environment;
}

export function checkConfiguration(root) {
  const apiOutput = resolve(root, 'apps/api/dist/config/environment.js');
  const workerOutput = resolve(root, 'apps/worker/dist/config/environment.js');
  if (!existsSync(apiOutput) || !existsSync(workerOutput)) {
    throw new Error(
      'Compiled API and worker configuration is required; run the config:check script',
    );
  }
  const require = createRequire(import.meta.url);
  const api = parseEnvironmentExample(readFileSync(resolve(root, 'apps/api/.env.example'), 'utf8'));
  const worker = parseEnvironmentExample(
    readFileSync(resolve(root, 'apps/worker/.env.example'), 'utf8'),
  );
  const { validateApiEnvironment } = require(apiOutput);
  const { validateWorkerEnvironment } = require(workerOutput);
  const validatedApi = validateApiEnvironment(api);
  const validatedWorker = validateWorkerEnvironment(worker);
  const failures = [];
  for (const [service, config] of [
    ['api', validatedApi],
    ['worker', validatedWorker],
  ]) {
    if (config.INTERNAL_TELEMETRY_ENABLED !== true)
      failures.push(`${service}: internal telemetry must be enabled in the example`);
    if (!['127.0.0.1', '::1', 'localhost'].includes(config.INTERNAL_TELEMETRY_HOST))
      failures.push(`${service}: internal listener is not loopback`);
    if (config.OTEL_TRACE_SAMPLE_RATIO !== 0.1)
      failures.push(`${service}: trace sample ratio must be 0.1`);
  }
  for (const [service, validate, environment] of [
    ['api', validateApiEnvironment, api],
    ['worker', validateWorkerEnvironment, worker],
  ]) {
    try {
      validate({
        ...environment,
        NODE_ENV: 'production',
        WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS: '[]',
        WEBHOOK_URL_POLICY_MODE: 'production',
      });
      failures.push(`${service}: local keyring must fail production validation`);
    } catch {
      // Expected production-fatal local keyring behavior.
    }
  }
  const releaseDirectory = resolve(root, '.settleflow/release-simulation');
  if (existsSync(releaseDirectory)) {
    try {
      const release = checkReleaseConfiguration(releaseDirectory);
      for (const [service, validate, fileName] of [
        ['api', validateApiEnvironment, 'api.env'],
        ['worker', validateWorkerEnvironment, 'worker.env'],
      ]) {
        const validated = validate(release[fileName]);
        if (validated.SETTLEFLOW_DEPLOYMENT_MODE !== 'release-simulation') {
          failures.push(`${service}: generated release configuration has the wrong mode`);
        }
        try {
          validate({ ...release[fileName], NODE_ENV: 'production' });
          failures.push(`${service}: release-simulation must fail production relabeling`);
        } catch {
          // Required: the development-only keyring and release mode are production-fatal.
        }
      }
    } catch (error) {
      failures.push(
        `release-simulation: ${error instanceof Error ? error.message : 'invalid configuration'}`,
      );
    }
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const failures = checkConfiguration(process.cwd());
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('API and worker configuration examples pass runtime validation.\n');
  }
}
