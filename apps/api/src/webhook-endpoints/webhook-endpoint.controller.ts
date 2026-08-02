import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
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
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { MerchantRequestIdentity } from '@settleflow/merchant-access';
import {
  parseCreateWebhookEndpoint,
  parsePatchWebhookEndpoint,
  WebhookEndpointService,
  type CreatedWebhookEndpointRepresentation,
  type RotatedWebhookSecretRepresentation,
  type WebhookEndpointRepresentation,
} from '@settleflow/webhooks';

import { getRequestId } from '../http/request-id';
import { problemContent, requestIdResponseHeaders } from '../http/problem-details.openapi';
import {
  MerchantIdentity,
  RequireMerchantScopes,
} from '../merchant-access/merchant-access.decorators';
import {
  encodeWebhookCursor,
  formatWebhookEtag,
  parseWebhookIfMatch,
  parseWebhookListQuery,
  requireEmptyBody,
  requireJsonContentType,
  type WebhookHttpRequest,
} from './webhook-endpoint-http';
import {
  createdWebhookEndpointSchema,
  createWebhookEndpointSchema,
  etagResponseHeaders,
  patchWebhookEndpointSchema,
  rotatedWebhookSecretSchema,
  webhookEndpointListSchema,
  webhookEndpointSchema,
} from './webhook-endpoint.openapi';

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

const requestIdHeader = {
  description: 'Optional caller correlation ID. The canonical value is returned in X-Request-Id.',
  name: 'X-Request-Id',
  required: false,
};

const ifMatchHeader = {
  description: 'Exactly one strong current endpoint ETag: "<publicId>.v<version>".',
  name: 'If-Match',
  required: true,
};

const endpointIdParameter = {
  example: 'whe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  name: 'id',
  schema: { pattern: '^whe_[0-9A-HJKMNP-TV-Z]{26}$', type: 'string' },
};

@Controller('v1/webhook-endpoints')
@ApiTags('webhook-endpoints')
@ApiBearerAuth('merchantApiKey')
export class WebhookEndpointController {
  public constructor(private readonly webhooks: WebhookEndpointService) {}

