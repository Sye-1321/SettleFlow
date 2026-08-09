import { InternalHttpServer } from './internal-http-server';

describe('InternalHttpServer', () => {
  it('serves process liveness, dependency readiness, and Prometheus metrics', async () => {
    let ready = false;
    const server = new InternalHttpServer(
      { host: '127.0.0.1', port: 0 },
      {
        liveness: (): object => ({ service: 'worker', status: 'ok' }),
        readiness: (): { checks: { postgresql: boolean }; ready: boolean } => ({
          checks: { postgresql: ready },
          ready,
        }),
      },
      () => Promise.resolve({ body: '# test metrics\n', contentType: 'text/plain' }),
    );
    await server.start();
    const port = server.address()?.port;
    expect(port).toBeDefined();

    const live = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ service: 'worker', status: 'ok' });
    const unavailable = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(unavailable.status).toBe(503);
    ready = true;
    const available = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(available.status).toBe(200);
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(await metrics.text()).toBe('# test metrics\n');

    await server.close();
  });

  it('rejects a public bind address', () => {
    expect(
      () =>
        new InternalHttpServer(
          { host: '0.0.0.0', port: 9_465 },
          {
            liveness: (): object => ({}),
            readiness: (): { checks: Record<string, never>; ready: boolean } => ({
              checks: {},
              ready: false,
            }),
          },
          () => Promise.resolve({ body: '', contentType: 'text/plain' }),
        ),
    ).toThrow('loopback');
  });
});
