import { Logger, ShutdownSignal } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ApiEnvironment } from './config/environment';
import { configureOpenApi } from './openapi';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown bootstrap failure';
}

async function bootstrap(): Promise<void> {
  try {
    const app = await NestFactory.create(AppModule, { rawBody: true });
    const config = app.get<ConfigService<ApiEnvironment, true>>(ConfigService);
    const host = config.get('API_HOST', { infer: true });
    const port = config.get('API_PORT', { infer: true });

    app.enableShutdownHooks([ShutdownSignal.SIGINT, ShutdownSignal.SIGTERM]);
    configureOpenApi(app);
    await app.listen(port, host);

    Logger.log(
      JSON.stringify({
        event: 'api.started',
        host,
        port,
        service: 'api',
      }),
      'Bootstrap',
    );
  } catch (error: unknown) {
    Logger.error(describeError(error), undefined, 'Bootstrap');
    process.exitCode = 1;
  }
}

void bootstrap();
