import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const IMPORT_PATTERN = /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/gu;
const TELEMETRY_VENDOR = /^@opentelemetry\/|^prom-client$/u;

export function checkModuleBoundaries(root, files) {
  const manifests = packageManifests(root, files);
  const failures = [];
  for (const file of files.filter((candidate) => candidate.endsWith('.ts')).sort()) {
    const owner = owningManifest(resolve(root, file), manifests);
    const source = readFileSync(resolve(root, file), 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (TELEMETRY_VENDOR.test(specifier) && owner?.name !== '@settleflow/infrastructure') {
        failures.push(`${file}: telemetry vendor import ${specifier} is Infrastructure-owned`);
      }
      if (specifier.startsWith('@settleflow/') && specifier !== owner?.name) {
        if (owner !== undefined && owner.dependencies[specifier] === undefined) {
          failures.push(`${file}: undeclared cross-module import ${specifier}`);
        }
      }
      if (specifier.startsWith('.')) {
        const imported = resolve(dirname(resolve(root, file)), specifier);
        const targetOwner = owningManifest(imported, manifests);
        if (owner !== undefined && targetOwner !== undefined && owner.name !== targetOwner.name) {
          failures.push(
            `${file}: relative import crosses from ${owner.name} to ${targetOwner.name}`,
          );
        }
      }
    }
  }
  return failures;
}

function packageManifests(root, files) {
  return files
    .filter((file) => /^(?:apps|packages)\/.+\/package\.json$/u.test(file.replaceAll('\\', '/')))
    .map((file) => {
      const path = resolve(root, file);
      const value = JSON.parse(readFileSync(path, 'utf8'));
      return {
        dependencies: value.dependencies ?? {},
        directory: dirname(path),
        name: value.name,
      };
    })
    .sort((left, right) => right.directory.length - left.directory.length);
}

function owningManifest(file, manifests) {
  return manifests.find((manifest) => {
    const path = relative(manifest.directory, file);
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
  });
}

function repositoryFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split(/\r?\n/u)
    .filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.cwd();
  const failures = checkModuleBoundaries(root, repositoryFiles(root));
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Module imports respect declared workspace boundaries.\n');
  }
}
