import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import { inspectDemoCompose, inspectDemoVolumes, resetDemo } from './demo-compose.mjs';
import { checkDemoConfiguration, hostRuntimeDatabaseUrl } from './demo-config.mjs';
import { assertDemoEnvironment, assertResetVolumes, demoPaths } from './demo-safety.mjs';

async function confirmed(arguments_) {
  if (arguments_.includes('--yes')) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (
      (await terminal.question('Remove only the isolated settleflow-demo volumes? [y/N] ')) === 'y'
    );
  } finally {
    terminal.close();
  }
}

export async function runReset(root = process.cwd(), arguments_ = process.argv.slice(2)) {
  const paths = demoPaths(root);
  const configuration = checkDemoConfiguration(paths.directory);
  assertDemoEnvironment(process.env, hostRuntimeDatabaseUrl(configuration));
  inspectDemoCompose(root);
  const volumes = inspectDemoVolumes(root);
  assertResetVolumes(volumes);
  if (!(await confirmed(arguments_))) throw new Error('demo_reset_confirmation_required');
  resetDemo(root);
  rmSync(paths.directory, { force: true, recursive: true });
  process.stdout.write(
    'PASS: isolated settleflow-demo infrastructure and ignored configuration removed.\n',
  );
}

runReset().catch(() => {
  process.stderr.write('FAIL: demo_reset_refused\n');
  process.exitCode = 1;
});
