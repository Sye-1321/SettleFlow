import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DependencyConnections } from '@settleflow/infrastructure';

import { ApiLifecycleService } from './api-lifecycle.service';
import { ApiVersionController } from './api-version.controller';
import { ApiEnvironment, validateApiEnvironment } from './config/environment';
import { HealthController } from './health/health.controller';

@Module({
  controllers: [ApiVersionController, HealthController],
  imports: [
    ConfigModule.forRoot({
      cache: true,
      envFilePath: ['apps/api/.env'],
      isGlobal: true,
      validate: validateApiEnvironment,
    }),
  ],
  providers: [
    ApiLifecycleService,
    {
      provide: DependencyConnections,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiEnvironment, true>): DependencyConnections =>
        new DependencyConnections({
          databaseUrl: config.get('DATABASE_URL', { infer: true }),
          rabbitmqUrl: config.get('RABBITMQ_URL', { infer: true }),
          timeoutMs: config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
        }),
    },
  ],
})
export class AppModule {}
