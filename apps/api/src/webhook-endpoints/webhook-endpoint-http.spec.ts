import {
  InvalidWebhookEndpointRequestError,
  WebhookEndpointPreconditionRequiredError,
} from '@settleflow/webhooks';

import {
  encodeWebhookCursor,
  formatWebhookEtag,
  parseWebhookIfMatch,
  parseWebhookListQuery,
} from './webhook-endpoint-http';

const id = 'whe_01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('webhook endpoint HTTP contract helpers', () => {
  it('round-trips the exact strong ETag and canonical keyset cursor', () => {
    const etag = formatWebhookEtag(id, 12);
    expect(etag).toBe('"whe_01ARZ3NDEKTSV4RRFFQ69G5FAV.v12"');
    expect(parseWebhookIfMatch({ headers: { 'if-match': etag } }, id)).toBe(12);

    const cursor = encodeWebhookCursor(id);
    expect(parseWebhookListQuery({ cursor, limit: '100' })).toEqual({
      afterPublicId: id,
      limit: 100,
    });
    expect(parseWebhookListQuery({})).toEqual({ afterPublicId: undefined, limit: 20 });
  });

  it('rejects absent, duplicate, weak, wildcard, wrong-ID, and noncanonical preconditions', () => {
    expect(() => parseWebhookIfMatch({ headers: {} }, id)).toThrow(
      WebhookEndpointPreconditionRequiredError,
    );
    for (const values of [
      ['"whe_01ARZ3NDEKTSV4RRFFQ69G5FAV.v0"', '"whe_01ARZ3NDEKTSV4RRFFQ69G5FAV.v0"'],
      ['W/"whe_01ARZ3NDEKTSV4RRFFQ69G5FAV.v0"'],
      ['*'],
      ['"whe_01ARZ3NDEKTSV4RRFFQ69G5FAA.v0"'],
      ['"whe_01ARZ3NDEKTSV4RRFFQ69G5FAV.v01"'],
    ]) {
      expect(() => parseWebhookIfMatch({ headers: { 'if-match': values } }, id)).toThrow(
        InvalidWebhookEndpointRequestError,
      );
    }
  });

  it('rejects malformed cursors, duplicate query values, and out-of-range limits', () => {
    for (const query of [
      { cursor: '***' },
      { cursor: Buffer.from('{"id":"bad","v":1}').toString('base64url') },
      { limit: '0' },
      { limit: '101' },
      { limit: '01' },
      { limit: ['20', '30'] },
      { unknown: 'value' },
    ]) {
      expect(() => parseWebhookListQuery(query)).toThrow(InvalidWebhookEndpointRequestError);
    }
  });
});
