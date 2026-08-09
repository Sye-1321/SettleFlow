import { spawn } from 'node:child_process';
import process from 'node:process';

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ?? `exit ${String(code)}`}`));
    });
  });
}

try {
  await run(process.execPath, [
    'node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--config',
    'prisma.config.mts',
  ]);
  await run(process.execPath, ['tools/release/verify-release-database.mjs']);
} catch (error) {
  process.stderr.write(
    `Release migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
}
