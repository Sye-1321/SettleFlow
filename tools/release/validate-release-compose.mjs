import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { checkReleaseConfiguration } from './create-release-config.mjs';

function compose(root, arguments_) {
  return spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      resolve(root, '.settleflow/release-simulation/compose.env'),
      '--file',
      resolve(root, 'compose.release.yaml'),
      ...arguments_,
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const packageModel = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const configuration = checkReleaseConfiguration(resolve(root, '.settleflow/release-simulation'));
const quiet = compose(root, ['--profile', 'telemetry', 'config', '--quiet']);
if (quiet.status !== 0) throw new Error('Release Compose configuration is invalid');
const rendered = compose(root, ['--profile', 'telemetry', 'config', '--format', 'json']);
if (rendered.status !== 0) throw new Error('Release Compose model could not be inspected');
const model = JSON.parse(rendered.stdout);
const services = model.services;

assert(
  model.name === 'settleflow-release-simulation',
  'Compose project name is not release-simulation',
);
assert(model.networks.backend.internal === true, 'Database/broker network must be internal');
assert(model.networks.telemetry.internal === true, 'Telemetry network must be internal');
assert(
  JSON.stringify(services.rabbitmq.healthcheck.test) ===
    JSON.stringify(['CMD', 'gosu', 'rabbitmq', 'rabbitmq-diagnostics', '-q', 'ping']),
  'RabbitMQ health check must not create its Erlang cookie as root',
);
for (const name of ['postgres', 'rabbitmq', 'worker', 'otel-collector']) {
  assert((services[name].ports ?? []).length === 0, `${name} must not publish a host port`);
}
assert(
  services.api.ports.length === 1 && services.api.ports[0].host_ip === '127.0.0.1',
  'API must be loopback-published exactly once',
);
assert(
  services.prometheus.ports.length === 1 && services.prometheus.ports[0].host_ip === '127.0.0.1',
  'Prometheus must be loopback-published exactly once',
);

for (const name of ['api', 'worker', 'migrator']) {
  const service = services[name];
  assert(service.user === '10001:10001', `${name} must use the fixed unprivileged identity`);
  assert(service.read_only === true, `${name} root filesystem must be read-only`);
  assert(service.cap_drop?.includes('ALL'), `${name} must drop all Linux capabilities`);
  assert(
    service.security_opt?.includes('no-new-privileges:true'),
    `${name} must forbid privilege escalation`,
  );
  assert(
    service.tmpfs?.length === 1 && service.tmpfs[0].startsWith('/tmp:'),
    `${name} must have one bounded /tmp mount`,
  );
}
for (const name of ['role-provisioner', 'otel-collector', 'prometheus']) {
  assert(
    services[name].tmpfs?.length === 1 && services[name].tmpfs[0].startsWith('/tmp:'),
    `${name} must have one valid /tmp mount`,
  );
}
for (const name of ['api', 'worker']) {
  assert(
    services[name].depends_on.migrator.condition === 'service_completed_successfully',
    `${name} must wait for the one-shot migrator`,
  );
  assert(
    services[name].environment.NODE_ENV === 'development',
    `${name} must remain non-production`,
  );
  assert(
    services[name].environment.SETTLEFLOW_DEPLOYMENT_MODE === 'release-simulation',
    `${name} must declare release-simulation mode`,
  );
  assert(
    !Object.hasOwn(services[name].environment, 'MIGRATION_DATABASE_URL'),
    `${name} must not receive the owner URL`,
  );
  assert(
    !Object.hasOwn(services[name].environment, 'POSTGRES_PASSWORD'),
    `${name} must not receive the owner password`,
  );
}
assert(
  services.migrator.depends_on['role-provisioner'].condition === 'service_completed_successfully',
  'Migrator must wait for role provisioning',
);
assert(services.migrator.restart === 'no', 'Migrator must remain a one-shot service');
assert(
  services['role-provisioner'].restart === 'no',
  'Role provisioner must remain a one-shot service',
);
assert(
  services['role-provisioner'].depends_on.postgres.condition === 'service_healthy',
  'Role provisioning must wait for PostgreSQL health',
);
assert(
  packageModel.scripts['release:up:telemetry'].includes('--no-deps otel-collector prometheus'),
  'Telemetry startup must not restart provisioning, migrations, or applications',
);

for (const name of ['postgres', 'rabbitmq', 'otel-collector', 'prometheus']) {
  assert(services[name].image.includes('@sha256:'), `${name} external image must be digest-pinned`);
  assert(!services[name].image.endsWith(':latest'), `${name} must not use latest`);
}
assert(
  configuration['compose.env'].SETTLEFLOW_IMAGE_VERSION !== 'latest',
  'Application image version must not be latest',
);
process.stdout.write('Release Compose topology and secret boundaries pass inspection.\n');
