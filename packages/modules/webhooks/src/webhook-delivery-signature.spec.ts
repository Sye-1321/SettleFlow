import { buildWebhookRequestHeaders, verifyWebhookSignature } from './webhook-delivery-signature';

const current = {
  plaintext: 'whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
  secretVersion: 2,
};
const previous = {
  plaintext: 'whsec_AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
  secretVersion: 1,
};
const body = Buffer.from('hello café', 'utf8');
const deliveryId = 'whd_01K00000000000000000000000';
const eventId = 'evt_01K00000000000000000000000';
const timestamp = 1_785_402_112n;

describe('webhook delivery signatures', () => {
  it('matches the accepted exact-byte current and previous HMAC vectors', () => {
    const headers = buildWebhookRequestHeaders({
      body,
      current,
      deliveryId,
      eventId,
      previous,
      timestamp,
    });

    expect(headers).toEqual({
      'Content-Length': '11',
      'Content-Type': 'application/json',
      'SettleFlow-Event-Id': eventId,
      'SettleFlow-Event-Schema-Version': '1',
      'SettleFlow-Event-Type': 'payment.created.v1',
      'SettleFlow-Signature':
        'v1,I2MICsDTowv6jd1lrOABxV_qUccUSCAtF5LT7_lmBus;v1,YSLh-BfjNdhfDloO_F9zQnqxvYHvKHz-K-reHfXST9A',
      'SettleFlow-Timestamp': '1785402112',
      'SettleFlow-Webhook-Id': deliveryId,
      'User-Agent': 'SettleFlow-Webhooks/1.0',
    });
  });

  it('emits current first and omits previous when it is not selected', () => {
    const headers = buildWebhookRequestHeaders({ body, current, deliveryId, eventId, timestamp });
    expect(headers['SettleFlow-Signature']).toBe('v1,I2MICsDTowv6jd1lrOABxV_qUccUSCAtF5LT7_lmBus');
  });

  it('verifies raw bytes within five minutes and rejects drift or stale timestamps', () => {
    const signatureHeader = buildWebhookRequestHeaders({
      body,
      current,
      deliveryId,
      eventId,
      timestamp,
    })['SettleFlow-Signature']!;
    expect(
      verifyWebhookSignature({
        body,
        deliveryId,
        nowEpochSeconds: timestamp + 300n,
        secret: current.plaintext,
        signatureHeader,
        timestampHeader: String(timestamp),
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        body: Buffer.from('hello cafe', 'utf8'),
        deliveryId,
        nowEpochSeconds: timestamp,
        secret: current.plaintext,
        signatureHeader,
        timestampHeader: String(timestamp),
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        body,
        deliveryId,
        nowEpochSeconds: timestamp + 301n,
        secret: current.plaintext,
        signatureHeader,
        timestampHeader: String(timestamp),
      }),
    ).toBe(false);
  });
});
