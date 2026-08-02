import {
  InvalidPaymentIntentRequestError,
  UnsupportedCaptureMethodError,
  UnsupportedPaymentCurrencyError,
} from '@settleflow/payments';

import {
  exactSafeIntegerFromToken,
  parseCaptureBody,
  parsePaymentIntentBody,
  parseRefundBody,
} from './payment-intent-body.parser';

function body(amountMinor: string, overrides = ''): Buffer {
  return Buffer.from(
    `{"externalRef":"order_1001","amountMinor":${amountMinor},"currency":"ETB","captureMethod":"manual"${overrides}}`,
  );
}

describe('Payment Intent raw-body parsing', () => {
  it.each([
    ['1000', 1_000],
    ['1000.0', 1_000],
    ['1e3', 1_000],
    ['1.000e3', 1_000],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('canonicalizes exactly representable integer token %s', (token, expected) => {
    expect(exactSafeIntegerFromToken(token)).toBe(expected);
    expect(parsePaymentIntentBody(body(token)).amountMinor).toBe(expected);
  });

  it.each(['0', '-1', '1.1', '1e-1', '1.0001e3', '9007199254740992', '1e9999999'])(
    'rejects fractional, non-positive, unsafe, or unbounded token %s',
    (token) => {
      expect(() => exactSafeIntegerFromToken(token)).toThrow(InvalidPaymentIntentRequestError);
    },
  );

  it('rejects duplicate, unknown, missing, string, and malformed fields', () => {
    expect(() => parsePaymentIntentBody(body('1000', ',"amountMinor":1000'))).toThrow(
      InvalidPaymentIntentRequestError,
    );
    expect(() => parsePaymentIntentBody(body('1000', ',"merchantId":"forbidden"'))).toThrow(
      InvalidPaymentIntentRequestError,
    );
    expect(() => parsePaymentIntentBody(Buffer.from('{"amountMinor":1000}'))).toThrow(
      InvalidPaymentIntentRequestError,
    );
    expect(() => parsePaymentIntentBody(body('"1000"'))).toThrow(InvalidPaymentIntentRequestError);
    expect(() => parsePaymentIntentBody(Buffer.from('{'))).toThrow(
      InvalidPaymentIntentRequestError,
    );
  });

  it('separates well-formed unsupported semantic values from invalid values', () => {
    expect(() =>
      parsePaymentIntentBody(
        Buffer.from(
          '{"externalRef":"order","amountMinor":1000,"currency":"EUR","captureMethod":"manual"}',
        ),
      ),
    ).toThrow(UnsupportedPaymentCurrencyError);
    expect(() =>
      parsePaymentIntentBody(
        Buffer.from(
          '{"externalRef":"order","amountMinor":1000,"currency":"ETB","captureMethod":"automatic"}',
        ),
      ),
    ).toThrow(UnsupportedCaptureMethodError);
  });

  it('uses the same lossless money rules for full capture and refunds', () => {
    expect(parseCaptureBody(Buffer.from('{"amountMinor":1e3,"currency":"ETB"}'))).toEqual({
      amountMinor: 1_000,
      currency: 'ETB',
    });
    expect(
      parseRefundBody(
        Buffer.from('{"externalRef":"refund_1","amountMinor":1000.0,"currency":"USD"}'),
      ),
    ).toEqual({ amountMinor: 1_000, currency: 'USD', externalRef: 'refund_1' });
    expect(() =>
      parseCaptureBody(Buffer.from('{"amountMinor":9007199254740992,"currency":"ETB"}')),
    ).toThrow(InvalidPaymentIntentRequestError);
    expect(() =>
      parseRefundBody(Buffer.from('{"externalRef":"refund_1","amountMinor":1.1,"currency":"ETB"}')),
    ).toThrow(InvalidPaymentIntentRequestError);
  });
});
