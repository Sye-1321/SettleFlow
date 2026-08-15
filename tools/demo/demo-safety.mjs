import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URL } from 'node:url';

export const DEMO_COMPOSE_PROJECT = 'settleflow-demo';
export const DEMO_DATABASE_NAME = 'settleflow_demo';
export const DEMO_VOLUME_KEYS = Object.freeze([
  'demo_postgres_data',
  'demo_prometheus_data',
  'demo_rabbitmq_data',
]);

const SAFE_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const FORBIDDEN_EVIDENCE_KEY =
  /(?:amount|authorization|body|csv|database|dns|endpoint|error|external|key|payload|provider|rabbit|reference|secret|signature|sql|stack|url)/iu;
const SAFE_TERMINAL_STATES = new Set([
  'CAPTURED',
  'COMPLETED',
  'DELIVERED',
  'PARTIALLY_REFUNDED',
  'PASS',
  'PUBLISHED',
  'READY',
  'RECOVERED',
  'RETRYING',
  'SETTLED',
  'STAGED',
  'UNREADY',
]);

export function assertDemoEnvironment(environment, databaseUrl) {
  if (environment.NODE_ENV === 'production') {
    throw new Error('demo_production_refused');
  }
  if (environment.SETTLEFLOW_DEMO_MODE !== 'true') {
    throw new Error('demo_sentinel_required');
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('demo_database_target_invalid');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !SAFE_HOSTS.has(parsed.hostname) ||
    databaseName !== DEMO_DATABASE_NAME ||
    parsed.username !== 'settleflow_app'
  ) {
    throw new Error('demo_database_target_unsafe');
  }
}

export function assertDemoComposeModel(model) {
  if (model?.name !== DEMO_COMPOSE_PROJECT) throw new Error('demo_project_identity_unsafe');
  const volumeKeys = Object.keys(model.volumes ?? {}).sort();
  if (JSON.stringify(volumeKeys) !== JSON.stringify([...DEMO_VOLUME_KEYS].sort())) {
    throw new Error('demo_volume_identity_unsafe');
  }
  for (const volume of Object.values(model.volumes ?? {})) {
    const name = String(volume?.name ?? '');
    if (
      !name.startsWith(`${DEMO_COMPOSE_PROJECT}_`) ||
      /(?:release|settleflow_postgres_data|settleflow_rabbitmq_data)/iu.test(name)
    ) {
      throw new Error('demo_volume_identity_unsafe');
    }
  }
}

export function assertResetVolumes(volumes) {
  for (const volume of volumes) {
    if (
      volume.project !== DEMO_COMPOSE_PROJECT ||
      !DEMO_VOLUME_KEYS.includes(volume.key) ||
      volume.name !== `${DEMO_COMPOSE_PROJECT}_${volume.key}`
    ) {
      throw new Error('demo_reset_target_unsafe');
    }
  }
}

function assertSafeScalar(value) {
  if (typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return;
  if (typeof value === 'string' && /^[A-Za-z0-9 ./_:+-]{1,160}$/u.test(value)) return;
  throw new Error('demo_evidence_value_unsafe');
}

function assertSafeEvidenceValue(value, parentKey = '') {
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error('demo_evidence_value_unsafe');
    for (const entry of value) assertSafeEvidenceValue(entry, parentKey);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_EVIDENCE_KEY.test(key)) throw new Error('demo_evidence_field_forbidden');
      assertSafeEvidenceValue(entry, key);
    }
    return;
  }
  if (parentKey === 'state' && !SAFE_TERMINAL_STATES.has(String(value))) {
    throw new Error('demo_evidence_state_unsafe');
  }
  assertSafeScalar(value);
}

export function assertSafeEvidenceManifest(manifest) {
  const keys = Object.keys(manifest).sort();
  const expected = [
    'checks',
    'commands',
    'counts',
    'elapsedMs',
    'formatVersion',
    'runbooks',
    'sourceCommit',
    'sourceState',
    'status',
    'terminalStates',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error('demo_evidence_shape_unsafe');
  }
  if (!/^[a-f\d]{40}$/u.test(manifest.sourceCommit)) {
    throw new Error('demo_evidence_source_unsafe');
  }
  assertSafeEvidenceValue(manifest);
  return manifest;
}

export function completedEvidenceExists(path) {
  if (!existsSync(path)) return false;
  try {
    return assertSafeEvidenceManifest(JSON.parse(readFileSync(path, 'utf8'))).status === 'PASS';
  } catch {
    throw new Error('demo_existing_evidence_unsafe');
  }
}

export function demoPaths(root) {
  const directory = resolve(root, '.settleflow', 'demo');
  return {
    directory,
    evidence: resolve(directory, 'evidence.json'),
  };
}
