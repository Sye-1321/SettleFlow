import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { checkReleaseConfiguration } from '../release/create-release-config.mjs';

const root = process.cwd();
const evidenceDirectory = resolve(root, '.settleflow/ci-evidence');

function command(name, arguments_) {
  const result = spawnSync(name, arguments_, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Unable to collect release evidence from ${name}`);
  return result.stdout.trim();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function createEvidence({
  configuration,
  imageSecuritySummary,
  images,
  revision,
  toolModel,
}) {
  return {
    schemaVersion: 1,
    generatedAt: configuration['compose.env'].SETTLEFLOW_IMAGE_CREATED,
    sourceRevision: revision,
    version: configuration['compose.env'].SETTLEFLOW_IMAGE_VERSION,
    toolchain: {
      node: '24.18.0',
      pnpm: '11.18.0',
      scanners: Object.fromEntries(
        Object.entries(toolModel.tools).map(([name, tool]) => [name, tool.image]),
      ),
    },
    imageSecuritySummary,
    images,
  };
}

function main() {
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const configuration = checkReleaseConfiguration(resolve(root, '.settleflow/release-simulation'));
  const version = configuration['compose.env'].SETTLEFLOW_IMAGE_VERSION;
  const revision = command('git', ['rev-parse', 'HEAD']);
  if (revision !== configuration['compose.env'].SETTLEFLOW_IMAGE_REVISION) {
    throw new Error('Generated release revision differs from the checked-out commit');
  }
  const images = [];
  for (const name of ['api', 'worker', 'migrator']) {
    const model = JSON.parse(
      command('docker', ['image', 'inspect', `settleflow-${name}:${version}`]),
    )[0];
    const sbomName = `${name}.spdx.json`;
    images.push({
      name,
      tag: `settleflow-${name}:${version}`,
      imageId: model.Id,
      user: model.Config.User,
      entrypoint: model.Config.Entrypoint,
      command: model.Config.Cmd,
      healthcheck: model.Config.Healthcheck?.Test ?? null,
      labels: {
        created: model.Config.Labels['org.opencontainers.image.created'],
        revision: model.Config.Labels['org.opencontainers.image.revision'],
        source: model.Config.Labels['org.opencontainers.image.source'],
        version: model.Config.Labels['org.opencontainers.image.version'],
      },
      sbom: { file: sbomName, sha256: sha256(resolve(evidenceDirectory, sbomName)) },
    });
  }
  const evidence = createEvidence({
    configuration,
    imageSecuritySummary: {
      file: 'image-security-summary.json',
      sha256: sha256(resolve(evidenceDirectory, 'image-security-summary.json')),
    },
    images,
    revision,
    toolModel: JSON.parse(readFileSync(resolve(root, 'tools/security/tool-images.json'), 'utf8')),
  });
  writeFileSync(
    resolve(evidenceDirectory, 'release-evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  process.stdout.write('Secret-free image, SBOM, and source evidence manifest created.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
