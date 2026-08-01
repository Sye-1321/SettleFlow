import { InvalidPaymentIntentRequestError } from '@settleflow/payments';

import { paymentIntentControllerInternals } from './payment-intent.controller';

describe('Payment Intent command headers', () => {
  it('accepts one bounded idempotency key and JSON content type with parameters', () => {
    const request = {
      headers: {},
      rawHeaders: [
        'Content-Type',
        'application/json; charset=utf-8',
        'Idempotency-Key',
        'local-command-1',
      ],
    };

    expect(paymentIntentControllerInternals.requireIdempotencyKey(request)).toBe('local-command-1');
    expect(() => paymentIntentControllerInternals.requireJsonContentType(request)).not.toThrow();
  });

  it('rejects missing, duplicate, surrounding-whitespace, and control-bearing keys', () => {
    const requests = [
      { headers: {} },
      { headers: {}, rawHeaders: ['Idempotency-Key', 'one', 'Idempotency-Key', 'two'] },
      { headers: { 'idempotency-key': ' padded' } },
      { headers: { 'idempotency-key': 'bad\nvalue' } },
    ];

    for (const request of requests) {
      expect(() => paymentIntentControllerInternals.requireIdempotencyKey(request)).toThrow(
        InvalidPaymentIntentRequestError,
      );
    }
  });

  it('rejects missing, duplicate, and non-JSON content types', () => {
    const requests = [
      { headers: {} },
      {
        headers: {},
        rawHeaders: ['Content-Type', 'application/json', 'Content-Type', 'text/plain'],
      },
      { headers: { 'content-type': 'text/plain' } },
    ];

    for (const request of requests) {
      expect(() => paymentIntentControllerInternals.requireJsonContentType(request)).toThrow(
        InvalidPaymentIntentRequestError,
      );
    }
  });
});
