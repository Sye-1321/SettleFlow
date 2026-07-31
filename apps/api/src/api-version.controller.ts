import { Controller, Get } from '@nestjs/common';

export interface ApiVersionResponse {
  readonly service: 'settleflow-api';
  readonly status: 'available';
  readonly version: 'v1';
}

@Controller('api/v1')
export class ApiVersionController {
  @Get()
  public getVersion(): ApiVersionResponse {
    return {
      service: 'settleflow-api',
      status: 'available',
      version: 'v1',
    };
  }
}
