import {
  findDatabaseConstraint,
  PrismaDatabase,
  type PrismaTransactionClient,
} from '@settleflow/infrastructure';

import {
  ExternalReferenceConflictError,
  PaymentIdentifierCollisionError,
  PaymentProjectionInvariantError,
  RefundExternalReferenceConflictError,
  RefundIdentifierCollisionError,
} from './payments.errors';
import type {
  CreatePaymentIntentRecord,
  CreateRefundRecord,
  LockedPaymentIntentRecord,
  PaymentCurrency,
  PaymentIntentRecord,
  PaymentIntentRepository,
  PaymentStatus,
  RefundRecord,
} from './payments.types';

interface PersistedPaymentIntent {
  readonly amountMinor: bigint;
  readonly availableAt: Date | null;
  readonly captureMethod: 'MANUAL';
  readonly capturedAmountMinor: bigint;
  readonly capturedAt: Date | null;
  readonly createdAt: Date;
  readonly currency: string;
  readonly externalRef: string;
  readonly id: string;
  readonly merchantId: string;
  readonly paymentStatus: string;
  readonly publicId: string;
  readonly refundedAmountMinor: bigint;
  readonly updatedAt: Date;
  readonly version: number;
}

function toSafeAmount(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Persisted payment amount is outside the approved JSON-safe range');
  }
  return Number(value);
}

function toCurrency(value: string): PaymentCurrency {
  if (value !== 'ETB' && value !== 'USD') {
    throw new Error('Persisted payment currency is outside the approved allowlist');
  }
  return value;
}

function toStatus(value: string): PaymentStatus {
  const normalized = value.toLowerCase();
  if (
    normalized !== 'created' &&
    normalized !== 'captured' &&
    normalized !== 'partially_refunded' &&
    normalized !== 'refunded'
  ) {
    throw new Error('Persisted payment lifecycle is outside the direct capture/refund contract');
  }
  return normalized;
}

function toRecord(record: PersistedPaymentIntent): PaymentIntentRecord {
  if (record.captureMethod !== 'MANUAL') {
    throw new Error('Persisted payment capture method is outside the approved contract');
  }
  return {
    amountMinor: toSafeAmount(record.amountMinor),
    availableAt: record.availableAt ?? undefined,
    captureMethod: 'manual',
    capturedAmountMinor: toSafeAmount(record.capturedAmountMinor),
    capturedAt: record.capturedAt ?? undefined,
    createdAt: record.createdAt,
    currency: toCurrency(record.currency),
    externalRef: record.externalRef,
    id: record.id,
    merchantId: record.merchantId,
    paymentStatus: toStatus(record.paymentStatus),
    publicId: record.publicId,
    refundedAmountMinor: toSafeAmount(record.refundedAmountMinor),
    updatedAt: record.updatedAt,
    version: record.version,
  };
}

const paymentSelection = {
  amountMinor: true,
  availableAt: true,
  captureMethod: true,
  capturedAmountMinor: true,
  capturedAt: true,
  createdAt: true,
  currency: true,
  externalRef: true,
  id: true,
  merchantId: true,
  paymentStatus: true,
  publicId: true,
  refundedAmountMinor: true,
  updatedAt: true,
  version: true,
} as const;

export class PrismaPaymentIntentRepository implements PaymentIntentRepository {
  public constructor(private readonly database: PrismaDatabase) {}

