import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  ContainerWebhookReceiverClient,
  DEMO_RECEIVER_CONTROL_PATH,
  SyntheticWebhookReceiver,
} from './webhook-receiver.mjs';

const deliveryId = 'whd_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const eventId = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const secret = `whsec_${Buffer.alloc(32, 7).toString('base64url')}`;

function request(port, path, body, timestamp, signedBody = body) {
  const input = Buffer.concat([Buffer.from(`${timestamp}.${deliveryId}.`, 'ascii'), signedBody]);
  const signature = createHmac('sha256', secret).update(input).digest('base64url');
  return globalThis.fetch(`http://127.0.0.1:${port}${path}`, {
    body,
    headers: {
      'Content-Type': 'application/json',
      'SettleFlow-Event-Id': eventId,
      'SettleFlow-Event-Schema-Version': '1',
      'SettleFlow-Event-Type': 'payment.created.v1',
      'SettleFlow-Signature': `v1,${signature}`,
      'SettleFlow-Timestamp': timestamp,
      'SettleFlow-Webhook-Id': deliveryId,
    },
    method: 'POST',
  });
}

test('verifies exact bytes/HMAC and fails once before deterministic success', async () => {
  const port = 28_081;
  const path = '/hooks/abcdefghijklmnop';
  const receiver = new SyntheticWebhookReceiver({ path, port });
  receiver.setSecret(secret);
  await receiver.start();
  try {
    const body = Buffer.from(
      JSON.stringify({ eventId, eventType: 'payment.created.v1', schemaVersion: 1 }),
    );
    const timestamp = String(Math.floor(Date.now() / 1_000));
    assert.equal((await request(port, path, body, timestamp)).status, 503);
    assert.equal((await request(port, path, body, timestamp)).status, 204);
    receiver.assertSingleRetryThenSuccess();

    const changed = Buffer.from(`${body.toString('utf8')} `);
    assert.equal((await request(port, path, changed, timestamp, body)).status, 400);
    assert.equal(
      (await request(port, path, body, String(Math.floor(Date.now() / 1_000) - 301))).status,
      400,
    );
  } finally {
    await receiver.close();
  }
});

test('configures a sidecar receiver once and reads only bounded attempt evidence', async () => {
  const port = 28_082;
  const path = '/hooks/sidecarreceiver1';
  const server = new SyntheticWebhookReceiver({
    controlPath: DEMO_RECEIVER_CONTROL_PATH,
    port,
  });
  const client = new ContainerWebhookReceiverClient({ port });
  await server.start();
  try {
    await client.configure(path, secret);
    const body = Buffer.from(JSON.stringify({ eventId, eventType: 'payment.created.v1' }));
    const timestamp = String(Math.floor(Date.now() / 1_000));
    assert.equal((await request(port, path, body, timestamp)).status, 503);
    assert.equal((await request(port, path, body, timestamp)).status, 204);
    const attempts = await client.waitFor({ eventType: 'payment.created.v1' });
    assert.equal(attempts.length, 1);
    client.assertSingleRetryThenSuccess();
    await assert.rejects(client.configure(path, secret), /configuration_failed/u);
  } finally {
    await server.close();
  }
});
