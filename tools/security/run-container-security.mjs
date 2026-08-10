import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { checkReleaseConfiguration } from '../release/create-release-config.mjs';
import { readSecurityExceptions } from './check-security-exceptions.mjs';

const root = process.cwd();
const evidenceDirectory = resolve(root, '.settleflow/ci-evidence');
const toolModel = JSON.parse(
  readFileSync(resolve(root, 'tools/security/tool-images.json'), 'utf8'),
);

function docker(arguments_, options = {}) {
  const result = spawnSync('docker', arguments_, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input: options.input,
    stdio: options.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Docker security command failed (${arguments_[0]})`);
  return result;
}

function git(arguments_, options = {}) {
  const result = spawnSync('git', arguments_, {
    cwd: root,
    encoding: options.encoding,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Unable to collect local Git changes for scanning');
  return result.stdout;
}

function bind(source, target, readonly = false) {
  return `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`;
}

function imageTags() {
  const configuration = checkReleaseConfiguration(resolve(root, '.settleflow/release-simulation'));
  const version = configuration['compose.env'].SETTLEFLOW_IMAGE_VERSION;
  return ['api', 'worker', 'migrator'].map((name) => ({
    name,
    tag: `settleflow-${name}:${version}`,
  }));
}

function scanSecrets() {
  docker([
    'run',
    '--rm',
    '--mount',
    bind(root, '/repo', true),
    toolModel.tools.gitleaks.image,
    'git',
    '/repo',
    '--redact=100',
    '--no-banner',
    '--no-color',
    '--timeout=300',
  ]);
  const trackedDiff = git(['diff', '--binary', '--no-ext-diff', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const chunks = [trackedDiff];
  for (const relativePath of untracked) {
    const path = resolve(root, relativePath);
    const repositoryRelative = relative(root, path);
    if (repositoryRelative.startsWith('..') || isAbsolute(repositoryRelative)) {
      throw new Error('Untracked secret-scan path escaped the repository');
    }
    if (statSync(path).size > 5 * 1024 * 1024) {
      throw new Error(`Untracked file exceeds the secret-scan limit: ${relativePath}`);
    }
    chunks.push(Buffer.from(`\nSettleFlow-Untracked-File: ${relativePath}\n`, 'utf8'));
    chunks.push(readFileSync(path));
  }
  const localChanges = Buffer.concat(chunks);
  if (localChanges.length > 32 * 1024 * 1024) {
    throw new Error('Local change set exceeds the bounded secret-scan input');
  }
  if (localChanges.length > 0) {
    docker(
      [
        'run',
        '--rm',
        '--interactive',
        toolModel.tools.gitleaks.image,
        'stdin',
        '--redact=100',
        '--no-banner',
        '--no-color',
        '--timeout=300',
      ],
      { input: localChanges },
    );
  }
  process.stdout.write('Repository history and working-tree secret scan passed.\n');
}

function lintDockerfile() {
  docker([
    'run',
    '--rm',
    '--mount',
    bind(root, '/repo', true),
    toolModel.tools.hadolint.image,
    'hadolint',
    '--failure-threshold',
    'warning',
    '/repo/Dockerfile',
  ]);
  process.stdout.write('Dockerfile lint passed at warning severity.\n');
}

function withImageArchives(operation) {
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const archives = [];
  try {
    for (const image of imageTags()) {
      const archive = resolve(evidenceDirectory, `${image.name}.image.tar`);
      rmSync(archive, { force: true });
      docker(['image', 'save', '--output', archive, image.tag]);
      archives.push({ ...image, archive });
    }
    operation(archives);
  } finally {
    for (const image of archives) rmSync(image.archive, { force: true });
  }
}

export function summarizeTrivyReports(reports, exceptions) {
  const images = reports.map(({ name, report }) => {
    const findings = [];
    for (const result of report.Results ?? []) {
      for (const finding of result.Vulnerabilities ?? []) {
        const severity = String(finding.Severity ?? '').toLowerCase();
        if (severity !== 'critical' && severity !== 'high') continue;
        const affectedArtifact = `${name}:${finding.PkgName ?? 'unknown'}`;
        const findingId = String(finding.VulnerabilityID ?? 'unknown');
        const excepted =
          severity === 'high' &&
          exceptions.some(
            (exception) =>
              exception.tool === 'trivy' &&
              exception.findingId === findingId &&
              exception.affectedArtifact === affectedArtifact,
          );
        findings.push({
          affectedArtifact,
          excepted,
          fixedVersion: finding.FixedVersion || null,
          findingId,
          installedVersion: finding.InstalledVersion ?? 'unknown',
          severity,
          status: finding.Status ?? 'unknown',
          targetClass: result.Class ?? 'unknown',
          targetType: result.Type ?? 'unknown',
        });
      }
      for (const finding of result.Secrets ?? []) {
        const severity = String(finding.Severity ?? 'high').toLowerCase();
        if (severity !== 'critical' && severity !== 'high') continue;
        const findingId = String(finding.RuleID ?? 'unknown-secret-rule');
        const affectedArtifact = `${name}:${result.Target ?? 'filesystem'}`;
        const excepted =
          severity === 'high' &&
          exceptions.some(
            (exception) =>
              exception.tool === 'trivy' &&
              exception.findingId === findingId &&
              exception.affectedArtifact === affectedArtifact,
          );
        findings.push({
          affectedArtifact,
          excepted,
          findingId,
          severity,
          targetClass: result.Class ?? 'secret',
          targetType: result.Type ?? 'filesystem',
        });
      }
    }
    findings.sort((left, right) =>
      `${left.severity}:${left.findingId}:${left.affectedArtifact}`.localeCompare(
        `${right.severity}:${right.findingId}:${right.affectedArtifact}`,
      ),
    );
    return { findings, name };
  });
  const failures = images.flatMap((image) =>
    image.findings
      .filter((finding) => finding.severity === 'critical' || !finding.excepted)
      .map((finding) => ({ ...finding, image: image.name })),
  );
  return {
    failureCount: failures.length,
    failures,
    images,
    policy: 'zero critical and zero unreviewed high findings',
    schemaVersion: 1,
  };
}

function scanImages() {
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const reports = [];
  withImageArchives((archives) => {
    const cache = resolve(evidenceDirectory, 'trivy-cache');
    mkdirSync(cache, { recursive: true });
    for (const image of archives) {
      const reportName = `${image.name}.trivy.raw.json`;
      const reportPath = resolve(evidenceDirectory, reportName);
      rmSync(reportPath, { force: true });
      try {
        docker([
          'run',
          '--rm',
          '--mount',
          bind(evidenceDirectory, '/evidence'),
          '--mount',
          bind(cache, '/cache'),
          toolModel.tools.trivy.image,
          'image',
          '--input',
          `/evidence/${image.name}.image.tar`,
          '--cache-dir',
          '/cache',
          '--scanners',
          'vuln,secret',
          '--severity',
          'HIGH,CRITICAL',
          '--ignore-status',
          'not_affected',
          '--format',
          'json',
          '--output',
          `/evidence/${reportName}`,
          '--exit-code',
          '0',
          '--disable-telemetry',
          '--no-progress',
          '--timeout',
          '10m',
        ]);
        reports.push({ name: image.name, report: JSON.parse(readFileSync(reportPath, 'utf8')) });
      } finally {
        rmSync(reportPath, { force: true });
      }
    }
  });
  const summary = summarizeTrivyReports(reports, readSecurityExceptions(root));
  writeFileSync(
    resolve(evidenceDirectory, 'image-security-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  for (const image of summary.images) {
    process.stdout.write(`${image.name}: ${image.findings.length} high/critical finding(s).\n`);
  }
  if (summary.failureCount > 0) {
    for (const finding of summary.failures) {
      process.stderr.write(
        `${finding.image} ${finding.severity} ${finding.findingId} affects ${finding.affectedArtifact}\n`,
      );
    }
    throw new Error('Image scan has critical or unreviewed high findings');
  }
  process.stdout.write(
    'API, worker, and migrator images have no critical or unreviewed high findings.\n',
  );
}

function generateSboms() {
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  for (const name of ['api', 'worker', 'migrator']) {
    rmSync(resolve(evidenceDirectory, `${name}.spdx.json`), { force: true });
  }
  withImageArchives((archives) => {
    for (const image of archives) {
      docker([
        'run',
        '--rm',
        '--mount',
        bind(evidenceDirectory, '/evidence'),
        toolModel.tools.syft.image,
        `docker-archive:/evidence/${image.name}.image.tar`,
        '--quiet',
        '--output',
        `spdx-json=/evidence/${image.name}.spdx.json`,
      ]);
    }
  });
  process.stdout.write(`SPDX JSON SBOMs written under ${evidenceDirectory}.\n`);
}

function main() {
  const command = process.argv[2];
  if (command === 'secrets') scanSecrets();
  else if (command === 'dockerfile') lintDockerfile();
  else if (command === 'scan-images') scanImages();
  else if (command === 'sbom') generateSboms();
  else throw new Error('Expected command: secrets, dockerfile, scan-images, or sbom');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
