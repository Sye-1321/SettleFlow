import { Logger, ShutdownSignal } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerHealthService } from './health/worker-health.service';
import { WorkerModule } from './worker.module';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown bootstrap failure';
}

async function bootstrap(): Promise<void> {
  try {
    const app = await NestFactory.createApplicationContext(WorkerModule);
    const health = app.get(WorkerHealthService);

    app.enableShutdownHooks([ShutdownSignal.SIGINT, ShutdownSignal.SIGTERM]);
    Logger.log(
      JSON.stringify({
        event: 'worker.started',
        readiness: health.getReadiness(),
        service: 'worker',
      }),
      'Bootstrap',
    );
  } catch (error: unknown) {
    Logger.error(describeError(error), undefined, 'Bootstrap');
    process.exitCode = 1;
  }
}

void bootstrap();
