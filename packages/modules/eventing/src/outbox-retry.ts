export interface FullJitterBackoffOptions {
  readonly attemptCount: number;
  readonly baseMs: number;
  readonly maxMs: number;
  readonly random: () => number;
}

export function calculateFullJitterBackoff(options: FullJitterBackoffOptions): number {
  const exponent = Math.max(0, Math.min(30, options.attemptCount - 1));
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** exponent);
  const sample = Math.max(0, Math.min(0.999_999_999, options.random()));
  return Math.floor(sample * (ceiling + 1));
}
