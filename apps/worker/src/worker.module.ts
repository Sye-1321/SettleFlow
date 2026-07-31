import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import { DependencyConnections, PrismaDatabase } from '@settleflow/infrastructure';

import { validateWorkerEnvironment, WorkerEnvironment } from './config/environment';
import { WorkerHealthService } from './health/worker-health.service';
import { WorkerRuntimeService } from './runtime/worker-runtime.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      envFilePath: ['apps/worker/.env'],
      isGlobal: true,
      validate: validateWorkerEnvironment,
    }),
  ],
  providers: [
    WorkerHealthService,
    WorkerRuntimeService,
    {
      provide: PrismaDatabase,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnvironment, true>): PrismaDatabase =>
        new PrismaDatabase({
          connectionTimeoutMs: config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
          databaseUrl: config.get('DATABASE_URL', { infer: true }),
        }),
    },
    {
      provide: DependencyConnections,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnvironment, true>): DependencyConnections =>
        new DependencyConnections({
          databaseUrl: config.get('DATABASE_URL', { infer: true }),
          rabbitmqUrl: config.get('RABBITMQ_URL', { infer: true }),
          timeoutMs: config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
        }),
    },
  ],
})
export class WorkerModule {}
