import { InvalidWebhookEndpointRequestError, UnsupportedWebhookEventError } from './webhook.errors';
import {
  assertWebhookEndpointId,
  parseCreateWebhookEndpoint,
  parsePatchWebhookEndpoint,
  parseSubscriptions,
} from './webhook.validation';

describe('webhook endpoint request validation', () => {
  it('accepts the exact endpoint identifier, create body, and patch dimensions', () => {
    expect(() => assertWebhookEndpointId('whe_01ARZ3NDEKTSV4RRFFQ69G5FAV')).not.toThrow();
    expect(
      parseCreateWebhookEndpoint({
        subscriptions: ['payment.created.v1'],
        url: 'https://example.com/webhooks',
      }),
    ).toEqual({
      subscriptions: ['payment.created.v1'],
      url: 'https://example.com/webhooks',
    });
    expect(
      parsePatchWebhookEndpoint({
        status: 'inactive',
        subscriptions: ['payment.created.v1'],
      }),
    ).toEqual({ status: 'inactive', subscriptions: ['payment.created.v1'] });
    expect(parsePatchWebhookEndpoint({ status: 'active' })).toEqual({ status: 'active' });
    expect(parsePatchWebhookEndpoint({ subscriptions: ['payment.created.v1'] })).toEqual({
      subscriptions: ['payment.created.v1'],
    });
  });

  it.each(['', 'whe_invalid', 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV'])(
    'rejects invalid endpoint identifier %p',
    (value) => {
      expect(() => assertWebhookEndpointId(value)).toThrow(InvalidWebhookEndpointRequestError);
    },
  );

  it.each([
    undefined,
    null,
    'payment.created.v1',
    [],
    [1],
    ['payment.created.v1', 'payment.created.v1'],
  ])('rejects structurally invalid subscription selection %p', (value) => {
    expect(() => parseSubscriptions(value)).toThrow(InvalidWebhookEndpointRequestError);
  });

  it('distinguishes a well-formed but unsupported event subscription', () => {
    expect(() => parseSubscriptions(['payment.unknown.v1'])).toThrow(UnsupportedWebhookEventError);
  });

  it.each([
    null,
    [],
    { subscriptions: ['payment.created.v1'], url: 'https://example.com', extra: true },
    { subscriptions: ['payment.created.v1'] },
    { subscriptions: ['payment.created.v1'], url: 7 },
  ])('rejects non-exact create request %p', (value) => {
    expect(() => parseCreateWebhookEndpoint(value)).toThrow(InvalidWebhookEndpointRequestError);
  });

  it.each([null, [], {}, { extra: true }, { status: 'deleted' }, { status: null }])(
    'rejects non-exact patch request %p',
    (value) => {
      expect(() => parsePatchWebhookEndpoint(value)).toThrow(InvalidWebhookEndpointRequestError);
    },
  );
});
