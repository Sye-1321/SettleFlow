import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { evaluateAuditReport } from './check-dependency-audit.mjs';
import { evaluateLicenseReport } from './check-licenses.mjs';
import { checkRepositoryPolicy } from './check-repository-policy.mjs';
import { validateSecurityExceptions } from './check-security-exceptions.mjs';
import { validateWorkflow } from './check-workflows.mjs';
import { summarizeTrivyReports } from './run-container-security.mjs';

test('security exception policy accepts only bounded, approved, short-lived high findings', () => {
  const document = {
    schemaVersion: 1,
    exceptions: [
      {
        affectedArtifact: 'example-package',
        approvedAt: '2026-08-10T00:00:00.000Z',
        approvedBy: 'Security Owner',
        compensatingControls: ['Feature is disabled and the affected path is unreachable.'],
        expiresAt: '2026-08-20T00:00:00.000Z',
        findingId: 'GHSA-example',
        owner: 'Security Owner',
        rationale: 'A patched compatible release is not yet available.',
        severity: 'high',
        tool: 'pnpm-audit',
      },
    ],
  };
  assert.equal(
    validateSecurityExceptions(document, new Date('2026-08-11T00:00:00.000Z')).length,
    1,
  );
  assert.throws(
    () =>
      validateSecurityExceptions(
        {
          ...document,
          exceptions: [{ ...document.exceptions[0], severity: 'critical' }],
        },
        new Date('2026-08-11T00:00:00.000Z'),
      ),
    /critical findings always block/u,
  );
  assert.throws(
    () => validateSecurityExceptions(document, new Date('2026-08-20T00:00:00.000Z')),
    /expired/u,
  );
});

test('dependency audit blocks critical and unreviewed high findings', () => {
  const report = {
    advisories: {
      first: {
        github_advisory_id: 'GHSA-high',
        module_name: 'unsafe-high',
        severity: 'high',
      },
      second: {
        github_advisory_id: 'GHSA-critical',
        module_name: 'unsafe-critical',
        severity: 'critical',
      },
    },
  };
  const exceptions = [
    {
      affectedArtifact: 'unsafe-high',
      findingId: 'GHSA-high',
      tool: 'pnpm-audit',
    },
  ];
  assert.deepEqual(evaluateAuditReport(report, exceptions), [
    {
      artifact: 'unsafe-critical',
      findingId: 'GHSA-critical',
      severity: 'critical',
    },
  ]);
});

test('license policy verifies reviewed evidence for undeclared package licenses', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'settleflow-license-'));
  try {
    const license = Buffer.from('The MIT License\n', 'utf8');
    writeFileSync(resolve(directory, 'license'), license);
    const report = {
      Unknown: [{ name: 'example', paths: [directory], versions: ['1.0.0'] }],
    };
    const reviews = [
      {
        concludedLicense: 'MIT',
        licenseFile: 'license',
        licenseSha256: createHash('sha256').update(license).digest('hex'),
        packageName: 'example',
        reportedLicense: 'Unknown',
        version: '1.0.0',
      },
    ];
    assert.deepEqual(evaluateLicenseReport(report, reviews), []);
    assert.match(
      evaluateLicenseReport(report, [{ ...reviews[0], licenseSha256: '0'.repeat(64) }])[0],
      /evidence changed/u,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('workflow policy requires immutable documented actions and least privilege', () => {
  const valid = `name: CI
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ci-test
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
`;
  assert.deepEqual(validateWorkflow(valid, 'valid.yml'), []);
  assert.ok(
    validateWorkflow(valid.replace(/@[a-f0-9]{40} # v7\.0\.1/u, '@v7'), 'unsafe.yml').length > 0,
  );
  assert.ok(validateWorkflow(valid.replace('pull_request:', 'pull_request_target:'), 'unsafe.yml'));

  const approvedDockerSetup = valid.replace(
    / {6}- uses: actions\/checkout@[a-f0-9]{40} # v7\.0\.1\n {8}with:\n {10}persist-credentials: false/u,
    `      - uses: docker/setup-docker-action@77e84dbf09b47d1e29270283c22f16145aa85ca1 # v5.4.0
        with:
          version: version=28.0.4
          daemon-config: '{"features":{"containerd-snapshotter":true}}'`,
  );
  assert.deepEqual(validateWorkflow(approvedDockerSetup, 'docker.yml'), []);
  assert.ok(
    validateWorkflow(
      approvedDockerSetup.replace('docker/setup-docker-action', 'docker/unsafe-action'),
      'unsafe.yml',
    ).some((failure) => failure.includes('action owner docker is not approved')),
  );
  assert.ok(
    validateWorkflow(approvedDockerSetup.replace('version=28.0.4', 'latest'), 'unsafe.yml').some(
      (failure) => failure.includes('Docker Engine must use an exact version'),
    ),
  );
  assert.ok(
    validateWorkflow(
      approvedDockerSetup.replace('containerd-snapshotter":true', 'containerd-snapshotter":false'),
      'unsafe.yml',
    ).some((failure) => failure.includes('Docker containerd image store is required')),
  );
});

test('checked repository obeys exact version, lockfile, and scanner-image policy', () => {
  assert.deepEqual(checkRepositoryPolicy(process.cwd()), []);
});

test('image summary removes secret material and critical findings cannot be excepted', () => {
  const summary = summarizeTrivyReports(
    [
      {
        name: 'api',
        report: {
          Results: [
            {
              Class: 'os-pkgs',
              Secrets: [{ Match: 'must-not-survive', RuleID: 'private-key', Severity: 'HIGH' }],
              Target: 'application-layer',
              Type: 'filesystem',
              Vulnerabilities: [
                {
                  InstalledVersion: '1.0.0',
                  PkgName: 'example',
                  Severity: 'CRITICAL',
                  VulnerabilityID: 'CVE-critical',
                },
              ],
            },
          ],
        },
      },
    ],
    [
      {
        affectedArtifact: 'api:example',
        findingId: 'CVE-critical',
        tool: 'trivy',
      },
    ],
  );
  assert.equal(summary.failureCount, 2);
  assert.equal(JSON.stringify(summary).includes('must-not-survive'), false);
});
