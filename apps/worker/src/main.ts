import { ShutdownSignal } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { StructuredJsonLogger, TelemetryRuntime } from '@settleflow/infrastructure';

import { WorkerHealthService } from './health/worker-health.service';
import { WorkerModule } from './worker.module';

function bootstrapLogger(): StructuredJsonLogger {
  const environment = ['development', 'production', 'test'].includes(process.env['NODE_ENV'] ?? '')
    ? (process.env['NODE_ENV'] as 'development' | 'production' | 'test')
    : 'development';
  const releaseCommit = /^(?:local|[a-f\d]{7,64})$/iu.test(process.env['RELEASE_COMMIT'] ?? '')
    ? process.env['RELEASE_COMMIT']!
    : 'local';
  const releaseVersion = /^[a-z\d][a-z\d.+-]{0,63}$/iu.test(process.env['RELEASE_VERSION'] ?? '')
    ? process.env['RELEASE_VERSION']!
    : '0.0.0-dev';
  return new StructuredJsonLogger({
    environment,
    releaseCommit,
    releaseVersion,
    service: 'worker',
  });
}

async function bootstrap(): Promise<void> {
  const logger = bootstrapLogger();
  try {
    const app = await NestFactory.createApplicationContext(WorkerModule, { logger });
    const health = app.get(WorkerHealthService);
    const telemetry = app.get(TelemetryRuntime);

    app.useLogger(telemetry.logger);
    app.enableShutdownHooks([ShutdownSignal.SIGINT, ShutdownSignal.SIGTERM]);
    telemetry.logger.record('info', {
      event: 'worker.started',
      status: health.getReadiness().status,
    });
  } catch {
    logger.record('error', { code: 'bootstrap_failed', event: 'worker.start_failed' });
    process.exitCode = 1;
  }
}

void bootstrap();
