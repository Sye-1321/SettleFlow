import { createRequire } from 'node:module';

interface UlidModule {
  readonly monotonicFactory: () => (timestampMilliseconds?: number) => string;
}

// ulid 3.0.2 publishes a Node CommonJS runtime but its copied .d.cts files
// reference ESM declarations in a way TypeScript 6 rejects under Node16 CJS.
// Keep the approved runtime package and describe only the narrow API we use.
const { monotonicFactory } = createRequire(__filename)('ulid') as UlidModule;

export class MonotonicUlidGenerator {
  private readonly factory = monotonicFactory();

  public generate(timestampMilliseconds: number): string {
    return this.factory(timestampMilliseconds);
  }
}
