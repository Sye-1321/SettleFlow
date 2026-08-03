import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiAcceptedResponse,
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
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { MerchantRequestIdentity } from '@settleflow/merchant-access';
import {
  InvalidReconciliationRequestError,
  ReconciliationService,
  type ReconciliationImportRepresentation,
  type ReconciliationReportRepresentation,
} from '@settleflow/reconciliation';

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
import {
  reconciliationImportSchema,
  reconciliationReportSchema,
  reconciliationUploadSchema,
} from './reconciliation.openapi';

interface UploadedCsv {
  readonly buffer: Buffer;
  readonly mimetype: string;
  readonly originalname: string;
  readonly size: number;
}
interface MultipartRequest extends RequestWithRequestId {
  readonly body?: Record<string, unknown>;
}

function requireKey(request: MultipartRequest): string {
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
    throw new InvalidReconciliationRequestError();
  return value;
}

@Controller('v1/reconciliation-imports')
@ApiTags('reconciliation')
@ApiBearerAuth('merchantApiKey')
export class ReconciliationController {
  public constructor(private readonly reconciliation: ReconciliationService) {}

  @Post()
  @HttpCode(202)
  @RequireMerchantScopes('reconciliation:write')
  @ApiExtension('x-required-scopes', ['reconciliation:write'])
  @ApiOperation({ summary: 'Stage one bounded mock-provider reconciliation CSV' })
  @ApiConsumes('multipart/form-data')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: reconciliationUploadSchema })
  @ApiAcceptedResponse({
    description: 'Import staged or idempotently replayed.',
    headers: requestIdResponseHeaders,
    schema: reconciliationImportSchema,
  })
  @ApiCreatedResponse({
    description: 'A deterministic failed/completed import or its replay.',
    headers: requestIdResponseHeaders,
    schema: reconciliationImportSchema,
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description: 'Malformed metadata or CSV.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'Merchant API key missing or invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'API key lacks reconciliation:write.',
    headers: requestIdResponseHeaders,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Idempotency or checksum conflict.',
    headers: conflictResponseHeaders,
    status: 409,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Upload exceeds accepted bounds.',
    headers: requestIdResponseHeaders,
    status: 413,
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
    }),
  )
  public async stage(
    @UploadedFile() file: UploadedCsv | undefined,
    @Req() request: MultipartRequest,
    @Res({ passthrough: true }) response: Response,
    @MerchantIdentity() identity: MerchantRequestIdentity,
  ): Promise<ReconciliationImportRepresentation> {
    const start = request.body?.['periodStart'];
    const end = request.body?.['periodEnd'];
    if (
      file === undefined ||
      typeof start !== 'string' ||
      typeof end !== 'string' ||
      Object.keys(request.body ?? {})
        .sort()
        .join(',') !== 'periodEnd,periodStart'
    )
      throw new InvalidReconciliationRequestError();
    const periodStart = new Date(start);
    const periodEnd = new Date(end);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(start) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(end) ||
      !Number.isFinite(periodStart.getTime()) ||
      !Number.isFinite(periodEnd.getTime()) ||
      periodStart.toISOString() !== start ||
      periodEnd.toISOString() !== end
    )
      throw new InvalidReconciliationRequestError();
    const result = await this.reconciliation.stage({
      actorApiKeyId: identity.apiKeyId,
      bytes: file.buffer,
      idempotencyKey: requireKey(request),
      merchantId: identity.merchantId,
      periodEnd,
      periodStart,
      requestId: getRequestId(request),
    });
    response.status(result.status === 'STAGED' ? 202 : 201);
    return result;
  }

  @Get(':id/report')
  @RequireMerchantScopes('reconciliation:read')
  @ApiExtension('x-required-scopes', ['reconciliation:read'])
  @ApiOperation({ summary: 'Read a completed reconciliation report' })
  @ApiOkResponse({
    description: 'Bounded mismatch evidence and ETB/USD summaries.',
    headers: requestIdResponseHeaders,
    schema: reconciliationReportSchema,
  })
  @ApiBadRequestResponse({
    content: problemContent,
    description: 'Invalid import identifier or limit.',
    headers: requestIdResponseHeaders,
  })
  @ApiUnauthorizedResponse({
    content: problemContent,
    description: 'Merchant API key missing or invalid.',
    headers: requestIdResponseHeaders,
  })
  @ApiForbiddenResponse({
    content: problemContent,
    description: 'API key lacks reconciliation:read.',
    headers: requestIdResponseHeaders,
  })
  @ApiNotFoundResponse({
    content: problemContent,
    description: 'Import missing or belongs to another merchant.',
    headers: requestIdResponseHeaders,
  })
  @ApiResponse({
    content: problemContent,
    description: 'Report is not complete.',
    headers: requestIdResponseHeaders,
    status: 409,
  })
  public report(
    @Param('id') id: string,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @MerchantIdentity() identity: MerchantRequestIdentity,
  ): Promise<ReconciliationReportRepresentation> {
    return this.reconciliation.getReport(
      identity.merchantId,
      id,
      limit === undefined ? 20 : Number(limit),
      cursor,
    );
  }
}
