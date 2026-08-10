import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'EPL-2.0',
  'ISC',
  'MIT',
  'MIT and ISC',
  'Python-2.0',
  'Unlicense',
]);

function validateReviews(document) {
  if (document?.schemaVersion !== 1 || !Array.isArray(document.reviews)) {
    throw new Error('License reviews must use schemaVersion 1 and a reviews array');
  }
  return document.reviews;
}

export function evaluateLicenseReport(report, reviews, readLicense = readFileSync) {
  const failures = [];
  for (const [license, packages] of Object.entries(report)) {
    if (ALLOWED_LICENSES.has(license)) continue;
    for (const package_ of packages) {
      for (const version of package_.versions ?? []) {
        const review = reviews.find(
          (candidate) =>
            candidate.packageName === package_.name &&
            candidate.version === version &&
            candidate.reportedLicense === license &&
            ALLOWED_LICENSES.has(candidate.concludedLicense),
        );
        if (review === undefined) {
          failures.push(`${package_.name}@${version} (${license})`);
          continue;
        }
        const packagePath = (package_.paths ?? []).find((candidate) => {
          try {
            return statSync(candidate).isDirectory();
          } catch {
            return false;
          }
        });
        if (packagePath === undefined) {
          failures.push(`${package_.name}@${version} (review evidence unavailable)`);
          continue;
        }
        const evidence = readLicense(resolve(packagePath, review.licenseFile));
        const digest = createHash('sha256').update(evidence).digest('hex');
        if (digest !== review.licenseSha256) {
          failures.push(`${package_.name}@${version} (review evidence changed)`);
        }
      }
    }
  }
  return failures;
}

export function runLicenseCheck(root = process.cwd()) {
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
  const arguments_ =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'pnpm licenses list --prod --json']
      : ['licenses', 'list', '--prod', '--json'];
  const result = spawnSync(command, arguments_, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Unable to inventory production dependency licenses');
  const report = JSON.parse(result.stdout);
  const reviews = validateReviews(
    JSON.parse(readFileSync(resolve(root, 'security/license-reviews.json'), 'utf8')),
  );
  const failures = evaluateLicenseReport(report, reviews);
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    throw new Error('Production dependency license review failed');
  }
  process.stdout.write('Production dependency license inventory passed policy.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runLicenseCheck();

export const licensePolicyInternals = { ALLOWED_LICENSES, validateReviews };
