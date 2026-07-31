import { ServiceUnavailableException } from '@nestjs/common';
import { DependencyConnections, DependencyReadiness } from '@settleflow/infrastructure';

import { HealthController } from './health.controller';

describe('HealthController', () => {
  function createController(readiness: DependencyReadiness): HealthController {
    const dependencies = {
      checkReadiness: (): Promise<DependencyReadiness> => Promise.resolve(readiness),
    } as unknown as DependencyConnections;

    return new HealthController(dependencies);
  }

  it('reports process liveness', () => {
    const controller = createController({
      postgresql: { status: 'down' },
      rabbitmq: { status: 'down' },
    });

    expect(controller.getLiveness()).toEqual({
      service: 'api',
      status: 'ok',
    });
  });

  it('reports ready only when PostgreSQL and RabbitMQ are available', async () => {
    const controller = createController({
      postgresql: { status: 'up' },
      rabbitmq: { status: 'up' },
    });

    await expect(controller.getReadiness()).resolves.toEqual({
      checks: {
        configuration: 'up',
        postgresql: 'up',
        rabbitmq: 'up',
      },
      service: 'api',
      status: 'ready',
    });
  });

  it('fails safely when a required dependency is unavailable', async () => {
    const controller = createController({
      postgresql: { status: 'up' },
      rabbitmq: { status: 'down' },
    });

    try {
      await controller.getReadiness();
      throw new Error('Expected readiness to fail');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toEqual({
        checks: {
          configuration: 'up',
          postgresql: 'up',
          rabbitmq: 'down',
        },
        service: 'api',
        status: 'not_ready',
      });
    }
  });
});
