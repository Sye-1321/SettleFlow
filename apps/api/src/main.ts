import { ShutdownSignal } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { StructuredJsonLogger, TelemetryRuntime } from '@settleflow/infrastructure';

import { AppModule } from './app.module';
import { ApiEnvironment } from './config/environment';
import { configureOpenApi } from './openapi';

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
  return new StructuredJsonLogger({ environment, releaseCommit, releaseVersion, service: 'api' });
}

async function bootstrap(): Promise<void> {
  const logger = bootstrapLogger();
  try {
    const app = await NestFactory.create(AppModule, { logger, rawBody: true });
    const config = app.get<ConfigService<ApiEnvironment, true>>(ConfigService);
    const telemetry = app.get(TelemetryRuntime);
    const host = config.get('API_HOST', { infer: true });
    const port = config.get('API_PORT', { infer: true });

    app.useLogger(telemetry.logger);
    app.enableShutdownHooks([ShutdownSignal.SIGINT, ShutdownSignal.SIGTERM]);
    configureOpenApi(app);
    await app.listen(port, host);

    telemetry.logger.record('info', { event: 'api.started' });
  } catch {
    logger.record('error', { code: 'bootstrap_failed', event: 'api.start_failed' });
    process.exitCode = 1;
  }
}

void bootstrap();
