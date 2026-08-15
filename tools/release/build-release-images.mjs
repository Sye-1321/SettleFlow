import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { checkReleaseConfiguration } from './create-release-config.mjs';

export const RELEASE_IMAGE_TARGETS = Object.freeze(['api', 'worker', 'migrator']);

export function releaseImageBuildInvocation(root, composeEnvironment) {
  for (const name of [
    'SETTLEFLOW_IMAGE_CREATED',
    'SETTLEFLOW_IMAGE_REVISION',
    'SETTLEFLOW_IMAGE_VERSION',
  ]) {
    if (typeof composeEnvironment[name] !== 'string' || composeEnvironment[name].length === 0) {
      throw new Error(`Release image build configuration is missing ${name}`);
    }
  }
  if (composeEnvironment.SETTLEFLOW_IMAGE_VERSION === 'latest') {
    throw new Error('Release image build must not use latest');
  }

  return {
    arguments: [
      'buildx',
      'bake',
      '--file',
      resolve(root, 'compose.release.yaml'),
      '--load',
      '--pull',
      '--provenance=mode=max',
      '--sbom=true',
      ...RELEASE_IMAGE_TARGETS,
    ],
    environment: { ...process.env, ...composeEnvironment },
  };
}

export function buildReleaseImages(root = process.cwd()) {
  const configuration = checkReleaseConfiguration(resolve(root, '.settleflow/release-simulation'));
  const invocation = releaseImageBuildInvocation(root, configuration['compose.env']);
  const result = spawnSync('docker', invocation.arguments, {
    cwd: root,
    env: invocation.environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Release image build failed');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  buildReleaseImages();
}
