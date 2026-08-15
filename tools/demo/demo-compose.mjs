import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { assertDemoComposeModel, DEMO_COMPOSE_PROJECT } from './demo-safety.mjs';

function execute(root, arguments_, options = {}) {
  const { errorCode = 'demo_docker_command_failed', ...spawnOptions } = options;
  const result = spawnSync('docker', arguments_, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    ...spawnOptions,
  });
  if (result.status !== 0) throw new Error(errorCode);
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

export function composeArguments(root, arguments_) {
  return [
    'compose',
    '--project-name',
    DEMO_COMPOSE_PROJECT,
    '--env-file',
    resolve(root, '.settleflow/demo/compose.env'),
    '--file',
    resolve(root, 'compose.demo.yaml'),
    ...arguments_,
  ];
}

export function inspectDemoCompose(root) {
  const source = execute(
    root,
    composeArguments(root, ['--profile', 'telemetry', 'config', '--format', 'json']),
    {
      errorCode: 'demo_compose_config_invalid',
    },
  );
  const model = JSON.parse(source);
  assertDemoComposeModel(model);
  const services = model.services;
  for (const name of ['api', 'worker', 'migrator', 'demo-webhook-receiver']) {
    const service = services[name];
    if (
      service.user !== '10001:10001' ||
      service.read_only !== true ||
      !service.cap_drop?.includes('ALL') ||
      !service.security_opt?.includes('no-new-privileges:true')
    ) {
      throw new Error('demo_app_security_unsafe');
    }
  }
  if (
    services.postgres.ports?.length !== 1 ||
    services.postgres.ports[0].host_ip !== '127.0.0.1' ||
    services.api.ports?.length !== 1 ||
    services.api.ports[0].host_ip !== '127.0.0.1' ||
    (services.rabbitmq.ports ?? []).length !== 0 ||
    (services.worker.ports ?? []).length !== 0 ||
    services['demo-webhook-receiver'].ports?.length !== 1 ||
    services['demo-webhook-receiver'].ports[0].host_ip !== '127.0.0.1' ||
    services.prometheus.ports?.[0]?.host_ip !== '127.0.0.1'
  ) {
    throw new Error('demo_port_boundary_unsafe');
  }
  return model;
}

export function buildDemoImages(root) {
  execute(root, composeArguments(root, ['build', 'api', 'worker', 'migrator']), {
    errorCode: 'demo_image_build_failed',
    stdio: 'inherit',
  });
}

export function startDemoDependencies(root) {
  execute(
    root,
    composeArguments(root, [
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '180',
      'postgres',
      'rabbitmq',
    ]),
    {
      errorCode: 'demo_dependencies_failed',
    },
  );
  execute(root, composeArguments(root, ['run', '--rm', '--no-deps', 'role-provisioner']), {
    errorCode: 'demo_role_provisioning_failed',
  });
  execute(root, composeArguments(root, ['run', '--rm', '--no-deps', 'migrator']), {
    errorCode: 'demo_migration_failed',
  });
}

export function startDemoApplications(root) {
  execute(
    root,
    composeArguments(root, [
      '--profile',
      'telemetry',
      'up',
      '--detach',
      '--no-deps',
      '--wait',
      '--wait-timeout',
      '180',
      'api',
      'worker',
      'demo-webhook-receiver',
      'otel-collector',
      'prometheus',
    ]),
    { errorCode: 'demo_applications_failed' },
  );
}

export function stopRabbitMq(root) {
  execute(root, composeArguments(root, ['stop', '--timeout', '30', 'rabbitmq']), {
    errorCode: 'demo_rabbitmq_stop_failed',
  });
}

export function startRabbitMq(root) {
  execute(
    root,
    composeArguments(root, ['up', '--detach', '--wait', '--wait-timeout', '120', 'rabbitmq']),
    {
      errorCode: 'demo_rabbitmq_start_failed',
    },
  );
}

export function workerReadinessStatus(root) {
  const source = execute(
    root,
    composeArguments(root, [
      'exec',
      '--no-TTY',
      'worker',
      '/nodejs/bin/node',
      '-e',
      "fetch('http://127.0.0.1:9465/health/ready').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('0'))",
    ]),
    { errorCode: 'demo_worker_readiness_failed' },
  );
  return Number(source);
}

export function stopDemo(root) {
  execute(root, composeArguments(root, ['--profile', 'telemetry', 'down', '--remove-orphans']), {
    errorCode: 'demo_shutdown_failed',
  });
}

export function resetDemo(root) {
  execute(
    root,
    composeArguments(root, ['--profile', 'telemetry', 'down', '--volumes', '--remove-orphans']),
    {
      errorCode: 'demo_reset_failed',
    },
  );
}

export function inspectDemoVolumes(root) {
  const output = execute(
    root,
    [
      'volume',
      'ls',
      '--filter',
      `label=com.docker.compose.project=${DEMO_COMPOSE_PROJECT}`,
      '--format',
      'json',
    ],
    {
      errorCode: 'demo_volume_inspection_failed',
    },
  );
  if (output === '') return [];
  return output.split(/\r?\n/u).map((line) => {
    const row = JSON.parse(line);
    const details = JSON.parse(
      execute(root, ['volume', 'inspect', row.Name], {
        errorCode: 'demo_volume_inspection_failed',
      }),
    )[0];
    return {
      key: details.Labels?.['com.docker.compose.volume'],
      name: details.Name,
      project: details.Labels?.['com.docker.compose.project'],
    };
  });
}
