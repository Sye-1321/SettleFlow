import { PrismaDatabase, type PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  ExternalReferenceConflictError,
  PaymentIdentifierCollisionError,
  PaymentProjectionInvariantError,
  RefundExternalReferenceConflictError,
  RefundIdentifierCollisionError,
} from './payments.errors';
import {
  PrismaPaymentIntentRepository,
  prismaPaymentIntentRepositoryInternals,
} from './prisma-payment-intent.repository';

interface PaymentRepositoryHarness {
  readonly client: { readonly paymentIntent: { readonly findFirst: jest.Mock } };
  readonly repository: PrismaPaymentIntentRepository;
  readonly transaction: {
    readonly $queryRaw: jest.Mock;
    readonly paymentIntent: {
      readonly create: jest.Mock;
      readonly findFirst: jest.Mock;
      readonly updateMany: jest.Mock;
    };
    readonly refund: { readonly create: jest.Mock };
  };
  readonly tx: PrismaTransactionClient;
}

describe('PrismaPaymentIntentRepository', () => {
  const now = new Date('2026-08-03T10:00:00.000Z');
  const persisted = {
    amountMinor: 1_000n,
    availableAt: null,
    captureMethod: 'MANUAL' as const,
    capturedAmountMinor: 0n,
    capturedAt: null,
    createdAt: now,
    currency: 'ETB',
    externalRef: 'order',
    id: 'internal',
    merchantId: 'merchant',
    paymentStatus: 'CREATED',
    publicId: 'pi-id',
    refundedAmountMinor: 0n,
    updatedAt: now,
    version: 0,
  };
  const payment = prismaPaymentIntentRepositoryInternals.toRecord(persisted);

  function harness(): PaymentRepositoryHarness {
    const transaction = {
      $queryRaw: jest.fn(),
      paymentIntent: { create: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
      refund: { create: jest.fn() },
    };
    const client = { paymentIntent: { findFirst: jest.fn() } };
    const database = {
      getClient: jest.fn().mockReturnValue(client),
      rethrowDatabaseError: jest.fn().mockImplementation((error: unknown) => {
        throw error;
      }),
    } as unknown as PrismaDatabase;
    return {
      client,
      repository: new PrismaPaymentIntentRepository(database),
      transaction,
      tx: transaction as unknown as PrismaTransactionClient,
    };
  }

  it('creates, reads, and tenant-scopes approved records', async () => {
    const h = harness();
    h.transaction.paymentIntent.create.mockResolvedValue(persisted);
    await expect(
      h.repository.create(h.tx, {
        amountMinor: 1_000,
        currency: 'ETB',
        externalRef: 'order',
        merchantId: 'merchant',
        publicId: 'pi-id',
      }),
    ).resolves.toEqual(payment);
    h.client.paymentIntent.findFirst.mockResolvedValue(persisted);
    await expect(h.repository.findByPublicId('merchant', 'pi-id')).resolves.toEqual(payment);
    h.client.paymentIntent.findFirst.mockResolvedValue(null);
    await expect(h.repository.findByPublicId('merchant', 'missing')).resolves.toBeUndefined();
  });

  it.each([
    ['payment_intents_public_id_key', PaymentIdentifierCollisionError],
    ['payment_intents_merchant_id_external_ref_key', ExternalReferenceConflictError],
  ])('maps payment constraint %s', async (constraint, ErrorType) => {
    const h = harness();
    h.transaction.paymentIntent.create.mockRejectedValue({ constraint });
    await expect(
      h.repository.create(h.tx, {
        amountMinor: 1,
        currency: 'ETB',
        externalRef: 'order',
        merchantId: 'merchant',
        publicId: 'pi-id',
      }),
    ).rejects.toBeInstanceOf(ErrorType);
  });

  it('locks with merchant predicates and fails on inconsistent projections', async () => {
    const h = harness();
    h.transaction.$queryRaw.mockResolvedValueOnce([]);
    await expect(h.repository.lockByPublicId(h.tx, 'merchant', 'missing')).resolves.toBeUndefined();
    h.transaction.$queryRaw.mockReset().mockResolvedValueOnce([{ id: 'internal' }]);
    h.transaction.paymentIntent.findFirst.mockResolvedValue(null);
    await expect(h.repository.lockByPublicId(h.tx, 'merchant', 'pi-id')).rejects.toBeInstanceOf(
      PaymentProjectionInvariantError,
    );
    h.transaction.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: 'internal' }])
      .mockResolvedValueOnce([]);
    h.transaction.paymentIntent.findFirst.mockResolvedValue(persisted);
    await expect(h.repository.lockByPublicId(h.tx, 'merchant', 'pi-id')).rejects.toBeInstanceOf(
      PaymentProjectionInvariantError,
    );
    h.transaction.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: 'internal' }])
      .mockResolvedValueOnce([{ transactionTime: now }]);
    await expect(h.repository.lockByPublicId(h.tx, 'merchant', 'pi-id')).resolves.toEqual({
      payment,
      transactionTime: now,
    });
  });

  it('guards capture and both partial and full refund projections', async () => {
    const h = harness();
    const capturedPersisted = {
      ...persisted,
      availableAt: now,
      capturedAmountMinor: 1_000n,
      capturedAt: now,
      paymentStatus: 'CAPTURED',
      version: 1,
    };
    h.transaction.paymentIntent.updateMany.mockResolvedValue({ count: 1 });
    h.transaction.paymentIntent.findFirst.mockResolvedValue(capturedPersisted);
    const captured = await h.repository.capture(h.tx, payment, now);
    expect(captured.paymentStatus).toBe('captured');
    h.transaction.paymentIntent.findFirst.mockResolvedValue({
      ...capturedPersisted,
      paymentStatus: 'PARTIALLY_REFUNDED',
      refundedAmountMinor: 400n,
      version: 2,
    });
    await expect(h.repository.applyRefund(h.tx, captured, 400, now)).resolves.toMatchObject({
      paymentStatus: 'partially_refunded',
      refundedAmountMinor: 400,
    });
    h.transaction.paymentIntent.findFirst.mockResolvedValue({
      ...capturedPersisted,
      paymentStatus: 'REFUNDED',
      refundedAmountMinor: 1_000n,
      version: 2,
    });
    await expect(h.repository.applyRefund(h.tx, captured, 1_000, now)).resolves.toMatchObject({
      paymentStatus: 'refunded',
    });
    h.transaction.paymentIntent.updateMany.mockResolvedValue({ count: 0 });
    await expect(h.repository.capture(h.tx, payment, now)).rejects.toBeInstanceOf(
      PaymentProjectionInvariantError,
    );
  });

  it.each([
    ['refunds_public_id_key', RefundIdentifierCollisionError],
    ['refunds_merchant_id_external_ref_key', RefundExternalReferenceConflictError],
  ])('maps refund constraint %s', async (constraint, ErrorType) => {
    const h = harness();
    h.transaction.refund.create.mockRejectedValue({ constraint });
    await expect(
      h.repository.createRefund(h.tx, {
        amountMinor: 100,
        createdAt: now,
        currency: 'ETB',
        externalRef: 'refund',
        id: 'refund-internal',
        merchantId: 'merchant',
        paymentIntentId: 'internal',
        publicId: 'rf-id',
      }),
    ).rejects.toBeInstanceOf(ErrorType);
  });

  it('rejects corrupt persisted financial values and enums', () => {
    expect(() =>
      prismaPaymentIntentRepositoryInternals.toRecord({ ...persisted, amountMinor: -1n }),
    ).toThrow('JSON-safe range');
    expect(() =>
      prismaPaymentIntentRepositoryInternals.toRecord({
        ...persisted,
        amountMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
    ).toThrow('JSON-safe range');
    expect(() =>
      prismaPaymentIntentRepositoryInternals.toRecord({ ...persisted, currency: 'EUR' }),
    ).toThrow('allowlist');
    expect(() =>
      prismaPaymentIntentRepositoryInternals.toRecord({
        ...persisted,
        captureMethod: 'AUTO' as 'MANUAL',
      }),
    ).toThrow('capture method');
    expect(() => prismaPaymentIntentRepositoryInternals.toStatus('AUTHORIZED')).toThrow(
      'lifecycle',
    );
  });
});
