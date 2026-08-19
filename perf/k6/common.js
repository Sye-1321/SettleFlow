import { check } from 'k6';
import execution from 'k6/execution';
import http from 'k6/http';

function requiredEnvironment(name) {
  const value = __ENV[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export const API_KEY = requiredEnvironment('SETTLEFLOW_API_KEY');
export const BASE_URL = requiredEnvironment('SETTLEFLOW_BASE_URL').replace(/\/$/u, '');
export const RUN_ID = requiredEnvironment('SETTLEFLOW_RUN_ID');

export function authHeaders(idempotencyKey) {
  return {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'X-Request-Id': `perf_${RUN_ID}`,
  };
}

export function readHeaders(apiKey = API_KEY) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'X-Request-Id': `perf_${RUN_ID}`,
  };
}

export function json(response) {
  try {
    return response.json();
  } catch {
    return undefined;
  }
}

export function uniqueToken(label) {
  return `${label}_${RUN_ID}_${execution.vu.idInTest}_${execution.scenario.iterationInTest}`;
}

export function createPayment(label = 'payment', apiKey = API_KEY) {
  const token = uniqueToken(label);
  const amountMinor = 10_000;
  const response = http.post(
    `${BASE_URL}/v1/payment-intents`,
    JSON.stringify({
      amountMinor,
      captureMethod: 'manual',
      currency: 'USD',
      externalRef: token,
    }),
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `${token}_create`,
        'X-Request-Id': `perf_${RUN_ID}`,
      },
      tags: { operation: 'payment.create' },
    },
  );
  const body = json(response);
  const valid = check(response, {
    'payment create returns 201': (result) => result.status === 201,
    'payment create returns a public ID': () => /^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(body?.id),
  });
  return { amountMinor, body, response, token, valid };
}

export const commonInternals = { requiredEnvironment };
