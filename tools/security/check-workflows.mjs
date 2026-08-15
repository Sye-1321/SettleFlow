import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { parseDocument } from 'yaml';

const ACTION_REFERENCE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?@[a-f0-9]{40}$/iu;
const ACTION_LINE =
  /^\s*-?\s*uses:\s*[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?@[a-f0-9]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/imu;
const ALLOWED_ACTION_OWNERS = new Set(['actions', 'github']);
const ALLOWED_THIRD_PARTY_ACTIONS = new Set(['docker/setup-docker-action']);
const ALLOWED_PERMISSION_VALUES = new Set(['none', 'read', 'write']);

function triggerNames(on) {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  if (on !== null && typeof on === 'object') return Object.keys(on);
  return [];
}

function validatePermissions(permissions, jobName, failures) {
  if (permissions === undefined) return;
  if (permissions === 'read-all' || permissions === 'write-all') {
    failures.push(`${jobName}: aggregate permission aliases are prohibited`);
    return;
  }
  if (permissions === null || typeof permissions !== 'object') {
    failures.push(`${jobName}: permissions must be an explicit mapping`);
    return;
  }
  for (const [scope, level] of Object.entries(permissions)) {
    if (!ALLOWED_PERMISSION_VALUES.has(level)) {
      failures.push(`${jobName}: invalid ${scope} permission`);
    }
    if (level === 'write') {
      const allowed =
        (scope === 'security-events' && jobName === 'codeql') ||
        ((scope === 'attestations' || scope === 'id-token') && jobName === 'provenance');
      if (!allowed) failures.push(`${jobName}: write permission for ${scope} is not allowed`);
    }
    if (scope === 'packages' && level !== 'read') {
      failures.push(`${jobName}: packages permission may only be read`);
    }
  }
}

export function validateWorkflow(raw, filename) {
  const failures = [];
  const parsed = parseDocument(raw, { uniqueKeys: true });
  if (parsed.errors.length > 0) return parsed.errors.map(() => `${filename}: invalid YAML`);
  const model = parsed.toJS();
  const triggers = triggerNames(model.on);
  if (triggers.includes('pull_request_target')) {
    failures.push(`${filename}: pull_request_target is prohibited`);
  }
  for (const trigger of triggers) {
    if (!['pull_request', 'push', 'schedule', 'workflow_dispatch'].includes(trigger)) {
      failures.push(`${filename}: unsupported trigger ${trigger}`);
    }
  }
  if (triggers.includes('pull_request')) {
    if (model.concurrency?.['cancel-in-progress'] !== true || !model.concurrency?.group) {
      failures.push(`${filename}: pull-request workflows need canceling concurrency`);
    }
  }
  if (triggers.includes('push')) {
    const branches = model.on?.push?.branches;
    if (!Array.isArray(branches) || JSON.stringify(branches) !== JSON.stringify(['main'])) {
      failures.push(`${filename}: push must be limited to main`);
    }
  }
  if (raw.includes('${{ secrets.')) failures.push(`${filename}: repository secrets are prohibited`);
  if (/continue-on-error:\s*true/iu.test(raw)) {
    failures.push(`${filename}: continue-on-error is prohibited`);
  }
  if (/(?:\|\|\s*true|set\s+\+e)/u.test(raw)) {
    failures.push(`${filename}: shell error suppression is prohibited`);
  }
  if (/(?:^|[:@])latest(?:\s|$)/imu.test(raw)) {
    failures.push(`${filename}: latest references are prohibited`);
  }
  validatePermissions(model.permissions, 'workflow', failures);
  if (model.permissions?.contents !== 'read' || Object.keys(model.permissions).length !== 1) {
    failures.push(`${filename}: top-level permissions must be contents: read only`);
  }
  for (const [jobName, job] of Object.entries(model.jobs ?? {})) {
    if (!Number.isInteger(job['timeout-minutes']) || job['timeout-minutes'] < 1) {
      failures.push(`${filename}/${jobName}: timeout-minutes is required`);
    }
    if (job['timeout-minutes'] > 120) {
      failures.push(`${filename}/${jobName}: timeout exceeds 120 minutes`);
    }
    validatePermissions(job.permissions, jobName, failures);
    for (const step of job.steps ?? []) {
      if (step.uses === undefined) continue;
      if (typeof step.uses !== 'string') {
        failures.push(`${filename}/${jobName}: action reference must be a string`);
        continue;
      }
      if (step.uses.startsWith('./')) continue;
      if (!ACTION_REFERENCE.test(step.uses)) {
        failures.push(`${filename}/${jobName}: action is not pinned to a full commit SHA`);
        continue;
      }
      const action = step.uses.slice(0, step.uses.indexOf('@')).toLowerCase();
      const owner = action.slice(0, action.indexOf('/'));
      if (!ALLOWED_ACTION_OWNERS.has(owner) && !ALLOWED_THIRD_PARTY_ACTIONS.has(action)) {
        failures.push(`${filename}/${jobName}: action owner ${owner} is not approved`);
      }
      if (action === 'docker/setup-docker-action') {
        if (!/^version=\d+\.\d+\.\d+$/u.test(step.with?.version ?? '')) {
          failures.push(`${filename}/${jobName}: Docker Engine must use an exact version`);
        }
        try {
          const daemonConfiguration = JSON.parse(step.with?.['daemon-config'] ?? '');
          if (daemonConfiguration.features?.['containerd-snapshotter'] !== true) {
            failures.push(`${filename}/${jobName}: Docker containerd image store is required`);
          }
        } catch {
          failures.push(`${filename}/${jobName}: Docker daemon configuration must be valid JSON`);
        }
      }
      const escaped = step.uses.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (
        !new RegExp(`^\\s*-?\\s*uses:\\s*${escaped}\\s+#\\s+v\\d+\\.\\d+\\.\\d+\\s*$`, 'mu').test(
          raw,
        )
      ) {
        failures.push(`${filename}/${jobName}: action pin lacks an exact release comment`);
      }
      if (
        step.uses.startsWith('actions/checkout@') &&
        step.with?.['persist-credentials'] !== false
      ) {
        failures.push(`${filename}/${jobName}: checkout must disable persisted credentials`);
      }
    }
  }
  const actionLines = raw.match(/^\s*uses:.*$/gmu) ?? [];
  for (const line of actionLines) {
    if (!line.includes('uses: ./') && !ACTION_LINE.test(line)) {
      failures.push(`${filename}: malformed or undocumented action pin`);
    }
  }
  return failures;
}

export function checkWorkflows(root = process.cwd()) {
  const directory = resolve(root, '.github/workflows');
  const files = readdirSync(directory)
    .filter((file) => /\.ya?ml$/u.test(file))
    .sort();
  if (files.length === 0) return ['No GitHub Actions workflows found'];
  return files.flatMap((file) =>
    validateWorkflow(readFileSync(resolve(directory, file), 'utf8'), basename(file)),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const failures = checkWorkflows();
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write('GitHub Actions syntax and least-privilege policy passed.\n');
}
