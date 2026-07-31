import { HealthController } from './health.controller';

describe('HealthController', () => {
  const controller = new HealthController();

  it('reports process liveness', () => {
    expect(controller.getLiveness()).toEqual({
      service: 'api',
      status: 'ok',
    });
  });

  it('reports foundation readiness without pretending PostgreSQL is configured', () => {
    expect(controller.getReadiness()).toEqual({
      checks: {
        configuration: 'up',
      },
      deferredDependencies: ['postgresql'],
      service: 'api',
      status: 'ready',
    });
  });
});
