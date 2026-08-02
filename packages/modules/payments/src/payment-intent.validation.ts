import {
  InvalidPaymentIntentRequestError,
  UnsupportedCaptureMethodError,
  UnsupportedPaymentCurrencyError,
} from './payments.errors';
import type {
  PaymentCurrency,
  ValidatedCaptureFields,
  ValidatedPaymentIntentFields,
  ValidatedRefundFields,
} from './payments.types';

const PAYMENT_ID_PATTERN = /^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const REFUND_ID_PATTERN = /^rf_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const UNICODE_CONTROL_PATTERN = /\p{Cc}/u;
const LONE_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;
const SURROUNDING_WHITESPACE_PATTERN = /^\s|\s$/u;

function scalarLength(value: string): number {
  return [...value].length;
}

export function validateExternalReference(value: unknown): string {
  if (
    typeof value !== 'string' ||
    scalarLength(value) < 1 ||
    scalarLength(value) > 255 ||
    UNICODE_CONTROL_PATTERN.test(value) ||
    LONE_SURROGATE_PATTERN.test(value) ||
    SURROUNDING_WHITESPACE_PATTERN.test(value)
  ) {
    throw new InvalidPaymentIntentRequestError('externalRef');
  }

  return value;
}

export function validatePaymentCurrency(value: unknown): PaymentCurrency {
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
    throw new InvalidPaymentIntentRequestError('currency');
  }
  if (value !== 'ETB' && value !== 'USD') {
    throw new UnsupportedPaymentCurrencyError();
  }
  return value;
}

export function validateCaptureMethod(value: unknown): 'manual' {
  if (typeof value !== 'string') {
    throw new InvalidPaymentIntentRequestError('captureMethod');
  }
  if (value !== 'manual') {
    throw new UnsupportedCaptureMethodError();
  }
  return value;
}

export function validateAmountMinor(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new InvalidPaymentIntentRequestError('amountMinor');
  }
  return value;
}

export function validatePaymentIntentFields(input: {
  readonly amountMinor: unknown;
  readonly captureMethod: unknown;
  readonly currency: unknown;
  readonly externalRef: unknown;
}): ValidatedPaymentIntentFields {
  return {
    amountMinor: validateAmountMinor(input.amountMinor),
    captureMethod: validateCaptureMethod(input.captureMethod),
    currency: validatePaymentCurrency(input.currency),
    externalRef: validateExternalReference(input.externalRef),
  };
}

export function validateCaptureFields(input: {
  readonly amountMinor: unknown;
  readonly currency: unknown;
}): ValidatedCaptureFields {
  return {
    amountMinor: validateAmountMinor(input.amountMinor),
    currency: validatePaymentCurrency(input.currency),
  };
}

export function validateRefundFields(input: {
  readonly amountMinor: unknown;
  readonly currency: unknown;
  readonly externalRef: unknown;
}): ValidatedRefundFields {
  return {
    amountMinor: validateAmountMinor(input.amountMinor),
    currency: validatePaymentCurrency(input.currency),
    externalRef: validateExternalReference(input.externalRef),
  };
}

export function isValidPaymentIntentId(value: string): boolean {
  return PAYMENT_ID_PATTERN.test(value);
}

export function assertValidPaymentIntentId(value: string): void {
  if (!isValidPaymentIntentId(value)) {
    throw new InvalidPaymentIntentRequestError('id');
  }
}

export function isValidRefundId(value: string): boolean {
  return REFUND_ID_PATTERN.test(value);
}

export const paymentIntentValidationInternals = {
  scalarLength,
};