  @Post()
  @HttpCode(201)
  @RequireMerchantScopes('webhooks:manage')
  @ApiExtension('x-required-scopes', ['webhooks:manage'])
  @ApiOperation({ summary: 'Register a merchant webhook endpoint and show its secret once' })
  @ApiConsumes('application/json')
  @ApiHeader(requestIdHeader)
  @ApiBody({ schema: createWebhookEndpointSchema })
  @ApiCreatedResponse({
    description: 'Endpoint created. The signing secret is shown only in this response.',
    headers: etagResponseHeaders,
    schema: createdWebhookEndpointSchema,
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description: 'Invalid request.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'Merchant API key missing or invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'API key lacks webhooks:manage.',
    headers: requestIdResponseHeaders,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Normalized URL already registered.',
    headers: requestIdResponseHeaders,
    status: 409,
  })
  @ApiUnprocessableEntityResponse({
    content: problemContent,
    description: 'Event unsupported or destination prohibited/unresolvable.',
    headers: requestIdResponseHeaders,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Database, DNS, or keyring unavailable.',
    headers: requestIdResponseHeaders,
    status: 503,
  })
  public async create(
    @Body() body: unknown,
    @Req() request: WebhookHttpRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
    @MerchantIdentity() identity: MerchantRequestIdentity,
  ): Promise<CreatedWebhookEndpointRepresentation> {
    requireJsonContentType(request);
    const fields = parseCreateWebhookEndpoint(body);
    const result = await this.webhooks.create({
      ...fields,
      actorApiKeyId: identity.apiKeyId,
      merchantId: identity.merchantId,
      requestId: getRequestId(request),
    });
    response.setHeader('ETag', formatWebhookEtag(result.id, result.version));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  @Get()
  @RequireMerchantScopes('webhooks:read')
  @ApiExtension('x-required-scopes', ['webhooks:read'])
  @ApiOperation({ summary: 'List merchant-owned webhook endpoints by descending public ID' })
  @ApiHeader(requestIdHeader)
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { default: 20, maximum: 100, minimum: 1, type: 'integer' },
  })
  @ApiQuery({
    description: 'Opaque base64url keyset cursor.',
    name: 'cursor',
    required: false,
    schema: { type: 'string' },
  })
  @ApiOkResponse({
    description: 'Bounded merchant-owned endpoint page.',
    headers: requestIdResponseHeaders,
    schema: webhookEndpointListSchema,
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description: 'Invalid list query.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'Merchant API key missing or invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'API key lacks webhooks:read.',
    headers: requestIdResponseHeaders,
  })
  public async list(
    @Query() query: unknown,
    @MerchantIdentity() identity: MerchantRequestIdentity,
  ): Promise<{
    readonly data: readonly WebhookEndpointRepresentation[];
    readonly nextCursor: string | null;
  }> {
    const page = parseWebhookListQuery(query);
    const result = await this.webhooks.list(identity.merchantId, page.afterPublicId, page.limit);
    return {
      data: result.data,
      nextCursor:
        result.nextPublicId === undefined ? null : encodeWebhookCursor(result.nextPublicId),
    };
  }

  @Get(':id')
  @RequireMerchantScopes('webhooks:read')
  @ApiExtension('x-required-scopes', ['webhooks:read'])
  @ApiOperation({ summary: 'Retrieve one merchant-owned webhook endpoint' })
  @ApiHeader(requestIdHeader)
  @ApiParam(endpointIdParameter)
  @ApiOkResponse({
    description: 'Merchant-owned endpoint metadata.',
    headers: etagResponseHeaders,
    schema: webhookEndpointSchema,
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description: 'Invalid endpoint identifier.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'Merchant API key missing or invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'API key lacks webhooks:read.',
    headers: requestIdResponseHeaders,
  })
  @ApiNotFoundResponse({
    content: problemContent,
    description: 'Endpoint missing or owned by another merchant.',
    headers: requestIdResponseHeaders,
  })
  public async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: HeaderResponse,
    @MerchantIdentity() identity: MerchantRequestIdentity,
  ): Promise<WebhookEndpointRepresentation> {
    const result = await this.webhooks.get(identity.merchantId, id);
    response.setHeader('ETag', formatWebhookEtag(result.id, result.version));
    return result;
  }

  @Patch(':id')
  @RequireMerchantScopes('webhooks:manage')
  @ApiExtension('x-required-scopes', ['webhooks:manage'])
  @ApiOperation({ summary: 'Replace webhook endpoint status and/or subscriptions' })
  @ApiConsumes('application/json')
  @ApiHeader(requestIdHeader)
  @ApiHeader(ifMatchHeader)
  @ApiParam(endpointIdParameter)
  @ApiBody({ schema: patchWebhookEndpointSchema })
  @ApiOkResponse({
    description: 'Updated endpoint, or unchanged endpoint for a semantic no-op.',
    headers: etagResponseHeaders,
    schema: webhookEndpointSchema,
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description: 'Invalid body, endpoint ID, or If-Match syntax.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'Merchant API key missing or invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'API key lacks webhooks:manage.',
    headers: requestIdResponseHeaders,
  })
  @ApiNotFoundResponse({
    content: problemContent,
    description: 'Endpoint missing or owned by another merchant.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnprocessableEntityResponse({
    content: problemContent,
    description: 'Subscription event unsupported.',
    headers: requestIdResponseHeaders,
  })
  @ApiResponse({
    content: problemContent,
    description: 'If-Match is stale.',
    headers: requestIdResponseHeaders,
    status: 412,
  })
  @ApiResponse({
    content: problemContent,
    description: 'If-Match is required.',
    headers: requestIdResponseHeaders,
    status: 428,
  })
  public async patch(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: WebhookHttpRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
    @MerchantIdentity() identity: MerchantRequestIdentity,
  ): Promise<WebhookEndpointRepresentation> {
    requireJsonContentType(request);
    const expectedVersion = parseWebhookIfMatch(request, id);
    const fields = parsePatchWebhookEndpoint(body);
    const result = await this.webhooks.patch({
      ...fields,
      actorApiKeyId: identity.apiKeyId,
      expectedVersion,
      merchantId: identity.merchantId,
      publicId: id,
      requestId: getRequestId(request),
    });
    response.setHeader('ETag', formatWebhookEtag(result.id, result.version));
    return result;
  }

  @Post(':id/secret-rotations')
  @HttpCode(200)
  @RequireMerchantScopes('webhooks:manage')
  @ApiExtension('x-required-scopes', ['webhooks:manage'])
  @ApiOperation({ summary: 'Rotate a webhook signing secret and show the new secret once' })
  @ApiHeader(requestIdHeader)
  @ApiHeader(ifMatchHeader)
  @ApiParam(endpointIdParameter)
  @ApiOkResponse({
    description: 'Secret rotated with a 24-hour previous-secret overlap.',
    headers: etagResponseHeaders,
    schema: rotatedWebhookSecretSchema,
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description: 'Invalid endpoint ID, body, or If-Match syntax.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'Merchant API key missing or invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'API key lacks webhooks:manage.',
    headers: requestIdResponseHeaders,
  })
  @ApiNotFoundResponse({
    content: problemContent,
    description: 'Endpoint missing or owned by another merchant.',
    headers: requestIdResponseHeaders,
  })
  @ApiResponse({
    content: problemContent,
    description: 'If-Match is stale.',
    headers: requestIdResponseHeaders,
    status: 412,
  })
  @ApiResponse({
    content: problemContent,
    description: 'If-Match is required.',
    headers: requestIdResponseHeaders,
    status: 428,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Database or keyring unavailable.',
    headers: requestIdResponseHeaders,
    status: 503,
  })
  public async rotate(
    @Param('id') id: string,
    @Req() request: WebhookHttpRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
    @MerchantIdentity() identity: MerchantRequestIdentity,
  ): Promise<RotatedWebhookSecretRepresentation> {
    requireEmptyBody(request);
    const expectedVersion = parseWebhookIfMatch(request, id);
    const result = await this.webhooks.rotate({
      actorApiKeyId: identity.apiKeyId,
      expectedVersion,
      merchantId: identity.merchantId,
      publicId: id,
      requestId: getRequestId(request),
    });
    response.setHeader('ETag', formatWebhookEtag(result.id, result.version));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }
}
