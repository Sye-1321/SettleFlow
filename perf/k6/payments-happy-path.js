import { check } from 'k6';
import { Rate } from 'k6/metrics';
import http from 'k6/http';

import { authHeaders, BASE_URL, createPayment, json } from './common.js';

const financialEffectFailures = new Rate('settleflow_financial_effect_failures');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    payments_happy_path: {
      executor: 'ramping-vus',
      gracefulStop: '30s',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 30 },
        { duration: '4m', target: 30 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
    settleflow_financial_effect_failures: ['rate==0'],
  },
};

export default function paymentsHappyPath() {
  const created = createPayment('happy');
  if (!created.valid || typeof created.body?.id !== 'string') {
    financialEffectFailures.add(true);
    return;
  }

  const response = http.post(
    `${BASE_URL}/v1/payment-intents/${created.body.id}/capture`,
    JSON.stringify({ amountMinor: created.amountMinor, currency: 'USD' }),
    {
      headers: authHeaders(`${created.token}_capture`),
      tags: { operation: 'payment.capture' },
    },
  );
  const body = json(response);
  const valid = check(response, {
    'capture returns 200': (result) => result.status === 200,
    'capture returns one Ledger transaction': () =>
      /^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(body?.ledgerTransactionId),
    'capture reaches captured state': () => body?.paymentStatus === 'captured',
  });
  financialEffectFailures.add(!valid);
}
