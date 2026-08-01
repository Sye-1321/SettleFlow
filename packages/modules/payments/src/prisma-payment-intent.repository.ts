import {
  findDatabaseConstraint,
  PrismaDatabase,
  type PrismaTransactionClient,
} from '@settleflow/infrastructure';

import { ExternalReferenceConflictError, PaymentIdentifierCollisionError } from './payments.errors';
import type {
  CreatePaymentIntentRecord,
  PaymentCurrency,
  PaymentIntentRecord,
  PaymentIntentRepository,
} from './payments.types';

interface PersistedPaymentIntent {
  readonly amountMinor: bigint;
  readonly captureMethod: 'MANUAL';
  readonly capturedAmountMinor: bigint;
  readonly createdAt: Date;
  readonly currency: string;
  readonly externalRef: string;
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

function toRecord(record: PersistedPaymentIntent): PaymentIntentRecord {
  if (record.captureMethod !== 'MANUAL' || record.paymentStatus !== 'CREATED') {
    throw new Error('Persisted payment lifecycle is outside the M1 create/read contract');
  }

  return {
    amountMinor: toSafeAmount(record.amountMinor),
    captureMethod: 'manual',
    capturedAmountMinor: toSafeAmount(record.capturedAmountMinor),
    createdAt: record.createdAt,
    currency: toCurrency(record.currency),
    externalRef: record.externalRef,
    merchantId: record.merchantId,
    paymentStatus: 'created',
    publicId: record.publicId,
    refundedAmountMinor: toSafeAmount(record.refundedAmountMinor),
    updatedAt: record.updatedAt,
    version: record.version,
  };
}

const paymentSelection = {
  amountMinor: true,
  captureMethod: true,
  capturedAmountMinor: true,
  createdAt: true,
  currency: true,
  externalRef: true,
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
      const record = await transaction.paymentIntent.create({
        data: {
          amountMinor: BigInt(input.amountMinor),
          captureMethod: 'MANUAL',
          currency: input.currency,
          externalRef: input.externalRef,
          merchantId: input.merchantId,
          publicId: input.publicId,
        },
        select: paymentSelection,
      });
      return toRecord(record);
    } catch (error: unknown) {
      const constraint = findDatabaseConstraint(error);
      if (
        constraint === 'payment_intents_public_id_key' ||
        constraint === 'public_id' ||
        constraint === 'publicId'
      ) {
        throw new PaymentIdentifierCollisionError();
      }
      if (
        constraint === 'payment_intents_merchant_id_external_ref_key' ||
        constraint === 'merchant_id,external_ref' ||
        constraint === 'merchantId,externalRef'
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
    let record;
    try {
      record = await this.database.getClient().paymentIntent.findFirst({
        where: { merchantId, publicId },
        select: paymentSelection,
      });
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }

    return record === null ? undefined : toRecord(record);
  }
}

export const prismaPaymentIntentRepositoryInternals = { toRecord };
