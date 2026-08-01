import type { PrismaTransactionClient } from '@settleflow/infrastructure';

export interface IdempotencyAcquireCommand {
  readonly canonicalRequest: string;
  readonly key: string;
  readonly merchantId: string;
  readonly now: Date;
  readonly normalizedRoute: '/v1/payment-intents';
  readonly method: 'POST';
}

export interface IdempotencyOwnership {
  readonly ownerToken: string;
  readonly recordId: string;
}

export interface StoredHttpResponse {
  readonly body: object;
  readonly contentType: 'application/json' | 'application/problem+json';
  readonly headers: Readonly<Record<string, string>>;
  readonly resultReference?: string;
  readonly status: number;
}

export type IdempotencyAcquireResult =
  | { readonly kind: 'acquired'; readonly ownership: IdempotencyOwnership }
  | { readonly kind: 'replay'; readonly response: StoredHttpResponse };

export interface IdempotentOperationResult<T> {
  readonly response: StoredHttpResponse;
  readonly value: T;
}

export type IdempotentOperation<T> = (
  transaction: PrismaTransactionClient,
) => Promise<IdempotentOperationResult<T>>;

export interface HashedIdempotencyAcquireCommand {
  readonly keyHash: Uint8Array;
  readonly merchantId: string;
  readonly now: Date;
  readonly normalizedRoute: '/v1/payment-intents';
  readonly method: 'POST';
  readonly ownerToken: string;
  readonly recordId: string;
  readonly requestHash: Uint8Array;
}
