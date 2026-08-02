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
  CaptureAmountMismatchError,
  ExternalReferenceConflictError,
  IdentifierGenerationExhaustedError,
  InvalidPaymentIntentRequestError,
  PaymentCurrencyMismatchError,
  PaymentIntentNotCapturableError,
  PaymentIntentNotFoundError,
  PaymentIntentNotRefundableError,
  PaymentProviderDeclinedError,
  PaymentProviderUnavailableError,
  RefundAmountExceedsAvailableError,
  RefundExternalReferenceConflictError,
  UnsupportedCaptureMethodError,
  UnsupportedPaymentCurrencyError,
} from '@settleflow/payments';
import {
  InvalidWebhookEndpointRequestError,
  UnsupportedWebhookEventError,
  WebhookEndpointIdentifierCollisionError,
  WebhookEndpointIdentifierGenerationExhaustedError,
  WebhookEndpointNotFoundError,
  WebhookEndpointPreconditionFailedError,
  WebhookEndpointPreconditionRequiredError,
  WebhookEndpointUrlConflictError,
  WebhookEndpointUrlProhibitedError,
  WebhookEndpointUrlResolutionUnavailableError,
  WebhookEndpointUrlUnresolvableError,
  WebhookKeyringUnavailableError,
} from '@settleflow/webhooks';

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
  if (error instanceof InvalidWebhookEndpointRequestError) {
    return {
      code: 'invalid_request',
      detail: 'The request is invalid.',
      status: HttpStatus.BAD_REQUEST,
      title: 'Invalid request',
      ...(error.field === undefined ? {} : { violationField: error.field }),
    };
  }
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
  if (error instanceof WebhookEndpointNotFoundError) {
    return {
      code: 'webhook_endpoint_not_found',
      detail: 'The webhook endpoint was not found.',
      status: HttpStatus.NOT_FOUND,
      title: 'Webhook endpoint not found',
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
  if (error instanceof PaymentCurrencyMismatchError) {
    return {
      code: 'currency_mismatch',
      detail: 'The command currency does not match the payment currency.',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: 'Currency mismatch',
    };
  }
  if (error instanceof CaptureAmountMismatchError) {
    return {
      code: 'capture_amount_mismatch',
      detail: 'The capture amount must equal the full payment amount.',
      status: HttpStatus.CONFLICT,
      title: 'Capture amount mismatch',
    };
  }
  if (error instanceof PaymentIntentNotCapturableError) {
    return {
      code: 'payment_intent_not_capturable',
      detail: 'The payment intent cannot be captured in its current state.',
      status: HttpStatus.CONFLICT,
      title: 'Payment intent not capturable',
    };
  }
  if (error instanceof PaymentIntentNotRefundableError) {
    return {
      code: 'payment_intent_not_refundable',
      detail: 'The payment intent cannot be refunded in its current state.',
      status: HttpStatus.CONFLICT,
      title: 'Payment intent not refundable',
    };
  }
  if (error instanceof RefundAmountExceedsAvailableError) {
    return {
      code: 'refund_amount_exceeds_available',
      detail: 'The refund amount exceeds the remaining captured amount.',
      status: HttpStatus.CONFLICT,
      title: 'Refund amount exceeds available',
    };
  }
  if (error instanceof RefundExternalReferenceConflictError) {
    return {
      code: 'refund_external_reference_conflict',
      detail: 'The refund external reference is already used by this merchant.',
      status: HttpStatus.CONFLICT,
      title: 'Refund external reference conflict',
    };
  }
  if (error instanceof PaymentProviderDeclinedError) {
    return {
      code: 'payment_provider_declined',
      detail: 'The simulated payment provider declined the command.',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: 'Payment provider declined',
    };
  }
  if (error instanceof WebhookEndpointUrlConflictError) {
    return {
      code: 'webhook_endpoint_url_conflict',
      detail: 'The normalized webhook URL is already registered for this merchant.',
      status: HttpStatus.CONFLICT,
      title: 'Webhook endpoint URL conflict',
    };
  }
  if (error instanceof WebhookEndpointPreconditionFailedError) {
    return {
      code: 'precondition_failed',
      detail: 'The webhook endpoint has changed since it was read.',
      status: HttpStatus.PRECONDITION_FAILED,
      title: 'Precondition failed',
    };
  }
  if (error instanceof WebhookEndpointPreconditionRequiredError) {
    return {
      code: 'precondition_required',
      detail: 'A current If-Match header is required.',
      status: 428,
      title: 'Precondition required',
    };
  }
  if (error instanceof UnsupportedWebhookEventError) {
    return {
      code: 'unsupported_webhook_event',
      detail: 'The requested webhook event is not supported.',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: 'Unsupported webhook event',
    };
  }
  if (error instanceof WebhookEndpointUrlProhibitedError) {
    return {
      code: 'webhook_endpoint_url_prohibited',
      detail: 'The webhook endpoint URL is prohibited by policy.',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: 'Webhook endpoint URL prohibited',
    };
  }
  if (error instanceof WebhookEndpointUrlUnresolvableError) {
    return {
      code: 'webhook_endpoint_url_unresolvable',
      detail: 'The webhook endpoint hostname cannot be resolved.',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: 'Webhook endpoint URL unresolvable',
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
    error instanceof PaymentProviderUnavailableError ||
    error instanceof WebhookEndpointIdentifierCollisionError ||
    error instanceof WebhookEndpointIdentifierGenerationExhaustedError ||
    error instanceof WebhookEndpointUrlResolutionUnavailableError ||
    error instanceof WebhookKeyringUnavailableError ||
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
