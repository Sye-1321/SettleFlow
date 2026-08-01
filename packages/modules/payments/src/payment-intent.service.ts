import { EventIdentifierCollisionError, EventingService } from '@settleflow/eventing';
import { IdempotencyService, type StoredHttpResponse } from '@settleflow/idempotency';
import { MonotonicUlidGenerator } from '@settleflow/infrastructure';

import {
  ExternalReferenceConflictError,
  IdentifierGenerationExhaustedError,
  PaymentIdentifierCollisionError,
  PaymentIntentNotFoundError,
} from './payments.errors';
import type {
  CreatePaymentIntentCommand,
  PaymentIntentRecord,
  PaymentIntentRepresentation,
  PaymentIntentRepository,
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

function isPaymentIntentRepresentation(value: unknown): value is PaymentIntentRepresentation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['externalRef'] === 'string' &&
    typeof record['amountMinor'] === 'number' &&
    Number.isSafeInteger(record['amountMinor']) &&
    (record['currency'] === 'ETB' || record['currency'] === 'USD') &&
    record['captureMethod'] === 'manual' &&
    record['paymentStatus'] === 'created' &&
    record['settlementStatus'] === 'NOT_ELIGIBLE' &&
    record['capturedAmountMinor'] === 0 &&
    record['refundedAmountMinor'] === 0 &&
    record['version'] === 0 &&
    typeof record['createdAt'] === 'string' &&
    typeof record['updatedAt'] === 'string'
  );
}

function externalReferenceProblem(requestId: string): StoredHttpResponse {
  return {
    body: {
      code: 'external_reference_conflict',
      detail: 'The external reference is already used by this merchant.',
      requestId,
      status: 409,
      title: 'External reference conflict',
      type: 'https://docs.settleflow.dev/problems/external_reference_conflict',
    },
    contentType: 'application/problem+json',
    headers: {},
    status: 409,
  };
}

export class PaymentIntentService {
  public constructor(
    private readonly repository: PaymentIntentRepository,
    private readonly idempotency: IdempotencyService,
    private readonly eventing: EventingService,
    private readonly identifiers: MonotonicUlidGenerator,
    private readonly clock: () => Date = () => new Date(),
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
      if (acquisition.response.status === 409) {
        throw new ExternalReferenceConflictError();
      }
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
          await this.idempotency.complete(acquisition.ownership, () =>
            Promise.resolve({
              response: externalReferenceProblem(command.requestId),
              value: undefined,
            }),
          );
          throw error;
        }
        if (
          error instanceof PaymentIdentifierCollisionError ||
          error instanceof EventIdentifierCollisionError
        ) {
          if (attempt < MAX_IDENTIFIER_ATTEMPTS) {
            continue;
          }
          throw new IdentifierGenerationExhaustedError();
        }
        throw error;
      }
    }

    throw new IdentifierGenerationExhaustedError();
  }

  public async get(merchantId: string, publicId: string): Promise<PaymentIntentRepresentation> {
    assertValidPaymentIntentId(publicId);
    const record = await this.repository.findByPublicId(merchantId, publicId);
    if (record === undefined) {
      throw new PaymentIntentNotFoundError();
    }
    return toRepresentation(record);
  }
}

export const paymentIntentServiceInternals = {
  canonicalCreateCommand,
  externalReferenceProblem,
  isPaymentIntentRepresentation,
  toRepresentation,
};
