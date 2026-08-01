export class InvalidPaymentIntentRequestError extends Error {
  public constructor(public readonly field?: string) {
    super('The payment intent request is invalid');
    this.name = 'InvalidPaymentIntentRequestError';
  }
}

export class UnsupportedPaymentCurrencyError extends Error {
  public constructor() {
    super('The requested currency is not supported');
    this.name = 'UnsupportedPaymentCurrencyError';
  }
}

export class UnsupportedCaptureMethodError extends Error {
  public constructor() {
    super('The requested capture method is not supported');
    this.name = 'UnsupportedCaptureMethodError';
  }
}

export class PaymentIntentNotFoundError extends Error {
  public constructor() {
    super('The payment intent was not found');
    this.name = 'PaymentIntentNotFoundError';
  }
}

export class ExternalReferenceConflictError extends Error {
  public constructor() {
    super('The external reference is already used by this merchant');
    this.name = 'ExternalReferenceConflictError';
  }
}

export class PaymentIdentifierCollisionError extends Error {
  public constructor() {
    super('The generated payment identifier collided with an existing payment');
    this.name = 'PaymentIdentifierCollisionError';
  }
}

export class IdentifierGenerationExhaustedError extends Error {
  public constructor() {
    super('The bounded identifier generation attempts were exhausted');
    this.name = 'IdentifierGenerationExhaustedError';
  }
}
