import type {
  HashedIdempotencyAcquireCommand,
  IdempotencyAcquireResult,
  IdempotencyOwnership,
  IdempotentOperation,
} from './idempotency.types';

export interface IdempotencyRepository {
  acquire(command: HashedIdempotencyAcquireCommand): Promise<IdempotencyAcquireResult>;
  complete<T>(ownership: IdempotencyOwnership, operation: IdempotentOperation<T>): Promise<T>;
}
