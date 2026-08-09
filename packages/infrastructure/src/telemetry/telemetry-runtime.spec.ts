import { createServer } from 'node:http';

import { TelemetryRuntime } from './telemetry-runtime';

describe('TelemetryRuntime', () => {
  it('makes readiness false before closing its internal listener', async () => {
    const runtime = new TelemetryRuntime({
      environment: 'test',
      internalListener: { enabled: true, host: '127.0.0.1', port: 0 },
      releaseCommit: 'local',
      releaseVersion: '0.0.0-test',
      service: 'worker',
      tracing: { demo: false, enabled: false, exportTimeoutMs: 1_000, sampleRatio: 0.1 },
    });
    await runtime.start({
      liveness: () => ({ service: 'worker', status: 'ok' }),
      readiness: () => ({ checks: { postgresql: true }, ready: true }),
    });
    const port = runtime.internalAddress()?.port;
    expect((await fetch(`http://127.0.0.1:${port}/health/ready`)).status).toBe(200);

    runtime.beginShutdown();

    expect((await fetch(`http://127.0.0.1:${port}/health/ready`)).status).toBe(503);
    await runtime.shutdown();
  });

  it('does not fail application startup when the diagnostic port is unavailable', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (typeof address !== 'object' || address === null) throw new Error('Missing test port');
    const runtime = new TelemetryRuntime({
      environment: 'test',
      internalListener: { enabled: true, host: '127.0.0.1', port: address.port },
      releaseCommit: 'local',
      releaseVersion: '0.0.0-test',
      service: 'api',
      tracing: { demo: false, enabled: false, exportTimeoutMs: 1_000, sampleRatio: 0.1 },
    });

    await expect(
      runtime.start({
        liveness: () => ({ status: 'ok' }),
        readiness: () => ({ checks: {}, ready: true }),
      }),
    ).resolves.toBeUndefined();
    expect(runtime.internalAddress()).toBeUndefined();

    await runtime.shutdown();
    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });
});
