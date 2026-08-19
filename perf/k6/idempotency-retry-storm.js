import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import http from 'k6/http';

import { authHeaders, BASE_URL, createPayment, json } from './common.js';

const groupFailures = new Rate('settleflow_idempotency_group_failures');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    idempotency_retry_storm: {
      duration: '2m',
      executor: 'constant-arrival-rate',
      maxVUs: 80,
      preAllocatedVUs: 20,
      rate: 10,
      timeUnit: '1s',
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    settleflow_idempotency_group_failures: ['rate==0'],
  },
};

export default function idempotencyRetryStorm() {
  const created = createPayment('storm');
  if (!created.valid || typeof created.body?.id !== 'string') {
    groupFailures.add(true);
    return;
  }

  const url = `${BASE_URL}/v1/payment-intents/${created.body.id}/capture`;
  const payload = JSON.stringify({ amountMinor: created.amountMinor, currency: 'USD' });
  const headers = authHeaders(`${created.token}_capture`);
  const requests = Array.from({ length: 5 }, () => [
    'POST',
    url,
    payload,
    {
      headers,
      responseCallback: http.expectedStatuses(200, 409),
      tags: { operation: 'payment.capture.idempotent' },
    },
  ]);
  const responses = http.batch(requests);

  let replay;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    replay = http.post(url, payload, {
      headers,
      responseCallback: http.expectedStatuses(200, 409),
      tags: { operation: 'payment.capture.replay' },
    });
    if (replay.status === 200) break;
    sleep(0.05);
  }

  const successfulBodies = [...responses, replay]
    .filter((response) => response?.status === 200)
    .map((response) => JSON.stringify(json(response)));
  const firstBody = successfulBodies[0];
  const replayBody = json(replay);
  const valid = check(replay, {
    'idempotency group reaches stored 200 replay': (response) => response?.status === 200,
    'successful responses are byte-equivalent JSON': () =>
      firstBody !== undefined && successfulBodies.every((body) => body === firstBody),
    'one stable Ledger transaction is returned': () =>
      /^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(replayBody?.ledgerTransactionId),
  });
  groupFailures.add(!valid);
}
