import { hasDatabaseErrorCode } from '@settleflow/infrastructure';

import {
  InboxMessageConflictError,
  MessageTransactionRetryExhaustedError,
} from './eventing.errors';
import type {
  InboxEffect,
  InboxProcessingResult,
  InboxRepository,
  InboxServiceOptions,
} from './inbox.types';
import { calculateFullJitterBackoff } from './outbox-retry';
import type { ValidatedPaymentCreatedMessage } from './payment-created-event.contract';

const RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01', 'P2034']);
const CONSUMER_NAME = 'webhook-projection.payment-created.v1';

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    timer.unref();
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

export class InboxService {
  private readonly random: () => number;
  private readonly sleep: (durationMs: number) => Promise<void>;

  public constructor(
    private readonly repository: InboxRepository,
    private readonly options: InboxServiceOptions,
  ) {
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  public async process<T>(
    message: ValidatedPaymentCreatedMessage,
    effect: InboxEffect<T>,
  ): Promise<InboxProcessingResult<T>> {
    for (let attempt = 1; attempt <= this.options.retryAttempts; attempt += 1) {
      try {
        return await this.repository.withSerializableTransaction(async (context) => {
          const reservation = await this.repository.reserve(context.transaction, {
            completedAt: context.processedAt,
            consumerName: CONSUMER_NAME,
            correlationId: message.event.requestId,
            eventType: message.event.eventType,
            messageId: message.event.eventId,
            payloadSha256: message.payloadSha256,
            receivedAt: context.processedAt,
            schemaVersion: message.schemaVersion,
          });
          if (reservation.kind === 'existing') {
            const existing = reservation.record;
            if (
              existing.consumerName !== CONSUMER_NAME ||
              existing.messageId !== message.event.eventId ||
              existing.eventType !== message.event.eventType ||
              existing.schemaVersion !== message.schemaVersion ||
              existing.correlationId !== message.event.requestId ||
              !bytesEqual(existing.payloadSha256, message.payloadSha256)
            ) {
              throw new InboxMessageConflictError();
            }
            return { kind: 'duplicate' } as const;
          }
          return { kind: 'processed', value: await effect(context, message) } as const;
        });
      } catch (error: unknown) {
        if (!hasDatabaseErrorCode(error, RETRYABLE_TRANSACTION_CODES)) {
          throw error;
        }
        if (attempt === this.options.retryAttempts) {
          throw new MessageTransactionRetryExhaustedError();
        }
        await this.sleep(
          calculateFullJitterBackoff({
            attemptCount: attempt,
            baseMs: 10,
            maxMs: 100,
            random: this.random,
          }),
        );
      }
    }
    throw new MessageTransactionRetryExhaustedError();
  }
}

export const inboxServiceInternals = {
  CONSUMER_NAME,
  RETRYABLE_TRANSACTION_CODES,
  bytesEqual,
};
