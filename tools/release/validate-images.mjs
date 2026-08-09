import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

import { checkReleaseConfiguration } from './create-release-config.mjs';

function run(arguments_, options = {}) {
  return spawnSync('docker', arguments_, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const configuration = checkReleaseConfiguration(resolve(root, '.settleflow/release-simulation'));
const version = configuration['compose.env'].SETTLEFLOW_IMAGE_VERSION;
const expectedRevision = configuration['compose.env'].SETTLEFLOW_IMAGE_REVISION;
const expectedCreated = configuration['compose.env'].SETTLEFLOW_IMAGE_CREATED;
const images = [
  {
    name: 'api',
    tag: `settleflow-api:${version}`,
    command: 'dist/main.js',
    healthPort: '3000',
    runtimeEntry: '/app/dist/main.js',
  },
  {
    name: 'worker',
    tag: `settleflow-worker:${version}`,
    command: 'dist/main.js',
    healthPort: '9465',
    runtimeEntry: '/app/dist/main.js',
  },
  {
    name: 'migrator',
    tag: `settleflow-migrator:${version}`,
    command: 'tools/release/run-migrations.mjs',
    runtimeEntry: '/app/tools/release/run-migrations.mjs',
  },
];

const filesystemCheck = String.raw`
const fs=require('node:fs');
if(process.getuid?.()!==10001||process.getgid?.()!==10001)throw Error('unexpected runtime identity');
for(const path of ['/app/.env','/app/.git','/app/src','/app/test','/app/tsconfig.json'])if(fs.existsSync(path))throw Error('forbidden artifact '+path);
for(const dependency of ['jest','typescript']){try{require.resolve(dependency+'/package.json');throw Error('development dependency '+dependency)}catch(error){if(!String(error.message).startsWith('Cannot find module'))throw error}}
if(process.env.SETTLEFLOW_IMAGE_ROLE!=='migrator'){try{require.resolve('prisma/package.json');throw Error('development dependency prisma')}catch(error){if(!String(error.message).startsWith('Cannot find module'))throw error}}
const scan=(directory)=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){if(entry.name==='node_modules')continue;const path=directory+'/'+entry.name;if(entry.isDirectory())scan(path);else if(/\.(?:map|ts|tsbuildinfo)$/.test(entry.name))throw Error('source artifact '+path)}};
scan('/app');
if(!fs.existsSync(process.env.SETTLEFLOW_RUNTIME_ENTRY))throw Error('missing runtime entrypoint');
if(process.env.SETTLEFLOW_IMAGE_ROLE==='migrator'){
  for(const path of ['/app/prisma/schema.prisma','/app/prisma/migrations','/app/tools/release/verify-release-database.mjs'])if(!fs.existsSync(path))throw Error('missing migration artifact '+path);
  require.resolve('prisma/package.json');
}
`;

for (const image of images) {
  const inspected = run(['image', 'inspect', image.tag]);
  if (inspected.status !== 0) throw new Error(`Missing locally built image ${image.tag}`);
  const model = JSON.parse(inspected.stdout)[0];
  const config = model.Config;
  assert(config.User === '10001:10001', `${image.name} image user is not fixed non-root`);
  assert(
    JSON.stringify(config.Entrypoint) === JSON.stringify(['node']),
    `${image.name} entrypoint is not exec-form node`,
  );
  assert(
    JSON.stringify(config.Cmd) === JSON.stringify([image.command]),
    `${image.name} command is unexpected`,
  );
  if (image.healthPort) {
    assert(
      config.Healthcheck?.Test?.join(' ').includes(image.healthPort),
      `${image.name} health metadata is missing`,
    );
  } else {
    assert(config.Healthcheck === undefined, `${image.name} one-shot image has a health check`);
  }
  assert(
    config.Labels['org.opencontainers.image.revision'] === expectedRevision,
    `${image.name} revision label differs`,
  );
  assert(
    config.Labels['org.opencontainers.image.created'] === expectedCreated,
    `${image.name} created label differs`,
  );
  assert(
    config.Labels['org.opencontainers.image.version'] === version,
    `${image.name} version label differs`,
  );
  for (const value of config.Env ?? []) {
    assert(
      !/(?:PASSWORD|SECRET|TOKEN|DATABASE_URL|RABBITMQ_URL)=/u.test(value),
      `${image.name} image environment contains secret material`,
    );
  }
  const contained = run([
    'run',
    '--rm',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=1777',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--env',
    `SETTLEFLOW_IMAGE_ROLE=${image.name}`,
    '--env',
    `SETTLEFLOW_RUNTIME_ENTRY=${image.runtimeEntry}`,
    image.tag,
    '-e',
    filesystemCheck,
  ]);
  if (contained.status !== 0) throw new Error(`${image.name} filesystem/runtime inspection failed`);
}

process.stdout.write(
  'API, worker, and migrator images pass identity, metadata, dependency, and artifact inspection.\n',
);
