import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

export const REFERENCE_SCENARIOS = Object.freeze([
  'payments-happy-path',
  'idempotency-retry-storm',
  'webhook-fanout',
  'settlement-batch',
  'reconciliation-import',
]);

const SAFE_METRICS = Object.freeze({
  'idempotency-retry-storm': ['checks', 'http_req_failed', 'settleflow_idempotency_group_failures'],
  'payments-happy-path': [
    'checks',
    'http_req_duration',
    'http_req_failed',
    'settleflow_financial_effect_failures',
  ],
  'reconciliation-import': [
    'checks',
    'http_req_failed',
    'settleflow_reconciliation_completion_failures',
    'settleflow_reconciliation_completion_seconds',
  ],
  'settlement-batch': [
    'checks',
    'http_req_failed',
    'settleflow_settlement_batch_duration_ms',
    'settleflow_settlement_batch_failures',
  ],
  'webhook-fanout': [
    'checks',
    'http_req_failed',
    'settleflow_webhook_fanout_complete',
    'settleflow_webhook_fanout_drain_seconds',
  ],
});

const SAFE_VALUE_NAMES = new Set([
  'avg',
  'count',
  'fails',
  'max',
  'med',
  'min',
  'p(90)',
  'p(95)',
  'passes',
  'rate',
  'value',
]);

const FORBIDDEN_EVIDENCE_KEY =
  /(?:api.?key|authorization|body|csv|database|dns|endpoint|external|header|merchant|password|payload|provider.?ref|rabbit|request|secret|signature|sql|token|url)/iu;

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function metricEvidence(metric) {
  const values = {};
  for (const [name, value] of Object.entries(metric ?? {})) {
    if (SAFE_VALUE_NAMES.has(name) && safeNumber(value) !== undefined) values[name] = value;
  }
  const thresholds = {};
  for (const [expression, crossed] of Object.entries(metric?.thresholds ?? {})) {
    if (!/^[A-Za-z0-9().<>=_% -]{1,96}$/u.test(expression)) {
      throw new Error('performance_threshold_expression_unsafe');
    }
    if (typeof crossed !== 'boolean') throw new Error('performance_threshold_result_invalid');
    thresholds[expression] = !crossed;
  }
  return { thresholds, values };
}

function assertSafeEvidenceValue(value, key = '') {
  if (key !== 'rabbitmq' && FORBIDDEN_EVIDENCE_KEY.test(key)) {
    throw new Error('performance_evidence_field_forbidden');
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error('performance_evidence_value_unsafe');
    for (const entry of value) assertSafeEvidenceValue(entry, key);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [childKey, childValue] of Object.entries(value)) {
      assertSafeEvidenceValue(childValue, childKey);
    }
    return;
  }
  if (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
    (typeof value === 'string' && /^[A-Za-z0-9 ._@:/+<>=()%,-]{1,200}$/u.test(value))
  ) {
    return;
  }
  throw new Error('performance_evidence_value_unsafe');
}

export function assertCleanCandidate({ branch, porcelain, revision, upstreamRevision }) {
  if (branch !== 'main') throw new Error('performance_candidate_branch_invalid');
  if (porcelain !== '') throw new Error('performance_candidate_dirty');
  if (!/^[a-f\d]{40}$/u.test(revision)) throw new Error('performance_candidate_revision_invalid');
  if (upstreamRevision !== revision) throw new Error('performance_candidate_not_pushed');
  return revision;
}

export function assertReferenceHost({ containerNames, cpuCount, totalMemoryGiB }) {
  if (
    !Number.isInteger(cpuCount) ||
    cpuCount < 4 ||
    !Number.isInteger(totalMemoryGiB) ||
    totalMemoryGiB < 8
  ) {
    throw new Error('performance_reference_host_capacity_invalid');
  }
  if (
    !Array.isArray(containerNames) ||
    containerNames.some(
      (name) => typeof name !== 'string' || !/^settleflow-demo-[a-z0-9-]+-\d+$/u.test(name),
    )
  ) {
    throw new Error('performance_reference_host_not_isolated');
  }
}

