import { randomUUID } from 'node:crypto';

import { EventIdentifierCollisionError, EventingService } from '@settleflow/eventing';
import { IdempotencyService, type StoredHttpResponse } from '@settleflow/idempotency';
import { MonotonicUlidGenerator } from '@settleflow/infrastructure';
import { LedgerIdentifierCollisionError, type LedgerPostingPort } from '@settleflow/ledger';

import type { PaymentExecutionPort } from './payment-execution';
import {
  CaptureAmountMismatchError,
  ExternalReferenceConflictError,
  IdentifierGenerationExhaustedError,
  PaymentCurrencyMismatchError,
  PaymentIdentifierCollisionError,
  PaymentIntentNotCapturableError,
  PaymentIntentNotFoundError,
  PaymentIntentNotRefundableError,
  PaymentProviderDeclinedError,
  PaymentProviderUnavailableError,
  RefundAmountExceedsAvailableError,
  RefundExternalReferenceConflictError,
  RefundIdentifierCollisionError,
} from './payments.errors';
import type {
  CapturePaymentIntentCommand,
  CapturedPaymentIntentRepresentation,
  CreatePaymentIntentCommand,
  PaymentCommandObserver,
  PaymentIntentRecord,
  PaymentIntentRepresentation,
  PaymentIntentRepository,
  RefundPaymentIntentCommand,
  RefundRepresentation,
} from './payments.types';
import { assertValidPaymentIntentId } from './payment-intent.validation';

const MAX_IDENTIFIER_ATTEMPTS = 3;

function canonicalCreateCommand(command: CreatePaymentIntentCommand): string {
  return JSON.stringify({
    v: 1,
    externalRef: command.externalRef,
    amountMinor: String(command.amountMinor),
    currency: command.currency,
    captureMethod: command.captureMethod,
  });
}

function canonicalCaptureCommand(command: CapturePaymentIntentCommand): string {
  return JSON.stringify({
    v: 1,
    paymentId: command.paymentId,
    amountMinor: String(command.amountMinor),
    currency: command.currency,
  });
}

function canonicalRefundCommand(command: RefundPaymentIntentCommand): string {
  return JSON.stringify({
    v: 1,
    paymentId: command.paymentId,
    externalRef: command.externalRef,
    amountMinor: String(command.amountMinor),
    currency: command.currency,
  });
}

