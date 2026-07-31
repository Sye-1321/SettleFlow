import { Controller, Get } from '@nestjs/common';

export interface ApiLiveness {
  readonly service: 'api';
  readonly status: 'ok';
}

export interface ApiReadiness {
  readonly checks: {
    readonly configuration: 'up';
  };
  readonly deferredDependencies: readonly ['postgresql'];
  readonly service: 'api';
  readonly status: 'ready';
}

@Controller('health')
export class HealthController {
  @Get('live')
  public getLiveness(): ApiLiveness {
    return {
      service: 'api',
      status: 'ok',
    };
  }

  @Get('ready')
  public getReadiness(): ApiReadiness {
    return {
      checks: {
        configuration: 'up',
      },
      deferredDependencies: ['postgresql'],
      service: 'api',
      status: 'ready',
    };
  }
}
