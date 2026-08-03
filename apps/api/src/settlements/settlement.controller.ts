import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiExtension,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { MerchantRequestIdentity } from '@settleflow/merchant-access';
import {
  InvalidSettlementRequestError,
  SettlementService,
  type SettlementBatchRepresentation,
  type SettlementRunRepresentation,
} from '@settleflow/settlements';

import { getRequestId, headerValues, type RequestWithRequestId } from '../http/request-id';
import {
  MerchantIdentity,
  RequireMerchantScopes,
} from '../merchant-access/merchant-access.decorators';
import {
  conflictResponseHeaders,
  problemContent,
  requestIdResponseHeaders,
} from '../http/problem-details.openapi';
import { settlementBatchSchema, settlementRunSchema } from './settlement.openapi';

interface SettlementRequest extends RequestWithRequestId {
  readonly rawBody?: Buffer;
}

function idempotencyKey(request: SettlementRequest): string {
  const values = headerValues(request, 'idempotency-key');
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    value.length < 1 ||
    value.length > 255 ||
    /^\s|\s$/u.test(value) ||
    /\p{Cc}/u.test(value)
  )
    throw new InvalidSettlementRequestError();
  return value;
}

@Controller('v1')
@ApiTags('settlements')
@ApiBearerAuth('merchantApiKey')
export class SettlementController {
  public constructor(private readonly settlements: SettlementService) {}

  @Post('settlement-runs')
  @HttpCode(201)
  @RequireMerchantScopes('settlements:write')
  @ApiExtension('x-required-scopes', ['settlements:write'])
  @ApiOperation({ summary: 'Execute one bounded simulated settlement run' })
  @ApiConsumes('application/json')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: {
      additionalProperties: false,
      properties: {
        currency: { enum: ['ETB', 'USD'], type: 'string' },
        cutoffDate: { format: 'date', type: 'string' },
      },
      required: ['currency', 'cutoffDate'],
      type: 'object',
    },
  })
  @ApiCreatedResponse({
    description: 'Terminal completed or no-op settlement run.',
    headers: requestIdResponseHeaders,
    schema: settlementRunSchema,
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description: 'Malformed body, key, or cutoff.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'Merchant API key missing or invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'API key lacks settlements:write.',
    headers: requestIdResponseHeaders,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Idempotency or settlement state conflict.',
    headers: conflictResponseHeaders,
    status: 409,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Financial invariant rejected the command.',
    headers: requestIdResponseHeaders,
    status: 422,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Required dependency unavailable.',
    headers: requestIdResponseHeaders,
    status: 503,
  })
  public run(
    @Req() request: RawBodyRequest<SettlementRequest>,
    @MerchantIdentity() identity: MerchantRequestIdentity,
  ): Promise<SettlementRunRepresentation> {
    if (request.rawBody === undefined) throw new InvalidSettlementRequestError();
    let body: unknown;
    try {
      body = JSON.parse(request.rawBody.toString('utf8'));
    } catch {
      throw new InvalidSettlementRequestError();
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'currency,cutoffDate'
    )
      throw new InvalidSettlementRequestError();
    const row = body as Record<string, unknown>;
    if (
      (row['currency'] !== 'ETB' && row['currency'] !== 'USD') ||
      typeof row['cutoffDate'] !== 'string'
    )
      throw new InvalidSettlementRequestError();
    return this.settlements.run({
      actorApiKeyId: identity.apiKeyId,
      currency: row['currency'],
      cutoffDate: row['cutoffDate'],
      idempotencyKey: idempotencyKey(request),
      merchantId: identity.merchantId,
      requestId: getRequestId(request),
    });
  }

  @Get('settlement-batches/:id')
  @RequireMerchantScopes('settlements:read')
  @ApiExtension('x-required-scopes', ['settlements:read'])
  @ApiOperation({ summary: 'Read one merchant-owned finalized settlement batch' })
  @ApiParam({
    name: 'id',
    schema: { pattern: '^stb_[0-7][0-9A-HJKMNP-TV-Z]{25}$', type: 'string' },
  })
  @ApiOkResponse({
    description: 'Finalized batch totals and bounded items.',
    headers: requestIdResponseHeaders,
    schema: settlementBatchSchema,
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description: 'Invalid batch identifier or limit.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'Merchant API key missing or invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'API key lacks settlements:read.',
    headers: requestIdResponseHeaders,
  })
  @ApiNotFoundResponse({
    content: problemContent,
    description: 'Batch missing or belongs to another merchant.',
    headers: requestIdResponseHeaders,
  })
  public getBatch(
    @Param('id') id: string,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @MerchantIdentity() identity: MerchantRequestIdentity,
  ): Promise<SettlementBatchRepresentation> {
    return this.settlements.getBatch(
      identity.merchantId,
      id,
      limit === undefined ? 20 : Number(limit),
      cursor,
    );
  }
}