function toRepresentation(record: PaymentIntentRecord): PaymentIntentRepresentation {
  return {
    amountMinor: record.amountMinor,
    captureMethod: record.captureMethod,
    capturedAmountMinor: record.capturedAmountMinor,
    createdAt: record.createdAt.toISOString(),
    currency: record.currency,
    externalRef: record.externalRef,
    id: record.publicId,
    paymentStatus: record.paymentStatus,
    refundedAmountMinor: record.refundedAmountMinor,
    settlementStatus: 'NOT_ELIGIBLE',
    updatedAt: record.updatedAt.toISOString(),
    version: record.version,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPaymentIntentRepresentation(value: unknown): value is PaymentIntentRepresentation {
  if (!isRecord(value)) return false;
  return (
    typeof value['id'] === 'string' &&
    typeof value['externalRef'] === 'string' &&
    typeof value['amountMinor'] === 'number' &&
    Number.isSafeInteger(value['amountMinor']) &&
    (value['currency'] === 'ETB' || value['currency'] === 'USD') &&
    value['captureMethod'] === 'manual' &&
    (value['paymentStatus'] === 'created' ||
      value['paymentStatus'] === 'captured' ||
      value['paymentStatus'] === 'partially_refunded' ||
      value['paymentStatus'] === 'refunded') &&
    value['settlementStatus'] === 'NOT_ELIGIBLE' &&
    typeof value['capturedAmountMinor'] === 'number' &&
    typeof value['refundedAmountMinor'] === 'number' &&
    typeof value['version'] === 'number' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string'
  );
}

function isCapturedRepresentation(value: unknown): value is CapturedPaymentIntentRepresentation {
  return (
    isPaymentIntentRepresentation(value) &&
    value.paymentStatus === 'captured' &&
    isRecord(value) &&
    typeof value['ledgerTransactionId'] === 'string'
  );
}

function isRefundRepresentation(value: unknown): value is RefundRepresentation {
  if (!isRecord(value)) return false;
  return (
    typeof value['id'] === 'string' &&
    typeof value['paymentId'] === 'string' &&
    typeof value['externalRef'] === 'string' &&
    typeof value['amountMinor'] === 'number' &&
    Number.isSafeInteger(value['amountMinor']) &&
    (value['currency'] === 'ETB' || value['currency'] === 'USD') &&
    (value['paymentStatus'] === 'partially_refunded' || value['paymentStatus'] === 'refunded') &&
    typeof value['cumulativeRefundedAmountMinor'] === 'number' &&
    typeof value['ledgerTransactionId'] === 'string' &&
    typeof value['createdAt'] === 'string'
  );
}

function problem(
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
): StoredHttpResponse {
  return {
    body: {
      code,
      detail,
      requestId,
      status,
      title,
      type: `https://docs.settleflow.dev/problems/${code}`,
    },
    contentType: 'application/problem+json',
    headers: {},
    status,
  };
}

function externalReferenceProblem(requestId: string): StoredHttpResponse {
  return problem(
    requestId,
    409,
    'external_reference_conflict',
    'External reference conflict',
    'The external reference is already used by this merchant.',
  );
}

function commandProblem(error: Error, requestId: string): StoredHttpResponse {
  if (error instanceof ExternalReferenceConflictError) {
    return externalReferenceProblem(requestId);
  }
  if (error instanceof PaymentIntentNotFoundError) {
    return problem(
      requestId,
      404,
      'payment_intent_not_found',
      'Payment intent not found',
      'The payment intent was not found.',
    );
  }
  if (error instanceof PaymentCurrencyMismatchError) {
    return problem(
      requestId,
      422,
      'currency_mismatch',
      'Currency mismatch',
      'The command currency does not match the payment currency.',
    );
  }
  if (error instanceof CaptureAmountMismatchError) {
    return problem(
      requestId,
      409,
      'capture_amount_mismatch',
      'Capture amount mismatch',
      'The capture amount must equal the full payment amount.',
    );
  }
  if (error instanceof PaymentIntentNotCapturableError) {
    return problem(
      requestId,
      409,
      'payment_intent_not_capturable',
      'Payment intent not capturable',
      'The payment intent cannot be captured in its current state.',
    );
  }
  if (error instanceof PaymentIntentNotRefundableError) {
    return problem(
      requestId,
      409,
      'payment_intent_not_refundable',
      'Payment intent not refundable',
      'The payment intent cannot be refunded in its current state.',
    );
  }
  if (error instanceof RefundAmountExceedsAvailableError) {
    return problem(
      requestId,
      409,
      'refund_amount_exceeds_available',
      'Refund amount exceeds available',
      'The refund amount exceeds the remaining captured amount.',
    );
  }
  if (error instanceof RefundExternalReferenceConflictError) {
    return problem(
      requestId,
      409,
      'refund_external_reference_conflict',
      'Refund external reference conflict',
      'The refund external reference is already used by this merchant.',
    );
  }
  if (error instanceof PaymentProviderDeclinedError) {
    return problem(
      requestId,
      422,
      'payment_provider_declined',
      'Payment provider declined',
      'The simulated payment provider declined the command.',
    );
  }
  throw error;
}

function replayError(response: StoredHttpResponse): never {
  const code = isRecord(response.body) ? response.body['code'] : undefined;
  const errors: Readonly<Record<string, () => Error>> = {
    capture_amount_mismatch: () => new CaptureAmountMismatchError(),
    currency_mismatch: () => new PaymentCurrencyMismatchError(),
    payment_intent_not_capturable: () => new PaymentIntentNotCapturableError(),
    payment_intent_not_found: () => new PaymentIntentNotFoundError(),
    payment_intent_not_refundable: () => new PaymentIntentNotRefundableError(),
    payment_provider_declined: () => new PaymentProviderDeclinedError(),
    refund_amount_exceeds_available: () => new RefundAmountExceedsAvailableError(),
    refund_external_reference_conflict: () => new RefundExternalReferenceConflictError(),
  };
  const factory = typeof code === 'string' ? errors[code] : undefined;
  if (factory === undefined) throw new Error('Stored idempotency response is outside the contract');
  throw factory();
}

type CommandResult<T> =
  { readonly error: Error; readonly kind: 'error' } | { readonly kind: 'ok'; readonly value: T };

function observationCode(error: unknown): string {
  if (error instanceof CaptureAmountMismatchError) return 'capture_amount_mismatch';
  if (error instanceof PaymentCurrencyMismatchError) return 'currency_mismatch';
  if (error instanceof PaymentIntentNotCapturableError) return 'payment_intent_not_capturable';
  if (error instanceof PaymentIntentNotFoundError) return 'payment_intent_not_found';
  if (error instanceof PaymentIntentNotRefundableError) return 'payment_intent_not_refundable';
  if (error instanceof PaymentProviderDeclinedError) return 'payment_provider_declined';
  if (error instanceof PaymentProviderUnavailableError) return 'payment_provider_unavailable';
  if (error instanceof RefundAmountExceedsAvailableError) return 'refund_amount_exceeds_available';
  if (error instanceof RefundExternalReferenceConflictError) {
    return 'refund_external_reference_conflict';
  }
  if (error instanceof IdentifierGenerationExhaustedError) return 'identifier_generation_exhausted';
  return 'internal_error';
}

export class PaymentIntentService {
  public constructor(
    private readonly repository: PaymentIntentRepository,
    private readonly idempotency: IdempotencyService,
    private readonly eventing: EventingService,
    private readonly ledger: LedgerPostingPort,
    private readonly execution: PaymentExecutionPort,
    private readonly identifiers: MonotonicUlidGenerator,
    private readonly clock: () => Date = () => new Date(),
    private readonly uuid: () => string = randomUUID,
    private readonly observer?: PaymentCommandObserver,
  ) {}

  public async create(command: CreatePaymentIntentCommand): Promise<PaymentIntentRepresentation> {
    const acquisition = await this.idempotency.acquire({
      canonicalRequest: canonicalCreateCommand(command),
      key: command.idempotencyKey,
      merchantId: command.merchantId,
      method: 'POST',
      normalizedRoute: '/v1/payment-intents',
      now: this.clock(),
    });
    if (acquisition.kind === 'replay') {
      if (acquisition.response.status === 409) throw new ExternalReferenceConflictError();
      if (
        acquisition.response.status !== 201 ||
        !isPaymentIntentRepresentation(acquisition.response.body)
      ) {
        throw new Error('Stored idempotency response is outside the Payment Intent contract');
      }
      return acquisition.response.body;
    }

    for (let attempt = 1; attempt <= MAX_IDENTIFIER_ATTEMPTS; attempt += 1) {
      const occurredAt = this.clock();
      const paymentId = `pi_${this.identifiers.generate(occurredAt.getTime())}`;
      const event = this.eventing.createPaymentCreatedEvent(
        {
          amountMinor: command.amountMinor,
          currency: command.currency,
          merchantId: command.merchantId,
          paymentId,
          requestId: command.requestId,
        },
        occurredAt,
      );
      try {
        return await this.idempotency.complete(acquisition.ownership, async (transaction) => {
          const record = await this.repository.create(transaction, {
            amountMinor: command.amountMinor,
            currency: command.currency,
            externalRef: command.externalRef,
            merchantId: command.merchantId,
            publicId: paymentId,
          });
          await this.eventing.persistPaymentCreated(transaction, event);
          const response = toRepresentation(record);
          return {
            response: {
              body: response,
              contentType: 'application/json',
              headers: {},
              resultReference: response.id,
              status: 201,
            },
            value: response,
          };
        });
      } catch (error: unknown) {
        if (error instanceof ExternalReferenceConflictError) {
          await this.completeProblem(acquisition.ownership, error, command.requestId);
          throw error;
        }
        if (
          error instanceof PaymentIdentifierCollisionError ||
          error instanceof EventIdentifierCollisionError
        ) {
          if (attempt < MAX_IDENTIFIER_ATTEMPTS) continue;
          throw new IdentifierGenerationExhaustedError();
        }
        throw error;
      }
    }
    throw new IdentifierGenerationExhaustedError();
  }

  public async capture(
    command: CapturePaymentIntentCommand,
  ): Promise<CapturedPaymentIntentRepresentation> {
    assertValidPaymentIntentId(command.paymentId);
    const acquisition = await this.idempotency.acquire({
      canonicalRequest: canonicalCaptureCommand(command),
      key: command.idempotencyKey,
      merchantId: command.merchantId,
      method: 'POST',
      normalizedRoute: '/v1/payment-intents/{id}/capture',
      now: this.clock(),
    });
    if (acquisition.kind === 'replay') {
      if (
        acquisition.response.status === 200 &&
        isCapturedRepresentation(acquisition.response.body)
      ) {
        this.observe({
          merchantId: command.merchantId,
          operation: 'capture',
          outcome: 'replayed',
          paymentId: command.paymentId,
          requestId: command.requestId,
        });
        return acquisition.response.body;
      }
      return replayError(acquisition.response);
    }

    try {
      await this.executeProvider(
        () =>
          this.execution.capture({
            amountMinor: command.amountMinor,
            currency: command.currency,
            paymentId: command.paymentId,
          }),
        acquisition.ownership,
        command.requestId,
      );
    } catch (error: unknown) {
      this.observeRejected('capture', command, error);
      throw error;
    }
    for (let attempt = 1; attempt <= MAX_IDENTIFIER_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.idempotency.complete<
          CommandResult<CapturedPaymentIntentRepresentation>
        >(acquisition.ownership, async (transaction) => {
          const locked = await this.repository.lockByPublicId(
            transaction,
            command.merchantId,
            command.paymentId,
          );
          const validationError = this.captureError(locked?.payment, command);
          if (validationError !== undefined)
            return this.errorResult(validationError, command.requestId);
          const payment = locked!.payment;
          const occurredAt = locked!.transactionTime;
          const ledger = await this.ledger.postCapture(transaction, {
            amountMinor: BigInt(command.amountMinor),
            businessReference: payment.publicId,
            currency: payment.currency,
            merchantId: command.merchantId,
            occurredAt,
            requestId: command.requestId,
          });
          const updated = await this.repository.capture(transaction, payment, occurredAt);
          const event = this.eventing.createPaymentCapturedEvent(
            {
              availableOn: occurredAt,
              capturedAmountMinor: updated.capturedAmountMinor,
              currency: updated.currency,
              ledgerTransactionId: ledger.publicId,
              merchantId: command.merchantId,
              paymentId: updated.publicId,
              requestId: command.requestId,
            },
            occurredAt,
          );
          await this.eventing.persistPaymentEvent(transaction, event);
          const response: CapturedPaymentIntentRepresentation = {
            ...toRepresentation(updated),
            ledgerTransactionId: ledger.publicId,
            paymentStatus: 'captured',
          };
          return {
            response: {
              body: response,
              contentType: 'application/json',
              headers: {},
              resultReference: updated.publicId,
              status: 200,
            },
            value: {
              kind: 'ok',
              value: response,
            } as CommandResult<CapturedPaymentIntentRepresentation>,
          };
        });
        const response = this.unwrap(result);
        this.observe({
          ledgerTransactionId: response.ledgerTransactionId,
          merchantId: command.merchantId,
          operation: 'capture',
          outcome: 'committed',
          paymentId: command.paymentId,
          requestId: command.requestId,
        });
        return response;
      } catch (error: unknown) {
        if (
          error instanceof EventIdentifierCollisionError ||
          error instanceof LedgerIdentifierCollisionError
        ) {
          if (attempt < MAX_IDENTIFIER_ATTEMPTS) continue;
          const exhausted = new IdentifierGenerationExhaustedError();
          this.observeRejected('capture', command, exhausted);
          throw exhausted;
        }
        this.observeRejected('capture', command, error);
        throw error;
      }
    }
    throw new IdentifierGenerationExhaustedError();
  }

  public async refund(command: RefundPaymentIntentCommand): Promise<RefundRepresentation> {
    assertValidPaymentIntentId(command.paymentId);
    const acquisition = await this.idempotency.acquire({
      canonicalRequest: canonicalRefundCommand(command),
      key: command.idempotencyKey,
      merchantId: command.merchantId,
      method: 'POST',
      normalizedRoute: '/v1/payment-intents/{id}/refunds',
      now: this.clock(),
    });
    if (acquisition.kind === 'replay') {
      if (
        acquisition.response.status === 201 &&
        isRefundRepresentation(acquisition.response.body)
      ) {
        this.observe({
          merchantId: command.merchantId,
          operation: 'refund',
          outcome: 'replayed',
          paymentId: command.paymentId,
          refundId: acquisition.response.body.id,
          requestId: command.requestId,
        });
        return acquisition.response.body;
      }
      return replayError(acquisition.response);
    }

    try {
      await this.executeProvider(
        () =>
          this.execution.refund({
            amountMinor: command.amountMinor,
            currency: command.currency,
            paymentId: command.paymentId,
          }),
        acquisition.ownership,
        command.requestId,
      );
    } catch (error: unknown) {
      this.observeRejected('refund', command, error);
      throw error;
    }
    for (let attempt = 1; attempt <= MAX_IDENTIFIER_ATTEMPTS; attempt += 1) {
      const refundId = `rf_${this.identifiers.generate(this.clock().getTime())}`;
      try {
        const result = await this.idempotency.complete<CommandResult<RefundRepresentation>>(
          acquisition.ownership,
          async (transaction) => {
            const locked = await this.repository.lockByPublicId(
              transaction,
              command.merchantId,
              command.paymentId,
            );
            const validationError = this.refundError(locked?.payment, command);
            if (validationError !== undefined)
              return this.errorResult(validationError, command.requestId);
            const payment = locked!.payment;
            const occurredAt = locked!.transactionTime;
            const refund = await this.repository.createRefund(transaction, {
              amountMinor: command.amountMinor,
              createdAt: occurredAt,
              currency: payment.currency,
              externalRef: command.externalRef,
              id: this.uuid(),
              merchantId: command.merchantId,
              paymentIntentId: payment.id,
              publicId: refundId,
            });
            const ledger = await this.ledger.postRefund(transaction, {
              amountMinor: BigInt(command.amountMinor),
              businessReference: refund.publicId,
              currency: payment.currency,
              merchantId: command.merchantId,
              occurredAt,
              requestId: command.requestId,
            });
            const updated = await this.repository.applyRefund(
              transaction,
              payment,
              command.amountMinor,
              occurredAt,
            );
            const event = this.eventing.createPaymentRefundedEvent(
              {
                amountMinor: command.amountMinor,
                cumulativeRefundedAmountMinor: updated.refundedAmountMinor,
                currency: updated.currency,
                ledgerTransactionId: ledger.publicId,
                merchantId: command.merchantId,
                paymentId: updated.publicId,
                refundId: refund.publicId,
                requestId: command.requestId,
              },
              occurredAt,
            );
            await this.eventing.persistPaymentEvent(transaction, event);
            const response: RefundRepresentation = {
              amountMinor: refund.amountMinor,
              createdAt: refund.createdAt.toISOString(),
              cumulativeRefundedAmountMinor: updated.refundedAmountMinor,
              currency: refund.currency,
              externalRef: refund.externalRef,
              id: refund.publicId,
              ledgerTransactionId: ledger.publicId,
              paymentId: updated.publicId,
              paymentStatus:
                updated.paymentStatus === 'refunded' ? 'refunded' : 'partially_refunded',
            };
            return {
              response: {
                body: response,
                contentType: 'application/json',
                headers: {},
                resultReference: refund.publicId,
                status: 201,
              },
              value: { kind: 'ok', value: response } as CommandResult<RefundRepresentation>,
            };
          },
        );
        const response = this.unwrap(result);
        this.observe({
          ledgerTransactionId: response.ledgerTransactionId,
          merchantId: command.merchantId,
          operation: 'refund',
          outcome: 'committed',
          paymentId: command.paymentId,
          refundId: response.id,
          requestId: command.requestId,
        });
        return response;
      } catch (error: unknown) {
        if (error instanceof RefundExternalReferenceConflictError) {
          await this.completeProblem(acquisition.ownership, error, command.requestId);
          this.observeRejected('refund', command, error);
          throw error;
        }
        if (
          error instanceof RefundIdentifierCollisionError ||
          error instanceof EventIdentifierCollisionError ||
          error instanceof LedgerIdentifierCollisionError
        ) {
          if (attempt < MAX_IDENTIFIER_ATTEMPTS) continue;
          const exhausted = new IdentifierGenerationExhaustedError();
          this.observeRejected('refund', command, exhausted);
          throw exhausted;
        }
        this.observeRejected('refund', command, error);
        throw error;
      }
    }
    throw new IdentifierGenerationExhaustedError();
  }

  public async get(merchantId: string, publicId: string): Promise<PaymentIntentRepresentation> {
    assertValidPaymentIntentId(publicId);
    const record = await this.repository.findByPublicId(merchantId, publicId);
    if (record === undefined) throw new PaymentIntentNotFoundError();
    return toRepresentation(record);
  }

  private captureError(
    payment: PaymentIntentRecord | undefined,
    command: CapturePaymentIntentCommand,
  ): Error | undefined {
    if (payment === undefined) return new PaymentIntentNotFoundError();
    if (payment.currency !== command.currency) return new PaymentCurrencyMismatchError();
    if (payment.paymentStatus !== 'created') return new PaymentIntentNotCapturableError();
    if (payment.amountMinor !== command.amountMinor) return new CaptureAmountMismatchError();
    return undefined;
  }

  private refundError(
    payment: PaymentIntentRecord | undefined,
    command: RefundPaymentIntentCommand,
  ): Error | undefined {
    if (payment === undefined) return new PaymentIntentNotFoundError();
    if (payment.currency !== command.currency) return new PaymentCurrencyMismatchError();
    if (payment.paymentStatus !== 'captured' && payment.paymentStatus !== 'partially_refunded') {
      return new PaymentIntentNotRefundableError();
    }
    const remaining = BigInt(payment.capturedAmountMinor) - BigInt(payment.refundedAmountMinor);
    if (BigInt(command.amountMinor) > remaining) return new RefundAmountExceedsAvailableError();
    return undefined;
  }

  private errorResult<T>(
    error: Error,
    requestId: string,
  ): Promise<{ readonly response: StoredHttpResponse; readonly value: CommandResult<T> }> {
    const value: CommandResult<T> = { error, kind: 'error' };
    return Promise.resolve({
      response: commandProblem(error, requestId),
      value,
    });
  }

  private unwrap<T>(result: CommandResult<T>): T {
    if (result.kind === 'error') throw result.error;
    return result.value;
  }

  private async completeProblem(
    ownership: Parameters<IdempotencyService['complete']>[0],
    error: Error,
    requestId: string,
  ): Promise<void> {
    await this.idempotency.complete(ownership, () =>
      Promise.resolve({ response: commandProblem(error, requestId), value: undefined }),
    );
  }

  private async executeProvider(
    operation: () => Promise<{ readonly kind: 'approved' | 'declined' }>,
    ownership: Parameters<IdempotencyService['complete']>[0],
    requestId: string,
  ): Promise<void> {
    let result: { readonly kind: 'approved' | 'declined' };
    try {
      result = await operation();
    } catch {
      throw new PaymentProviderUnavailableError();
    }
    if (result.kind === 'declined') {
      const error = new PaymentProviderDeclinedError();
      await this.completeProblem(ownership, error, requestId);
      throw error;
    }
  }

  private observeRejected(
    operation: 'capture' | 'refund',
    command: CapturePaymentIntentCommand | RefundPaymentIntentCommand,
    error: unknown,
  ): void {
    this.observe({
      code: observationCode(error),
      merchantId: command.merchantId,
      operation,
      outcome: 'rejected',
      paymentId: command.paymentId,
      requestId: command.requestId,
    });
  }

  private observe(observation: Parameters<PaymentCommandObserver['record']>[0]): void {
    try {
      this.observer?.record(observation);
    } catch {
      // Observability must never decide a financial command.
    }
  }
}

export const paymentIntentServiceInternals = {
  canonicalCaptureCommand,
  canonicalCreateCommand,
  canonicalRefundCommand,
  commandProblem,
  externalReferenceProblem,
  isCapturedRepresentation,
  isPaymentIntentRepresentation,
  isRefundRepresentation,
  observationCode,
  replayError,
  toRepresentation,
};
