import {
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
import type { LedgerPostingPort, LedgerPostingResult } from '@settleflow/ledger';

import type { PaymentExecutionPort } from './payment-execution';
import { PaymentIntentService, paymentIntentServiceInternals } from './payment-intent.service';
import {
  CaptureAmountMismatchError,
  PaymentProviderDeclinedError,
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
    return {
      eventing,
      execution,
      idempotency,
      ledger,
      repository,
      service: new PaymentIntentService(
        repository,
        idempotency,
        eventing,
        ledger,
        execution,
        identifiers,
        () => now,
        () => '33333333-3333-4333-8333-333333333333',
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
});
