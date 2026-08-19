import { check } from 'k6';
import execution from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';
import http from 'k6/http';

import { BASE_URL, json, readHeaders, RUN_ID } from './common.js';

const batchFailures = new Rate('settleflow_settlement_batch_failures');
const batchDuration = new Trend('settleflow_settlement_batch_duration_ms', true);
const fixtures = JSON.parse(__ENV.SETTLEFLOW_SETTLEMENT_FIXTURES_JSON ?? 'null');

if (!Array.isArray(fixtures) || fixtures.length !== 10) {
  throw new Error('SETTLEFLOW_SETTLEMENT_FIXTURES_JSON must contain exactly 10 merchants');
}

export const options = {
  discardResponseBodies: false,
  scenarios: {
    settlement_batch: {
      executor: 'shared-iterations',
      iterations: 10,
      maxDuration: '5m',
      vus: 10,
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    settleflow_settlement_batch_duration_ms: ['max<300000'],
    settleflow_settlement_batch_failures: ['rate==0'],
  },
};

export default function settlementBatch() {
  const index = execution.scenario.iterationInTest;
  const fixture = fixtures[index];
  const startedAt = Date.now();
  const response = http.post(
    `${BASE_URL}/v1/settlement-runs`,
    JSON.stringify({ currency: fixture.currency, cutoffDate: fixture.cutoffDate }),
    {
      headers: {
        ...readHeaders(fixture.apiKey),
        'Content-Type': 'application/json',
        'Idempotency-Key': `perf_${RUN_ID}_settlement_${index}`,
      },
      tags: { operation: 'settlement.run' },
    },
  );
  const run = json(response);
  let batch;
  if (response.status === 201 && typeof run?.batchId === 'string') {
    const batchResponse = http.get(`${BASE_URL}/v1/settlement-batches/${run.batchId}?limit=1`, {
      headers: readHeaders(fixture.apiKey),
      tags: { operation: 'settlement.read' },
    });
    batch = json(batchResponse);
  }
  const valid = check(response, {
    'settlement run returns 201': (result) => result.status === 201,
    'settlement run completes one batch': () =>
      run?.status === 'COMPLETED' && /^stb_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(run?.batchId),
    'settlement batch contains exactly 500 unique candidates': () => batch?.itemCount === 500,
  });
  batchDuration.add(Date.now() - startedAt);
  batchFailures.add(!valid);
}
