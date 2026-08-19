import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import http from 'k6/http';

import { API_KEY, BASE_URL, json, readHeaders, RUN_ID } from './common.js';

const completionFailures = new Rate('settleflow_reconciliation_completion_failures');
const completionSeconds = new Trend('settleflow_reconciliation_completion_seconds', true);
const fixturePath = __ENV.SETTLEFLOW_RECONCILIATION_CSV;
const periodStart = __ENV.SETTLEFLOW_RECONCILIATION_PERIOD_START;
const periodEnd = __ENV.SETTLEFLOW_RECONCILIATION_PERIOD_END;

if (!fixturePath || !periodStart || !periodEnd) {
  throw new Error('reconciliation fixture path and UTC period are required');
}

const csv = open(fixturePath, 'b');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    reconciliation_import: {
      executor: 'per-vu-iterations',
      iterations: 1,
      maxDuration: '6m',
      vus: 1,
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    settleflow_reconciliation_completion_failures: ['rate==0'],
    settleflow_reconciliation_completion_seconds: ['max<300'],
  },
};

export default function reconciliationImport() {
  const startedAt = Date.now();
  const stagedResponse = http.post(
    `${BASE_URL}/v1/reconciliation-imports`,
    {
      file: http.file(csv, 'synthetic-50000.csv', 'text/csv'),
      periodEnd,
      periodStart,
    },
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Idempotency-Key': `perf_${RUN_ID}_reconciliation`,
        'X-Request-Id': `perf_${RUN_ID}`,
      },
      tags: { operation: 'reconciliation.stage' },
      timeout: '5m',
    },
  );
  const staged = json(stagedResponse);
  let reportResponse;
  let report;
  const deadline = Date.now() + 300_000;
  while (stagedResponse.status === 202 && Date.now() < deadline) {
    reportResponse = http.get(
      `${BASE_URL}/v1/reconciliation-imports/${staged?.id}/report?limit=1`,
      {
        headers: readHeaders(),
        responseCallback: http.expectedStatuses(200, 409),
        tags: { operation: 'reconciliation.report' },
      },
    );
    if (reportResponse.status === 200) {
      report = json(reportResponse);
      break;
    }
    sleep(0.25);
  }

  const classified = Array.isArray(report?.summaries)
    ? report.summaries.reduce(
        (total, summary) =>
          total +
          summary.matchedExactCount +
          summary.providerOnlyCount +
          summary.platformOnlyCount +
          summary.currencyMismatchCount +
          summary.amountMismatchCount +
          summary.statusMismatchCount +
          summary.duplicateProviderRowCount,
        0,
      )
    : -1;
  const valid = check(reportResponse, {
    '50,000-row import stages successfully': () =>
      stagedResponse.status === 202 && staged?.rowCount === 50000,
    'reconciliation reaches completed report': (response) =>
      response?.status === 200 && report?.status === 'COMPLETED',
    'every synthetic row receives one deterministic bucket': () => classified >= 50000,
  });
  completionSeconds.add((Date.now() - startedAt) / 1000);
  completionFailures.add(!valid);
}
