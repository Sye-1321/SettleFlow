import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

export interface ApiVersionResponse {
  readonly service: 'settleflow-api';
  readonly status: 'available';
  readonly version: 'v1';
}

@Controller('api/v1')
@ApiTags('foundation')
@ApiBearerAuth('merchantApiKey')
export class ApiVersionController {
  @Get()
  @ApiOperation({ summary: 'Return the authenticated merchant API version entrypoint' })
  @ApiOkResponse({
    description: 'The API is available to the authenticated merchant request.',
    schema: {
      example: { service: 'settleflow-api', status: 'available', version: 'v1' },
      type: 'object',
    },
  })
  @ApiUnauthorizedResponse({ description: 'The merchant API key is missing or invalid.' })
  public getVersion(): ApiVersionResponse {
    return {
      service: 'settleflow-api',
      status: 'available',
      version: 'v1',
    };
  }
}
