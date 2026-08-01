export class IdempotencyKeyReusedError extends Error {
  public constructor() {
    super('The idempotency key was already used with a different request');
    this.name = 'IdempotencyKeyReusedError';
  }
}

export class IdempotencyRequestInProgressError extends Error {
  public constructor() {
    super('The idempotent request is still in progress');
    this.name = 'IdempotencyRequestInProgressError';
  }
}

export class IdempotencyKeyExpiredError extends Error {
  public constructor() {
    super('The idempotency response replay window has expired');
    this.name = 'IdempotencyKeyExpiredError';
  }
}

export class IdempotencyOwnershipLostError extends Error {
  public constructor() {
    super('Idempotency command ownership is no longer valid');
    this.name = 'IdempotencyOwnershipLostError';
  }
}