  public async create(
    transaction: PrismaTransactionClient,
    input: CreatePaymentIntentRecord,
  ): Promise<PaymentIntentRecord> {
    try {
      return toRecord(
        await transaction.paymentIntent.create({
          data: {
            amountMinor: BigInt(input.amountMinor),
            captureMethod: 'MANUAL',
            currency: input.currency,
            externalRef: input.externalRef,
            merchantId: input.merchantId,
            publicId: input.publicId,
          },
          select: paymentSelection,
        }),
      );
    } catch (error: unknown) {
      const constraint = findDatabaseConstraint(error);
      if (matches(constraint, 'payment_intents_public_id_key', 'public_id', 'publicId')) {
        throw new PaymentIdentifierCollisionError();
      }
      if (
        matches(
          constraint,
          'payment_intents_merchant_id_external_ref_key',
          'merchant_id,external_ref',
          'merchantId,externalRef',
        )
      ) {
        throw new ExternalReferenceConflictError();
      }
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async findByPublicId(
    merchantId: string,
    publicId: string,
  ): Promise<PaymentIntentRecord | undefined> {
    try {
      const record = await this.database.getClient().paymentIntent.findFirst({
        where: { merchantId, publicId },
        select: paymentSelection,
      });
      return record === null ? undefined : toRecord(record);
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async lockByPublicId(
    transaction: PrismaTransactionClient,
    merchantId: string,
    publicId: string,
  ): Promise<LockedPaymentIntentRecord | undefined> {
    const rows = await transaction.$queryRaw<{ readonly id: string }[]>`
      SELECT "id"
      FROM "payment_intents"
      WHERE "merchant_id" = ${merchantId}::uuid
        AND "public_id" = ${publicId}
      FOR UPDATE
    `;
    const locked = rows[0];
    if (locked === undefined) return undefined;
    const payment = await transaction.paymentIntent.findFirst({
      select: paymentSelection,
      where: { id: locked.id, merchantId },
    });
    if (payment === null) throw new PaymentProjectionInvariantError();
    const timestampRows = await transaction.$queryRaw<{ readonly transactionTime: Date }[]>`
      SELECT GREATEST(clock_timestamp(), "updated_at") AS "transactionTime"
      FROM "payment_intents"
      WHERE "id" = ${locked.id}::uuid
        AND "merchant_id" = ${merchantId}::uuid
    `;
    const transactionTime = timestampRows[0]?.transactionTime;
    if (transactionTime === undefined) throw new PaymentProjectionInvariantError();
    return { payment: toRecord(payment), transactionTime };
  }

  public async capture(
    transaction: PrismaTransactionClient,
    payment: PaymentIntentRecord,
    occurredAt: Date,
  ): Promise<PaymentIntentRecord> {
    const updated = await transaction.paymentIntent.updateMany({
      data: {
        availableAt: occurredAt,
        capturedAmountMinor: BigInt(payment.amountMinor),
        capturedAt: occurredAt,
        paymentStatus: 'CAPTURED',
        updatedAt: occurredAt,
        version: { increment: 1 },
      },
      where: {
        capturedAmountMinor: 0n,
        id: payment.id,
        merchantId: payment.merchantId,
        paymentStatus: 'CREATED',
        refundedAmountMinor: 0n,
        version: payment.version,
      },
    });
    if (updated.count !== 1) throw new PaymentProjectionInvariantError();
    return this.findLockedRecord(transaction, payment.id, payment.merchantId);
  }

  public async createRefund(
    transaction: PrismaTransactionClient,
    input: CreateRefundRecord,
  ): Promise<RefundRecord> {
    try {
      const record = await transaction.refund.create({
        data: {
          amountMinor: BigInt(input.amountMinor),
          createdAt: input.createdAt,
          currency: input.currency,
          externalRef: input.externalRef,
          id: input.id,
          merchantId: input.merchantId,
          paymentIntentId: input.paymentIntentId,
          publicId: input.publicId,
        },
      });
      return {
        amountMinor: toSafeAmount(record.amountMinor),
        createdAt: record.createdAt,
        currency: toCurrency(record.currency),
        externalRef: record.externalRef,
        id: record.id,
        merchantId: record.merchantId,
        paymentIntentId: record.paymentIntentId,
        publicId: record.publicId,
      };
    } catch (error: unknown) {
      const constraint = findDatabaseConstraint(error);
      if (matches(constraint, 'refunds_public_id_key', 'public_id', 'publicId')) {
        throw new RefundIdentifierCollisionError();
      }
      if (
        matches(
          constraint,
          'refunds_merchant_id_external_ref_key',
          'merchant_id,external_ref',
          'merchantId,externalRef',
        )
      ) {
        throw new RefundExternalReferenceConflictError();
      }
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async applyRefund(
    transaction: PrismaTransactionClient,
    payment: PaymentIntentRecord,
    amountMinor: number,
    occurredAt: Date,
  ): Promise<PaymentIntentRecord> {
    const total = payment.refundedAmountMinor + amountMinor;
    const status = total === payment.capturedAmountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const updated = await transaction.paymentIntent.updateMany({
      data: {
        paymentStatus: status,
        refundedAmountMinor: { increment: BigInt(amountMinor) },
        updatedAt: occurredAt,
        version: { increment: 1 },
      },
      where: {
        capturedAmountMinor: BigInt(payment.capturedAmountMinor),
        id: payment.id,
        merchantId: payment.merchantId,
        paymentStatus: payment.paymentStatus === 'captured' ? 'CAPTURED' : 'PARTIALLY_REFUNDED',
        refundedAmountMinor: BigInt(payment.refundedAmountMinor),
        version: payment.version,
      },
    });
    if (updated.count !== 1) throw new PaymentProjectionInvariantError();
    return this.findLockedRecord(transaction, payment.id, payment.merchantId);
  }

  private async findLockedRecord(
    transaction: PrismaTransactionClient,
    id: string,
    merchantId: string,
  ): Promise<PaymentIntentRecord> {
    const record = await transaction.paymentIntent.findFirst({
      select: paymentSelection,
      where: { id, merchantId },
    });
    if (record === null) throw new PaymentProjectionInvariantError();
    return toRecord(record);
  }
}

function matches(value: string | undefined, ...candidates: readonly string[]): boolean {
  return value !== undefined && candidates.includes(value);
}

export const prismaPaymentIntentRepositoryInternals = { paymentSelection, toRecord, toStatus };
