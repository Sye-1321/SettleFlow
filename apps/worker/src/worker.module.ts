import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateWorkerEnvironment } from './config/environment';
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
  providers: [WorkerHealthService, WorkerRuntimeService],
})
export class WorkerModule {}
