import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { readSecurityExceptions } from './check-security-exceptions.mjs';

export function evaluateAuditReport(report, exceptions) {
  const findings = Object.values(report?.advisories ?? {});
  const failures = [];
  for (const finding of findings) {
    const severity = String(finding.severity ?? '').toLowerCase();
    if (severity !== 'critical' && severity !== 'high') continue;
    const findingId = finding.github_advisory_id ?? String(finding.id ?? 'unknown');
    const artifact = String(finding.module_name ?? 'unknown');
    const excepted = exceptions.some(
      (exception) =>
        exception.tool === 'pnpm-audit' &&
        exception.findingId === findingId &&
        exception.affectedArtifact === artifact,
    );
    if (severity === 'critical' || !excepted) {
      failures.push({ artifact, findingId, severity });
    }
  }
  return failures;
}

export function runDependencyAudit(root = process.cwd()) {
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
  const arguments_ =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'pnpm audit --prod --json']
      : ['audit', '--prod', '--json'];
  const result = spawnSync(command, arguments_, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error('pnpm audit did not return valid JSON');
  }
  const failures = evaluateAuditReport(report, readSecurityExceptions(root));
  if (failures.length > 0) {
    for (const finding of failures) {
      process.stderr.write(
        `${finding.severity} dependency finding ${finding.findingId} affects ${finding.artifact}\n`,
      );
    }
    throw new Error('Dependency audit has critical or unreviewed high findings');
  }
  process.stdout.write('Dependency audit has no critical or unreviewed high findings.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runDependencyAudit();
}
