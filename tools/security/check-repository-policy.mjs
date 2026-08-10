import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.pnpm-store',
  '.settleflow',
  'coverage',
  'dist',
  'node_modules',
]);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const PINNED_IMAGE = /^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/u;

function listFiles(root, name) {
  const matches = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === name) matches.push(path);
    }
  }
  visit(root);
  return matches;
}

export function checkRepositoryPolicy(root) {
  const failures = [];
  const packagePaths = listFiles(root, 'package.json');
  const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const nodeVersion = readFileSync(resolve(root, '.node-version'), 'utf8').trim();
  if (nodeVersion !== rootPackage.engines.node) {
    failures.push('.node-version and package.json engines.node differ');
  }
  if (rootPackage.packageManager !== `pnpm@${rootPackage.engines.pnpm}`) {
    failures.push('packageManager and engines.pnpm differ');
  }
  for (const packagePath of packagePaths) {
    const model = JSON.parse(readFileSync(packagePath, 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(model[section] ?? {})) {
        if (!EXACT_VERSION.test(version) && version !== 'workspace:*') {
          failures.push(
            `${relative(root, packagePath)} ${section}.${name} is not an exact or workspace-local version`,
          );
        }
      }
    }
  }
  const forbiddenLockfiles = [
    ...listFiles(root, 'package-lock.json'),
    ...listFiles(root, 'npm-shrinkwrap.json'),
    ...listFiles(root, 'yarn.lock'),
  ];
  if (forbiddenLockfiles.length > 0) failures.push('A second package-manager lockfile exists');
  const gitleaksReviews = JSON.parse(
    readFileSync(resolve(root, 'security/gitleaks-reviews.json'), 'utf8'),
  );
  const ignoredFingerprints = readFileSync(resolve(root, '.gitleaksignore'), 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  const reviewedFingerprints = (gitleaksReviews.reviews ?? [])
    .map((review) => review.fingerprint)
    .sort();
  if (
    gitleaksReviews.schemaVersion !== 1 ||
    JSON.stringify(ignoredFingerprints) !== JSON.stringify(reviewedFingerprints)
  ) {
    failures.push('Gitleaks ignores must exactly match reviewed false-positive fingerprints');
  }
  for (const review of gitleaksReviews.reviews ?? []) {
    if (
      !/^[a-f0-9]{40}:[^:\r\n]+:[a-z0-9-]+:\d+$/u.test(review.fingerprint) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(review.reviewedAt) ||
      !/^[\x20-\x7e]{1,160}$/u.test(review.classification)
    ) {
      failures.push('Gitleaks false-positive review is malformed or unbounded');
    }
  }
  const toolModel = JSON.parse(
    readFileSync(resolve(root, 'tools/security/tool-images.json'), 'utf8'),
  );
  if (toolModel.schemaVersion !== 1 || typeof toolModel.tools !== 'object') {
    failures.push('Security tool image policy has an unsupported schema');
  } else {
    for (const [name, tool] of Object.entries(toolModel.tools)) {
      if (!EXACT_VERSION.test(tool.version) || !PINNED_IMAGE.test(tool.image)) {
        failures.push(`${name} is not pinned by exact version and registry digest`);
      }
    }
  }
  if (basename(resolve(root, 'pnpm-lock.yaml')) !== 'pnpm-lock.yaml') {
    failures.push('The shared pnpm lockfile is unavailable');
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const failures = checkRepositoryPolicy(process.cwd());
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write('Repository pinning and lockfile policy passed.\n');
}
