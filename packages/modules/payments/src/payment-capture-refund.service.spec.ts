import {
  EventIdentifierCollisionError,
  EventingService,
  type PaymentCapturedEvent,
  type PaymentCapturedEventInput,
  type PaymentRefundedEvent,
  type PaymentRefundedEventInput,
} from '@settleflow/eventing';
import {
  IdempotencyService,
  type IdempotencyOwnership,
  type IdempotentOperation,
} from '@settleflow/idempotency';
import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';
import {
  LedgerIdentifierCollisionError,
  type LedgerPostingPort,
  type LedgerPostingResult,
} from '@settleflow/ledger';

import type { PaymentExecutionPort } from './payment-execution';
import { PaymentIntentService, paymentIntentServiceInternals } from './payment-intent.service';
import {
  CaptureAmountMismatchError,
  IdentifierGenerationExhaustedError,
  PaymentCurrencyMismatchError,
  PaymentIntentNotCapturableError,
  PaymentIntentNotFoundError,
  PaymentIntentNotRefundableError,
  PaymentProviderDeclinedError,
  PaymentProviderUnavailableError,
  RefundExternalReferenceConflictError,
  RefundIdentifierCollisionError,
  RefundAmountExceedsAvailableError,
} from './payments.errors';
import type {
  CapturePaymentIntentCommand,
  PaymentIntentRecord,
  PaymentIntentRepository,
  RefundPaymentIntentCommand,
  RefundRecord,
} from './payments.types';

