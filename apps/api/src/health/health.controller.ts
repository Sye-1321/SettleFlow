import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  areRequiredDependenciesReady,
  DependencyConnections,
  DependencyStatus,
} from '@settleflow/infrastructure';

export interface ApiLiveness {
  readonly service: 'api';
  readonly status: 'ok';
}

export interface ApiReadiness {
  readonly checks: {
    readonly configuration: 'up';
    readonly postgresql: DependencyStatus;
    readonly rabbitmq: DependencyStatus;
  };
  readonly service: 'api';
  readonly status: 'not_ready' | 'ready';
}

@Controller('health')
export class HealthController {
  public constructor(private readonly dependencies: DependencyConnections) {}

  @Get('live')
  public getLiveness(): ApiLiveness {
    return {
      service: 'api',
      status: 'ok',
    };
  }

  @Get('ready')
  public async getReadiness(): Promise<ApiReadiness> {
    const dependencies = await this.dependencies.checkReadiness();
    const response: ApiReadiness = {
      checks: {
        configuration: 'up',
        postgresql: dependencies.postgresql.status,
        rabbitmq: dependencies.rabbitmq.status,
      },
      service: 'api',
      status: areRequiredDependenciesReady(dependencies) ? 'ready' : 'not_ready',
    };

    if (response.status === 'not_ready') {
      throw new ServiceUnavailableException(response);
    }

    return response;
  }
}
