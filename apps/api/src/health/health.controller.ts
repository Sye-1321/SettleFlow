import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  areRequiredDependenciesReady,
  DependencyConnections,
  DependencyStatus,
} from '@settleflow/infrastructure';

import { PublicRoute } from '../merchant-access/merchant-access.decorators';

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
@ApiTags('health')
@PublicRoute()
export class HealthController {
  public constructor(private readonly dependencies: DependencyConnections) {}

  @Get('live')
  @ApiOperation({ summary: 'Report process liveness without dependency probes' })
  @ApiOkResponse({ description: 'The API process is live.' })
  public getLiveness(): ApiLiveness {
    return {
      service: 'api',
      status: 'ok',
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Report bounded PostgreSQL and RabbitMQ readiness' })
  @ApiOkResponse({ description: 'All required dependencies are ready.' })
  @ApiServiceUnavailableResponse({
    description: 'At least one required dependency is unavailable.',
  })
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
