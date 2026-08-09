import { readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function checkContracts(root) {
  const failures = [];
  const openApi = readJson(resolve(root, 'docs/api/openapi.json'));
  if (openApi.openapi !== '3.0.0') failures.push('OpenAPI version must remain 3.0.0');
  const operationIds = new Set();
  for (const [path, pathItem] of Object.entries(openApi.paths ?? {})) {
    if (!/^\/(?:health(?:\/|$)|v1(?:\/|$))/u.test(path) || path.startsWith('/api/v1')) {
      failures.push(`OpenAPI path violates the accepted /v1 convention: ${path}`);
    }
    for (const operation of Object.values(pathItem ?? {})) {
      if (typeof operation !== 'object' || operation === null || !('operationId' in operation))
        continue;
      const operationId = operation.operationId;
      if (typeof operationId !== 'string' || operationId.length === 0) {
        failures.push(`OpenAPI operation at ${path} lacks an operationId`);
      } else if (operationIds.has(operationId)) {
        failures.push(`Duplicate OpenAPI operationId: ${operationId}`);
      } else operationIds.add(operationId);
    }
  }

  const eventDirectory = resolve(root, 'docs/events');
  for (const file of readdirSync(eventDirectory)
    .filter((name) => name.endsWith('.schema.json'))
    .sort()) {
    const schema = readJson(resolve(eventDirectory, file));
    const eventType = file.replace(/\.schema\.json$/u, '');
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
      failures.push(`${file}: must use JSON Schema draft 2020-12`);
    }
    if (schema.title !== eventType || schema.properties?.eventType?.const !== eventType) {
      failures.push(`${file}: title/eventType must equal ${eventType}`);
    }
    if (schema.type !== 'object' || schema.additionalProperties !== false) {
      failures.push(`${file}: top-level event body must be a closed object`);
    }
    const properties = Object.keys(schema.properties ?? {}).sort();
    const required = [...(schema.required ?? [])].sort();
    if (JSON.stringify(properties) !== JSON.stringify(required)) {
      failures.push(`${file}: every top-level event field must be required`);
    }
  }
  return failures;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to parse ${basename(path)}`, { cause: error });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const failures = checkContracts(process.cwd());
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('OpenAPI and event contracts satisfy repository conventions.\n');
  }
}
