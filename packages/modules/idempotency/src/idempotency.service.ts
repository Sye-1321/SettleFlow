import { createHash, randomUUID } from 'node:crypto';

import type { IdempotencyRepository } from './idempotency.repository';
import type {
  IdempotencyAcquireCommand,
  IdempotencyAcquireResult,
  IdempotencyOwnership,
  IdempotentOperation,
} from './idempotency.types';

function sha256(value: string): Uint8Array {
  return createHash('sha256').update(value, 'utf8').digest();
}

export class IdempotencyService {
  public constructor(private readonly repository: IdempotencyRepository) {}

  public acquire(command: IdempotencyAcquireCommand): Promise<IdempotencyAcquireResult> {
    return this.repository.acquire({
      keyHash: sha256(command.key),
      merchantId: command.merchantId,
      method: command.method,
      normalizedRoute: command.normalizedRoute,
      now: command.now,
      ownerToken: randomUUID(),
      recordId: randomUUID(),
      requestHash: sha256(command.canonicalRequest),
    });
  }

  public complete<T>(
    ownership: IdempotencyOwnership,
    operation: IdempotentOperation<T>,
  ): Promise<T> {
    return this.repository.complete(ownership, operation);
  }
}

export const idempotencyServiceInternals = { sha256 };
