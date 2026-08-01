import {
  ArgumentsHost,
  Catch,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  IdempotencyKeyExpiredError,
  IdempotencyKeyReusedError,
  IdempotencyOwnershipLostError,
  IdempotencyRequestInProgressError,
} from '@settleflow/idempotency';
import {
  DatabaseUnavailableError,
  isDatabaseUnavailableError,
  isTransientTransactionError,
} from '@settleflow/infrastructure';
import {
  ExternalReferenceConflictError,
  IdentifierGenerationExhaustedError,
  InvalidPaymentIntentRequestError,
  PaymentIntentNotFoundError,
  UnsupportedCaptureMethodError,
  UnsupportedPaymentCurrencyError,
} from '@settleflow/payments';

import { getRequestId, type RequestWithRequestId } from './request-id';

interface ProblemDetails {
  readonly code: string;
  readonly detail: string;
  readonly requestId: string;
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly violations?: readonly { readonly field: string; readonly reason: 'invalid' }[];
}

interface ProblemDescriptor {
  readonly code: string;
  readonly detail: string;
  readonly status: number;
  readonly title: string;
  readonly retryAfter?: '1';
  readonly violationField?: string;
}

interface ProblemResponse {
  json(body: ProblemDetails): void;
  setHeader(name: string, value: string): void;
  status(status: number): ProblemResponse;
  type(contentType: string): ProblemResponse;
}

function descriptor(error: unknown): ProblemDescriptor {
  if (error instanceof InvalidPaymentIntentRequestError) {
    return {
      code: 'invalid_request',
      detail: 'The request is invalid.',
      status: HttpStatus.BAD_REQUEST,
      title: 'Invalid request',
      ...(error.field === undefined ? {} : { violationField: error.field }),
    };
  }
  if (error instanceof UnauthorizedException) {
    return {
      code: 'unauthorized',
      detail: 'A valid merchant API key is required.',
      status: HttpStatus.UNAUTHORIZED,
      title: 'Unauthorized',
    };
  }
  if (error instanceof ForbiddenException) {
    return {
      code: 'insufficient_scope',
      detail: 'The merchant API key lacks the required scope.',
      status: HttpStatus.FORBIDDEN,
      title: 'Insufficient scope',
    };
  }
  if (error instanceof PaymentIntentNotFoundError) {
    return {
      code: 'payment_intent_not_found',
      detail: 'The payment intent was not found.',
      status: HttpStatus.NOT_FOUND,
      title: 'Payment intent not found',
    };
  }
  if (error instanceof UnsupportedPaymentCurrencyError) {
    return {
      code: 'unsupported_currency',
      detail: 'The requested currency is not supported.',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: 'Unsupported currency',
    };
  }
  if (error instanceof UnsupportedCaptureMethodError) {
    return {
      code: 'unsupported_capture_method',
      detail: 'The requested capture method is not supported.',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: 'Unsupported capture method',
    };
  }
  if (error instanceof IdempotencyKeyReusedError) {
    return {
      code: 'idempotency_key_reused',
      detail: 'The key was previously used with a different request fingerprint.',
      status: HttpStatus.CONFLICT,
      title: 'Idempotency key conflict',
    };
  }
  if (
    error instanceof IdempotencyRequestInProgressError ||
    error instanceof IdempotencyOwnershipLostError
  ) {
    return {
      code: 'idempotency_request_in_progress',
      detail: 'A request with this idempotency key is still in progress.',
      retryAfter: '1',
      status: HttpStatus.CONFLICT,
      title: 'Idempotent request in progress',
    };
  }
  if (error instanceof IdempotencyKeyExpiredError) {
    return {
      code: 'idempotency_key_expired',
      detail: 'The stored response for this idempotency key has expired.',
      status: HttpStatus.CONFLICT,
      title: 'Idempotency key expired',
    };
  }
  if (error instanceof ExternalReferenceConflictError) {
    return {
      code: 'external_reference_conflict',
      detail: 'The external reference is already used by this merchant.',
      status: HttpStatus.CONFLICT,
      title: 'External reference conflict',
    };
  }
  if (error instanceof NotFoundException) {
    return {
      code: 'route_not_found',
      detail: 'The requested route was not found.',
      status: HttpStatus.NOT_FOUND,
      title: 'Route not found',
    };
  }
  if (
    error instanceof IdentifierGenerationExhaustedError ||
    error instanceof DatabaseUnavailableError ||
    isDatabaseUnavailableError(error) ||
    isTransientTransactionError(error)
  ) {
    return {
      code: 'service_unavailable',
      detail: 'The service is temporarily unavailable.',
      status: HttpStatus.SERVICE_UNAVAILABLE,
      title: 'Service unavailable',
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === 503) {
      return {
        code: 'service_unavailable',
        detail: 'The service is temporarily unavailable.',
        status,
        title: 'Service unavailable',
      };
    }
    if (status >= 400 && status < 500) {
      return {
        code: 'invalid_request',
        detail: 'The request is invalid.',
        status: HttpStatus.BAD_REQUEST,
        title: 'Invalid request',
      };
    }
  }

  return {
    code: 'internal_error',
    detail: 'An unexpected error occurred.',
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    title: 'Internal error',
  };
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  public catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithRequestId>();
    const response = http.getResponse<ProblemResponse>();
    const problem = descriptor(error);
    const requestId = getRequestId(request);
    const body: ProblemDetails = {
      code: problem.code,
      detail: problem.detail,
      requestId,
      status: problem.status,
      title: problem.title,
      type: `https://docs.settleflow.dev/problems/${problem.code}`,
      ...(problem.violationField === undefined
        ? {}
        : { violations: [{ field: problem.violationField, reason: 'invalid' }] }),
    };

    if (problem.retryAfter !== undefined) {
      response.setHeader('Retry-After', problem.retryAfter);
    }
    if (problem.status >= 500) {
      this.logger.error(
        JSON.stringify({
          code: problem.code,
          event: 'api.request_failed',
          requestId,
          status: problem.status,
        }),
      );
    }
    response.status(problem.status).type('application/problem+json').json(body);
  }
}

export const problemDetailsInternals = { descriptor };
