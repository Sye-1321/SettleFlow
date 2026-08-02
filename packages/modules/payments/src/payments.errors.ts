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

export class CaptureAmountMismatchError extends Error {
  public constructor() {
    super('The capture amount must equal the full payment amount');
    this.name = 'CaptureAmountMismatchError';
  }
}

export class PaymentIntentNotCapturableError extends Error {
  public constructor() {
    super('The payment intent cannot be captured in its current state');
    this.name = 'PaymentIntentNotCapturableError';
  }
}

export class PaymentIntentNotRefundableError extends Error {
  public constructor() {
    super('The payment intent cannot be refunded in its current state');
    this.name = 'PaymentIntentNotRefundableError';
  }
}

export class PaymentCurrencyMismatchError extends Error {
  public constructor() {
    super('The command currency does not match the payment currency');
    this.name = 'PaymentCurrencyMismatchError';
  }
}

export class RefundAmountExceedsAvailableError extends Error {
  public constructor() {
    super('The refund amount exceeds the remaining captured amount');
    this.name = 'RefundAmountExceedsAvailableError';
  }
}

export class RefundExternalReferenceConflictError extends Error {
  public constructor() {
    super('The refund external reference is already used by this merchant');
    this.name = 'RefundExternalReferenceConflictError';
  }
}

export class RefundIdentifierCollisionError extends Error {
  public constructor() {
    super('The generated refund identifier collided with an existing refund');
    this.name = 'RefundIdentifierCollisionError';
  }
}

export class PaymentProviderDeclinedError extends Error {
  public constructor() {
    super('The deterministic payment provider declined the command');
    this.name = 'PaymentProviderDeclinedError';
  }
}

export class PaymentProviderUnavailableError extends Error {
  public constructor() {
    super('The deterministic payment provider is unavailable');
    this.name = 'PaymentProviderUnavailableError';
  }
}

export class PaymentProjectionInvariantError extends Error {
  public constructor() {
    super('The payment projection update violated its financial contract');
    this.name = 'PaymentProjectionInvariantError';
  }
}
