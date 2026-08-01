import { Controller, Get, HttpCode, Param, Post, Req, type RawBodyRequest } from '@nestjs/common';
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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  InvalidPaymentIntentRequestError,
  PaymentIntentService,
  type PaymentIntentRepresentation,
} from '@settleflow/payments';
import type { MerchantRequestIdentity } from '@settleflow/merchant-access';

import { getRequestId, headerValues, type RequestWithRequestId } from '../http/request-id';
import {
  conflictResponseHeaders,
  problemContent,
  requestIdResponseHeaders,
} from '../http/problem-details.openapi';
import {
  MerchantIdentity,
  RequireMerchantScopes,
} from '../merchant-access/merchant-access.decorators';
import { parsePaymentIntentBody } from './payment-intent-body.parser';
import { createPaymentIntentSchema, paymentIntentSchema } from './payment-intent.openapi';

interface PaymentIntentHttpRequest extends RequestWithRequestId {
  readonly rawBody?: Buffer;
}

function requireJsonContentType(request: PaymentIntentHttpRequest): void {
  const values = headerValues(request, 'content-type');
  if (
    values.length !== 1 ||
    values[0]?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    throw new InvalidPaymentIntentRequestError('Content-Type');
  }
}

function requireIdempotencyKey(request: PaymentIntentHttpRequest): string {
  const values = headerValues(request, 'idempotency-key');
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    [...value].length < 1 ||
    [...value].length > 255 ||
    /^\s|\s$/u.test(value) ||
    /\p{Cc}/u.test(value) ||
    /[\uD800-\uDFFF]/u.test(value)
  ) {
    throw new InvalidPaymentIntentRequestError('Idempotency-Key');
  }
  return value;
}

const requestIdHeader = {
  description:
    'Optional caller correlation ID. Invalid values are replaced. The canonical value is returned in X-Request-Id.',
  name: 'X-Request-Id',
  required: false,
};

@Controller('v1/payment-intents')
@ApiTags('payment-intents')
@ApiBearerAuth('merchantApiKey')
export class PaymentIntentController {
  public constructor(private readonly payments: PaymentIntentService) {}

  @Post()
  @HttpCode(201)
  @RequireMerchantScopes('payments:write')
  @ApiExtension('x-required-scopes', ['payments:write'])
  @ApiOperation({ summary: 'Create a merchant-owned manual Payment Intent idempotently' })
  @ApiConsumes('application/json')
  @ApiHeader({
    description: 'Required merchant-scoped command key; 1-255 characters and never logged.',
    name: 'Idempotency-Key',
    required: true,
  })
  @ApiHeader(requestIdHeader)
  @ApiBody({ schema: createPaymentIntentSchema })
  @ApiCreatedResponse({
    description: 'Created or replayed Payment Intent.',
    headers: requestIdResponseHeaders,
    schema: paymentIntentSchema,
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description: 'Malformed or invalid request.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'Merchant API key missing or invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'API key lacks payments:write.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnprocessableEntityResponse({
    content: problemContent,
    description: 'Currency or capture method unsupported.',
    headers: requestIdResponseHeaders,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Idempotency or external-reference conflict.',
    headers: conflictResponseHeaders,
    status: 409,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Required database unavailable.',
    headers: requestIdResponseHeaders,
    status: 503,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Unexpected internal failure.',
    headers: requestIdResponseHeaders,
    status: 500,
  })
  public create(
    @Req() request: RawBodyRequest<PaymentIntentHttpRequest>,
    @MerchantIdentity() identity: MerchantRequestIdentity,
  ): Promise<PaymentIntentRepresentation> {
    requireJsonContentType(request);
    const idempotencyKey = requireIdempotencyKey(request);
    if (request.rawBody === undefined) {
      throw new InvalidPaymentIntentRequestError();
    }
    const fields = parsePaymentIntentBody(request.rawBody);
    return this.payments.create({
      ...fields,
      idempotencyKey,
      merchantId: identity.merchantId,
      requestId: getRequestId(request),
    });
  }

  @Get(':id')
  @RequireMerchantScopes('payments:read')
  @ApiExtension('x-required-scopes', ['payments:read'])
  @ApiOperation({ summary: 'Retrieve one merchant-owned Payment Intent' })
  @ApiHeader(requestIdHeader)
  @ApiParam({
    example: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    name: 'id',
    schema: { pattern: '^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$', type: 'string' },
  })
  @ApiOkResponse({
    description: 'Merchant-owned Payment Intent.',
    headers: requestIdResponseHeaders,
    schema: paymentIntentSchema,
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description: 'Payment identifier is invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'Merchant API key missing or invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'API key lacks payments:read.',
    headers: requestIdResponseHeaders,
  })
  @ApiNotFoundResponse({
    content: problemContent,
    description: 'Payment Intent missing or owned by another merchant.',
    headers: requestIdResponseHeaders,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Required database unavailable.',
    headers: requestIdResponseHeaders,
    status: 503,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Unexpected internal failure.',
    headers: requestIdResponseHeaders,
    status: 500,
  })
  public get(
    @Param('id') id: string,
    @MerchantIdentity() identity: MerchantRequestIdentity,
  ): Promise<PaymentIntentRepresentation> {
    return this.payments.get(identity.merchantId, id);
  }
}

export const paymentIntentControllerInternals = {
  requireIdempotencyKey,
  requireJsonContentType,
};
