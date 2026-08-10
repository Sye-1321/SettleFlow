import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const shardRoot = resolve(root, '.settleflow/coverage-shards');
const finalRoot = resolve(root, 'coverage');
const jest = resolve(root, 'node_modules/jest/bin/jest.js');
const unitProjects = [
  'api',
  'worker',
  'infrastructure',
  'merchant-access',
  'idempotency',
  'eventing',
  'payments',
  'ledger',
  'operations',
  'webhooks',
  'settlements',
  'reconciliation',
];
const integrationSpecs = readdirSync(resolve(root, 'test/integration'))
  .filter((name) => name.endsWith('.int-spec.ts'))
  .sort()
  .map((name) => resolve(root, 'test/integration', name));

export function mergeCoverageRecords(left, right) {
  for (const key of ['statementMap', 'fnMap', 'branchMap']) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
      throw new Error(`Coverage instrumentation differs for ${left.path}`);
    }
  }
  const merged = JSON.parse(JSON.stringify(left));
  for (const key of Object.keys(merged.s)) merged.s[key] += right.s[key] ?? 0;
  for (const key of Object.keys(merged.f)) merged.f[key] += right.f[key] ?? 0;
  for (const key of Object.keys(merged.b)) {
    merged.b[key] = merged.b[key].map((count, index) => count + (right.b[key]?.[index] ?? 0));
  }
  return merged;
}

function runJest(name, projects, experimentalVmModules = false, testPath) {
  const directory = resolve(shardRoot, name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = spawnSync(
    process.execPath,
    [
      ...(experimentalVmModules ? ['--experimental-vm-modules'] : []),
      jest,
      '--coverage',
      '--coverageReporters=json',
      `--coverageDirectory=${directory}`,
      '--selectProjects',
      ...projects,
      '--runInBand',
      '--no-cache',
      ...(testPath === undefined ? [] : [testPath]),
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`${name} coverage shard failed`);
}

function mergeShards(names) {
  const reports = names.map((name) =>
    JSON.parse(readFileSync(resolve(shardRoot, name, 'coverage-final.json'), 'utf8')),
  );
  const merged = {};
  for (const report of reports) {
    for (const [path, record] of Object.entries(report)) {
      merged[path] =
        merged[path] === undefined ? record : mergeCoverageRecords(merged[path], record);
    }
  }
  mkdirSync(finalRoot, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(finalRoot, 'coverage-final.json'), `${JSON.stringify(merged)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function main() {
  rmSync(shardRoot, { recursive: true, force: true });
  rmSync(finalRoot, { recursive: true, force: true });
  const shardNames = ['unit'];
  runJest('unit', unitProjects);
  integrationSpecs.forEach((testPath, index) => {
    const name = `integration-${String(index + 1).padStart(2, '0')}`;
    runJest(name, ['integration'], true, testPath);
    shardNames.push(name);
  });
  mergeShards(shardNames);
  process.stdout.write('Unit and real-integration coverage shards merged successfully.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
