import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SELECTIONS = {
  concurrency: [
    'test/integration/payment-intents.int-spec.ts',
    'test/integration/outbox-relay.int-spec.ts',
    'test/integration/settlements-reconciliation.int-spec.ts',
  ],
  failure: [
    'test/integration/dependency-readiness.int-spec.ts',
    'test/integration/outbox-relay.int-spec.ts',
    'test/integration/webhook-projection-consumer.int-spec.ts',
    'test/integration/webhook-delivery.int-spec.ts',
  ],
};

export function integrationRuns(selection, repetitions) {
  if (!Object.hasOwn(SELECTIONS, selection)) throw new Error('Unknown integration selection');
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) {
    throw new Error('Integration repetitions must be from one through three');
  }
  return Array.from({ length: repetitions }, (_, index) => ({
    index: index + 1,
    files: [...SELECTIONS[selection]],
  }));
}

export function integrationCommandArguments(run) {
  return ['test:integration', '--runTestsByPath', ...run.files];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const selection = process.argv[2];
  const repetitions = Number.parseInt(process.argv[3] ?? '', 10);
  for (const run of integrationRuns(selection, repetitions)) {
    process.stdout.write(
      `Starting ${selection} integration evidence run ${run.index}/${repetitions}.\n`,
    );
    const pnpmArguments = integrationCommandArguments(run);
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
    const arguments_ =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', `pnpm ${pnpmArguments.join(' ')}`]
        : pnpmArguments;
    const result = spawnSync(command, arguments_, {
      cwd: process.cwd(),
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`${selection} integration evidence failed on run ${run.index}`);
    }
  }
}
