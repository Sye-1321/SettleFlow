import { WorkerHealthService } from './worker-health.service';

describe('WorkerHealthService', () => {
  it('tracks liveness and readiness through the worker lifecycle', () => {
    const health = new WorkerHealthService();

    expect(health.getLiveness()).toEqual({
      service: 'worker',
      status: 'ok',
    });
    expect(health.getReadiness().status).toBe('not_ready');

    health.updateDependencies({
      postgresql: { status: 'up' },
      rabbitmq: { status: 'up' },
    });
    health.markRunning();
    expect(health.getReadiness()).toEqual({
      checks: {
        configuration: 'up',
        postgresql: 'up',
        rabbitmq: 'up',
      },
      service: 'worker',
      status: 'ready',
    });

    health.updateDependencies({
      postgresql: { status: 'up' },
      rabbitmq: { status: 'down' },
    });
    expect(health.getReadiness().status).toBe('not_ready');

    health.markStopping();
    expect(health.getReadiness().status).toBe('not_ready');
  });
});