export function buildProviderOnlyCsv({ merchantCode, occurredAt, rowCount = 50_000 }) {
  if (
    !/^demo_[a-z0-9_]{1,58}$/u.test(merchantCode) ||
    !(occurredAt instanceof Date) ||
    !Number.isFinite(occurredAt.getTime()) ||
    !Number.isInteger(rowCount) ||
    rowCount < 1 ||
    rowCount > 50_000
  ) {
    throw new Error('performance_reconciliation_fixture_invalid');
  }
  const header =
    'provider_txn_id,merchant_code,provider_ref,external_ref,event_type,currency,gross_minor,fee_minor,net_minor,status,occurred_at';
  const timestamp = occurredAt.toISOString();
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const ordinal = String(index + 1).padStart(5, '0');
    return `perf_txn_${ordinal},${merchantCode},perf_missing_${ordinal},,capture,USD,10000,0,10000,succeeded,${timestamp}`;
  });
  const bytes = Buffer.from(`${header}\n${rows.join('\n')}\n`, 'utf8');
  if (bytes.byteLength > 10 * 1024 * 1024) {
    throw new Error('performance_reconciliation_fixture_too_large');
  }
  return {
    bytes,
    rowCount,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function sanitizeK6Summary({ candidate, environment, raw, scenario }) {
  if (!REFERENCE_SCENARIOS.includes(scenario)) throw new Error('performance_scenario_invalid');
  if (!/^[a-f\d]{40}$/u.test(candidate.commit)) {
    throw new Error('performance_candidate_revision_invalid');
  }
  const metrics = {};
  for (const name of SAFE_METRICS[scenario]) {
    if (raw?.metrics?.[name] === undefined) throw new Error(`performance_metric_missing:${name}`);
    metrics[name] = metricEvidence(raw.metrics[name]);
  }
  const thresholdsPassed = Object.values(metrics).every(
    (metric) =>
      Object.keys(metric.thresholds).length > 0 && Object.values(metric.thresholds).every(Boolean),
  );
  const evidence = {
    candidate: {
      commit: candidate.commit,
      imageIds: candidate.imageIds,
      version: candidate.version,
    },
    environment,
    k6Image:
      'grafana/k6:1.8.0@sha256:b992f241070f3f3a7d78096fa6020db1edcda49297ee8ed9eb0ab847ef3dcb32',
    metrics,
    scenario,
    schemaVersion: 1,
    status: thresholdsPassed ? 'PASS' : 'FAIL',
  };
  assertSafeEvidenceValue(evidence);
  return evidence;
}

export function validateReferenceEvidence(evidence) {
  assertSafeEvidenceValue(evidence);
  if (
    evidence?.schemaVersion !== 1 ||
    !REFERENCE_SCENARIOS.includes(evidence.scenario) ||
    (evidence.status !== 'PASS' && evidence.status !== 'FAIL')
  ) {
    throw new Error('performance_evidence_invalid');
  }
  if (evidence.status === 'PASS') {
    const imageIds = evidence.candidate?.imageIds;
    const peakResources = evidence.environment?.peakResources;
    const checks = evidence.postRunChecks;
    if (
      !/^[a-f\d]{40}$/u.test(evidence.candidate?.commit ?? '') ||
      evidence.candidate?.version !== 'v1.0.0-rc.1' ||
      !['api', 'migrator', 'worker'].every((name) =>
        /^sha256:[a-f\d]{64}$/u.test(imageIds?.[name] ?? ''),
      ) ||
      Object.keys(imageIds ?? {}).length !== 3 ||
      evidence.k6Image !==
        'grafana/k6:1.8.0@sha256:b992f241070f3f3a7d78096fa6020db1edcda49297ee8ed9eb0ab847ef3dcb32' ||
      Object.keys(evidence.metrics ?? {})
        .sort()
        .join(',') !== [...SAFE_METRICS[evidence.scenario]].sort().join(',') ||
      Object.keys(peakResources ?? {})
        .sort()
        .join(',') !== 'api,postgres,rabbitmq,worker' ||
      typeof evidence.correctness !== 'object' ||
      evidence.correctness === null ||
      Object.keys(evidence.correctness).length === 0 ||
      checks?.invariants !== 'PASS' ||
      checks.migrations !== 'PASS' ||
      checks.runtimePermissions !== 'PASS'
    ) {
      throw new Error('performance_evidence_incomplete');
    }
  }
  return evidence;
}

function parseByteSize(value) {
  const match = /^([0-9]+(?:\.[0-9]+)?)(B|KiB|MiB|GiB)$/u.exec(value.trim());
  if (match === null) throw new Error('performance_resource_value_invalid');
  const multipliers = { B: 1, GiB: 1024 ** 3, KiB: 1024, MiB: 1024 ** 2 };
  return Math.round(Number(match[1]) * multipliers[match[2]]);
}

export function parseDockerStats(source) {
  const rows = [];
  for (const line of source.split(/\r?\n/u).filter(Boolean)) {
    const row = JSON.parse(line);
    const memory = String(row.MemUsage ?? '')
      .split('/')[0]
      ?.trim();
    const cpu = /^([0-9]+(?:\.[0-9]+)?)%$/u.exec(String(row.CPUPerc ?? ''));
    if (
      typeof row.Name !== 'string' ||
      !/^settleflow-demo-(?:api|postgres|rabbitmq|worker)-1$/u.test(row.Name) ||
      memory === undefined ||
      cpu === null
    ) {
      throw new Error('performance_resource_sample_invalid');
    }
    rows.push({
      cpuPercent: Number(cpu[1]),
      memoryBytes: parseByteSize(memory),
      service: row.Name.replace(/^settleflow-demo-/u, '').replace(/-1$/u, ''),
    });
  }
  return rows;
}

export const referenceSafetyInternals = { metricEvidence, parseByteSize, SAFE_METRICS };
