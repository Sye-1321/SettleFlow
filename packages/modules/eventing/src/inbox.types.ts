import type { PrismaTransactionClient } from '@settleflow/infrastructure';

import type { ValidatedPaymentEventMessage } from './payment-created-event.contract';
import type { ValidatedOperationalEventMessage } from './settlement-reconciliation-event.contract';

export type ValidatedDomainEventMessage =
  ValidatedOperationalEventMessage | ValidatedPaymentEventMessage;

export interface InboxMessageRecord {
  readonly consumerName: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly messageId: string;
  readonly payloadSha256: Uint8Array;
  readonly schemaVersion: number;
}

export interface ReserveInboxMessageInput {
  readonly completedAt: Date;
  readonly consumerName: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly messageId: string;
  readonly payloadSha256: Uint8Array;
  readonly receivedAt: Date;
  readonly schemaVersion: number;
}

export interface InboxTransactionContext {
  readonly processedAt: Date;
  readonly transaction: PrismaTransactionClient;
}

export interface InboxRepository {
  reserve(
    transaction: PrismaTransactionClient,
    input: ReserveInboxMessageInput,
  ): Promise<
    | { readonly kind: 'reserved' }
    | { readonly kind: 'existing'; readonly record: InboxMessageRecord }
  >;
  withSerializableTransaction<T>(
    operation: (context: InboxTransactionContext) => Promise<T>,
  ): Promise<T>;
}

export type InboxEffect<T> = (
  context: InboxTransactionContext,
  message: ValidatedDomainEventMessage,
) => Promise<T>;

export type InboxProcessingResult<T> =
  { readonly kind: 'duplicate' } | { readonly kind: 'processed'; readonly value: T };

export interface InboxServiceOptions {
  readonly random?: () => number;
  readonly retryAttempts: number;
  readonly sleep?: (durationMs: number) => Promise<void>;
}
