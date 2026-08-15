import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { checkReleaseConfiguration } from './create-release-config.mjs';

export const RELEASE_IMAGE_TARGETS = Object.freeze(['api', 'worker', 'migrator']);

export function releaseImageBuildCommands(root, composeEnvironment, builderName) {
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

  if (!/^settleflow-release-[1-9][0-9]*$/u.test(builderName)) {
    throw new Error('Release image builder name is invalid');
  }

  const environment = { ...process.env, ...composeEnvironment };
  return {
    bootstrap: ['buildx', 'inspect', '--builder', builderName, '--bootstrap'],
    build: [
      'buildx',
      'bake',
      '--builder',
      builderName,
      '--file',
      resolve(root, 'compose.release.yaml'),
      '--load',
      '--pull',
      '--provenance=mode=max',
      '--sbom=true',
      ...RELEASE_IMAGE_TARGETS,
    ],
    cleanup: ['buildx', 'rm', builderName],
    create: ['buildx', 'create', '--driver', 'docker-container', '--name', builderName],
    environment,
  };
}

export function buildReleaseImages(root = process.cwd()) {
  const configuration = checkReleaseConfiguration(resolve(root, '.settleflow/release-simulation'));
  const builderName = `settleflow-release-${process.pid}`;
  const commands = releaseImageBuildCommands(root, configuration['compose.env'], builderName);
  let failure;
  try {
    for (const [arguments_, errorMessage] of [
      [commands.create, 'Release image builder creation failed'],
      [commands.bootstrap, 'Release image builder bootstrap failed'],
      [commands.build, 'Release image build failed'],
    ]) {
      const result = spawnSync('docker', arguments_, {
        cwd: root,
        env: commands.environment,
        stdio: 'inherit',
        windowsHide: true,
      });
      if (result.status !== 0) throw new Error(errorMessage);
    }
  } catch (error) {
    failure = error;
  }

  const cleanup = spawnSync('docker', commands.cleanup, {
    cwd: root,
    env: commands.environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (failure !== undefined) throw failure;
  if (cleanup.status !== 0) throw new Error('Release image builder cleanup failed');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  buildReleaseImages();
}