describe('Payment capture and refund orchestration', () => {
  const now = new Date('2026-08-02T10:20:12.345Z');
  const paymentId = 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const merchantId = '11111111-1111-4111-8111-111111111111';
  const created: PaymentIntentRecord = {
    amountMinor: 1_000,
    availableAt: undefined,
    captureMethod: 'manual',
    capturedAmountMinor: 0,
    capturedAt: undefined,
    createdAt: now,
    currency: 'ETB',
    externalRef: 'order_1001',
    id: '22222222-2222-4222-8222-222222222222',
    merchantId,
    paymentStatus: 'created',
    publicId: paymentId,
    refundedAmountMinor: 0,
    updatedAt: now,
    version: 0,
  };
  const captured: PaymentIntentRecord = {
    ...created,
    availableAt: now,
    capturedAmountMinor: 1_000,
    capturedAt: now,
    paymentStatus: 'captured',
    version: 1,
  };
  const ledgerResult: LedgerPostingResult = {
    businessReference: paymentId,
    businessType: 'capture',
    currency: 'ETB',
    entries: [],
    merchantId,
    occurredAt: now,
    postedAt: now,
    publicId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  };

  interface Harness {
    readonly eventing: jest.Mocked<EventingService>;
    readonly execution: jest.Mocked<PaymentExecutionPort>;
    readonly idempotency: jest.Mocked<IdempotencyService>;
    readonly ledger: jest.Mocked<LedgerPostingPort>;
    readonly repository: jest.Mocked<PaymentIntentRepository>;
    readonly observer: { readonly record: jest.Mock };
    readonly service: PaymentIntentService;
    readonly transaction: PrismaTransactionClient;
  }

  function harness(payment: PaymentIntentRecord = created): Harness {
    const transaction = {} as PrismaTransactionClient;
    const repository = {
      applyRefund: jest.fn(),
      capture: jest.fn().mockResolvedValue(captured),
      create: jest.fn(),
      createRefund: jest.fn(),
      findByPublicId: jest.fn(),
      lockByPublicId: jest.fn().mockResolvedValue({ payment, transactionTime: now }),
    } as unknown as jest.Mocked<PaymentIntentRepository>;
    const idempotency = {
      acquire: jest.fn().mockResolvedValue({
        kind: 'acquired',
        ownership: { ownerToken: 'owner', recordId: 'record' },
      }),
      complete: jest
        .fn()
        .mockImplementation(
          async <T>(
            _ownership: IdempotencyOwnership,
            operation: IdempotentOperation<T>,
          ): Promise<T> => {
            const completed = await operation(transaction);
            return completed.value;
          },
        ),
    } as unknown as jest.Mocked<IdempotencyService>;
    const eventing = {
      createPaymentCapturedEvent: jest
        .fn()
        .mockImplementation(
          (input: PaymentCapturedEventInput, occurredAt: Date): PaymentCapturedEvent => ({
            ...input,
            eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            eventType: 'payment.captured.v1',
            occurredAt,
          }),
        ),
      createPaymentRefundedEvent: jest
        .fn()
        .mockImplementation(
          (input: PaymentRefundedEventInput, occurredAt: Date): PaymentRefundedEvent => ({
            ...input,
            eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FB0',
            eventType: 'payment.refunded.v1',
            occurredAt,
          }),
        ),
      persistPaymentEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<EventingService>;
    const ledger = {
      postCapture: jest.fn().mockResolvedValue(ledgerResult),
      postRefund: jest.fn().mockResolvedValue({ ...ledgerResult, businessType: 'refund' }),
      reverse: jest.fn(),
    } as unknown as jest.Mocked<LedgerPostingPort>;
    const execution = {
      capture: jest.fn().mockResolvedValue({ kind: 'approved' }),
      refund: jest.fn().mockResolvedValue({ kind: 'approved' }),
    } as unknown as jest.Mocked<PaymentExecutionPort>;
    const identifiers = {
      generate: jest.fn().mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    } as unknown as jest.Mocked<MonotonicUlidGenerator>;
    const observer = { record: jest.fn() };
    return {
      eventing,
      execution,
      idempotency,
      ledger,
      repository,
      observer,
      service: new PaymentIntentService(
        repository,
        idempotency,
        eventing,
        ledger,
        execution,
        identifiers,
        () => now,
        () => '33333333-3333-4333-8333-333333333333',
        observer,
      ),
      transaction,
    };
  }

  const captureCommand: CapturePaymentIntentCommand = {
    amountMinor: 1_000,
    currency: 'ETB',
    idempotencyKey: 'capture-key',
    merchantId,
    paymentId,
    requestId: 'req_capture',
  };

  it('uses one idempotency completion transaction for projection, Ledger, event, and snapshot', async () => {
    const test = harness();
    await expect(test.service.capture(captureCommand)).resolves.toMatchObject({
      capturedAmountMinor: 1_000,
      ledgerTransactionId: ledgerResult.publicId,
      paymentStatus: 'captured',
      refundedAmountMinor: 0,
      settlementStatus: 'NOT_ELIGIBLE',
      version: 1,
    });
    expect(test.idempotency.acquire.mock.calls[0]?.[0].canonicalRequest).toBe(
      '{"v":1,"paymentId":"pi_01ARZ3NDEKTSV4RRFFQ69G5FAV","amountMinor":"1000","currency":"ETB"}',
    );
    expect(test.ledger.postCapture.mock.calls[0]?.[0]).toBe(test.transaction);
    expect(test.repository.capture.mock.calls[0]?.[0]).toBe(test.transaction);
    expect(test.eventing.persistPaymentEvent.mock.calls[0]?.[0]).toBe(test.transaction);
  });

  it('stores a terminal amount conflict without a Ledger or event effect', async () => {
    const test = harness();
    await expect(
      test.service.capture({ ...captureCommand, amountMinor: 999 }),
    ).rejects.toBeInstanceOf(CaptureAmountMismatchError);
    expect(test.ledger.postCapture.mock.calls).toHaveLength(0);
    expect(test.eventing.persistPaymentEvent.mock.calls).toHaveLength(0);
    const operation = test.idempotency.complete.mock.calls[0]?.[1];
    expect(operation).toBeDefined();
  });

  it('creates an immutable partial refund and exact cumulative projection', async () => {
    const test = harness(captured);
    const refund: RefundRecord = {
      amountMinor: 400,
      createdAt: now,
      currency: 'ETB',
      externalRef: 'refund_1001',
      id: '33333333-3333-4333-8333-333333333333',
      merchantId,
      paymentIntentId: created.id,
      publicId: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    };
    test.repository.createRefund.mockResolvedValue(refund);
    test.repository.applyRefund.mockResolvedValue({
      ...captured,
      paymentStatus: 'partially_refunded',
      refundedAmountMinor: 400,
      version: 2,
    });
    const command: RefundPaymentIntentCommand = {
      amountMinor: 400,
      currency: 'ETB',
      externalRef: 'refund_1001',
      idempotencyKey: 'refund-key',
      merchantId,
      paymentId,
      requestId: 'req_refund',
    };
    await expect(test.service.refund(command)).resolves.toMatchObject({
      amountMinor: 400,
      cumulativeRefundedAmountMinor: 400,
      id: refund.publicId,
      paymentStatus: 'partially_refunded',
    });
    expect(test.repository.createRefund.mock.calls[0]?.[0]).toBe(test.transaction);
    expect(test.ledger.postRefund.mock.calls[0]?.[0]).toBe(test.transaction);
    expect(test.repository.applyRefund.mock.calls[0]?.[0]).toBe(test.transaction);
  });

  it('prevents an over-refund before any Refund or Ledger write', async () => {
    const test = harness({
      ...captured,
      refundedAmountMinor: 800,
      paymentStatus: 'partially_refunded',
    });
    await expect(
      test.service.refund({
        amountMinor: 201,
        currency: 'ETB',
        externalRef: 'refund_too_large',
        idempotencyKey: 'refund-too-large',
        merchantId,
        paymentId,
        requestId: 'req_refund',
      }),
    ).rejects.toBeInstanceOf(RefundAmountExceedsAvailableError);
    expect(test.repository.createRefund.mock.calls).toHaveLength(0);
    expect(test.ledger.postRefund.mock.calls).toHaveLength(0);
  });

  it('snapshots a deterministic provider decline without opening the effect path', async () => {
    const test = harness();
    test.execution.capture.mockResolvedValue({ kind: 'declined' });
    await expect(test.service.capture(captureCommand)).rejects.toBeInstanceOf(
      PaymentProviderDeclinedError,
    );
    expect(test.repository.lockByPublicId.mock.calls).toHaveLength(0);
    expect(test.ledger.postCapture.mock.calls).toHaveLength(0);
    expect(test.idempotency.complete.mock.calls).toHaveLength(1);
  });

  it('canonicalizes equivalent safe integer forms for both command fingerprints', () => {
    expect(paymentIntentServiceInternals.canonicalCaptureCommand(captureCommand)).toBe(
      paymentIntentServiceInternals.canonicalCaptureCommand({
        ...captureCommand,
        amountMinor: Number('1e3'),
      }),
    );
  });

  it.each([
    [undefined, PaymentIntentNotFoundError],
    [{ ...created, currency: 'USD' as const }, PaymentCurrencyMismatchError],
    [captured, PaymentIntentNotCapturableError],
  ])('snapshots capture validation failure %# without effects', async (payment, ErrorType) => {
    const test = harness(payment ?? created);
    if (payment === undefined) test.repository.lockByPublicId.mockResolvedValue(undefined);
    await expect(test.service.capture(captureCommand)).rejects.toBeInstanceOf(ErrorType);
    expect(test.ledger.postCapture.mock.calls).toHaveLength(0);
    expect(test.observer.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'rejected' }),
    );
  });

  it.each([
    [undefined, PaymentIntentNotFoundError],
    [created, PaymentIntentNotRefundableError],
    [{ ...captured, currency: 'USD' as const }, PaymentCurrencyMismatchError],
  ])('snapshots refund validation failure %# without effects', async (payment, ErrorType) => {
    const test = harness(payment ?? captured);
    if (payment === undefined) test.repository.lockByPublicId.mockResolvedValue(undefined);
    await expect(
      test.service.refund({
        amountMinor: 100,
        currency: 'ETB',
        externalRef: 'refund',
        idempotencyKey: 'refund-key',
        merchantId,
        paymentId,
        requestId: 'req_refund',
      }),
    ).rejects.toBeInstanceOf(ErrorType);
    expect(test.ledger.postRefund.mock.calls).toHaveLength(0);
  });

  it('replays valid successes and stable terminal problems', async () => {
    const capture = harness();
    capture.idempotency.acquire.mockResolvedValue({
      kind: 'replay',
      response: {
        body: {
          ...paymentIntentServiceInternals.toRepresentation(captured),
          ledgerTransactionId: ledgerResult.publicId,
        },
        contentType: 'application/json',
        headers: {},
        resultReference: paymentId,
        status: 200,
      },
    });
    await expect(capture.service.capture(captureCommand)).resolves.toMatchObject({
      paymentStatus: 'captured',
    });
    const refund = harness(captured);
    refund.idempotency.acquire.mockResolvedValue({
      kind: 'replay',
      response: {
        body: {
          amountMinor: 100,
          createdAt: now.toISOString(),
          cumulativeRefundedAmountMinor: 100,
          currency: 'ETB',
          externalRef: 'refund',
          id: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          ledgerTransactionId: ledgerResult.publicId,
          paymentId,
          paymentStatus: 'partially_refunded',
        },
        contentType: 'application/json',
        headers: {},
        resultReference: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        status: 201,
      },
    });
    await expect(
      refund.service.refund({
        amountMinor: 100,
        currency: 'ETB',
        externalRef: 'refund',
        idempotencyKey: 'refund-key',
        merchantId,
        paymentId,
        requestId: 'request',
      }),
    ).resolves.toMatchObject({ paymentStatus: 'partially_refunded' });
    const conflict = harness();
    conflict.idempotency.acquire.mockResolvedValue({
      kind: 'replay',
      response: {
        body: { code: 'currency_mismatch' },
        contentType: 'application/problem+json',
        headers: {},
        status: 422,
      },
    });
    await expect(conflict.service.capture(captureCommand)).rejects.toBeInstanceOf(
      PaymentCurrencyMismatchError,
    );
  });

  it('maps provider outages and bounds capture and refund collision retries', async () => {
    const unavailable = harness();
    unavailable.execution.capture.mockRejectedValue(new Error('offline'));
    await expect(unavailable.service.capture(captureCommand)).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );

    for (const collision of [
      new EventIdentifierCollisionError(),
      new LedgerIdentifierCollisionError(),
    ]) {
      const capture = harness();
      capture.eventing.persistPaymentEvent.mockRejectedValue(collision);
      await expect(capture.service.capture(captureCommand)).rejects.toBeInstanceOf(
        IdentifierGenerationExhaustedError,
      );
    }

    for (const collision of [
      new RefundIdentifierCollisionError(),
      new EventIdentifierCollisionError(),
      new LedgerIdentifierCollisionError(),
    ]) {
      const refund = harness(captured);
      refund.repository.createRefund.mockRejectedValue(collision);
      await expect(
        refund.service.refund({
          amountMinor: 100,
          currency: 'ETB',
          externalRef: 'refund',
          idempotencyKey: 'refund-key',
          merchantId,
          paymentId,
          requestId: 'request',
        }),
      ).rejects.toBeInstanceOf(IdentifierGenerationExhaustedError);
    }
  });

  it('durably snapshots refund external-reference conflicts', async () => {
    const test = harness(captured);
    test.repository.createRefund.mockRejectedValue(new RefundExternalReferenceConflictError());
    await expect(
      test.service.refund({
        amountMinor: 100,
        currency: 'ETB',
        externalRef: 'refund',
        idempotencyKey: 'refund-key',
        merchantId,
        paymentId,
        requestId: 'request',
      }),
    ).rejects.toBeInstanceOf(RefundExternalReferenceConflictError);
    expect(test.idempotency.complete.mock.calls).toHaveLength(2);
  });
});
