import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import http from 'k6/http';

import { createPayment, json } from './common.js';

const fanoutCompletion = new Rate('settleflow_webhook_fanout_complete');
const fanoutDrainSeconds = new Trend('settleflow_webhook_fanout_drain_seconds', true);
const receiverUrl = __ENV.SETTLEFLOW_WEBHOOK_RECEIVER_URL;

if (typeof receiverUrl !== 'string' || receiverUrl.length === 0) {
  throw new Error('SETTLEFLOW_WEBHOOK_RECEIVER_URL is required');
}

export const options = {
  discardResponseBodies: false,
  scenarios: {
    webhook_fanout: {
      executor: 'shared-iterations',
      iterations: 1000,
      maxDuration: '3m',
      vus: 30,
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    settleflow_webhook_fanout_complete: ['rate==1'],
    settleflow_webhook_fanout_drain_seconds: ['max<300'],
  },
};

function successfulCreatedAttempts() {
  const response = http.get(receiverUrl, {
    responseCallback: http.expectedStatuses(200),
    tags: { operation: 'webhook.receiver.evidence' },
  });
  const attempts = json(response);
  if (!Array.isArray(attempts)) return undefined;
  return attempts.filter(
    (attempt) => attempt?.eventType === 'payment.created.v1' && attempt?.succeeded === true,
  ).length;
}

export function setup() {
  const baseline = successfulCreatedAttempts();
  if (!Number.isInteger(baseline)) throw new Error('webhook receiver evidence is unavailable');
  return { baseline };
}

export default function webhookFanout() {
  const created = createPayment('fanout');
  check(created.response, {
    'fanout source event commits': () => created.valid,
  });
}

export function teardown(data) {
  const startedAt = Date.now();
  const expected = data.baseline + 1000;
  let observed = data.baseline;
  while (Date.now() - startedAt < 300_000) {
    observed = successfulCreatedAttempts() ?? observed;
    if (observed >= expected) break;
    sleep(0.25);
  }
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  fanoutDrainSeconds.add(elapsedSeconds);
  fanoutCompletion.add(observed === expected);
  check(observed, {
    'exactly 1000 healthy endpoint deliveries drain': (count) => count === expected,
  });
}
