import { WorkerHealthService } from './worker-health.service';

describe('WorkerHealthService', () => {
  it('tracks liveness and readiness through the worker lifecycle', () => {
    const health = new WorkerHealthService();

    expect(health.getLiveness()).toEqual({
      service: 'worker',
      status: 'ok',
    });
    expect(health.getReadiness().status).toBe('not_ready');

    health.markReady();
    expect(health.getReadiness()).toEqual({
      checks: {
        configuration: 'up',
      },
      deferredDependencies: ['postgresql', 'rabbitmq'],
      service: 'worker',
      status: 'ready',
    });

    health.markStopping();
    expect(health.getReadiness().status).toBe('not_ready');
  });
});
