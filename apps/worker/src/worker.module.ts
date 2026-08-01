import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import {
  OutboxRelayService,
  PrismaOutboxRelayRepository,
  RabbitMqOutboxPublisher,
} from '@settleflow/eventing';
import { PrismaDatabase } from '@settleflow/infrastructure';

import { validateWorkerEnvironment, WorkerEnvironment } from './config/environment';
import { WorkerHealthService } from './health/worker-health.service';
import { OutboxRelaySignalService } from './runtime/outbox-relay-signal.service';
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
    OutboxRelaySignalService,
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
      provide: PrismaOutboxRelayRepository,
      inject: [PrismaDatabase, ConfigService, OutboxRelaySignalService],
      useFactory: (
        database: PrismaDatabase,
        config: ConfigService<WorkerEnvironment, true>,
        signals: OutboxRelaySignalService,
      ): PrismaOutboxRelayRepository =>
        new PrismaOutboxRelayRepository(database, {
          leaseDurationMs: config.get('OUTBOX_RELAY_LEASE_MS', { infer: true }),
          signal: (value) => signals.record(value),
          transactionTimeoutMs: config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
        }),
    },
    {
      provide: RabbitMqOutboxPublisher,
      inject: [ConfigService, OutboxRelaySignalService],
      useFactory: (
        config: ConfigService<WorkerEnvironment, true>,
        signals: OutboxRelaySignalService,
      ): RabbitMqOutboxPublisher =>
        new RabbitMqOutboxPublisher({
          confirmTimeoutMs: config.get('OUTBOX_RELAY_CONFIRM_TIMEOUT_MS', { infer: true }),
          connectionTimeoutMs: config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
          rabbitmqUrl: config.get('RABBITMQ_URL', { infer: true }),
          retryBaseMs: config.get('OUTBOX_RELAY_RETRY_BASE_MS', { infer: true }),
          retryMaxMs: config.get('OUTBOX_RELAY_RETRY_MAX_MS', { infer: true }),
          signal: (value) => signals.record(value),
        }),
    },
    {
      provide: OutboxRelayService,
      inject: [
        PrismaOutboxRelayRepository,
        RabbitMqOutboxPublisher,
        ConfigService,
        OutboxRelaySignalService,
      ],
      useFactory: (
        repository: PrismaOutboxRelayRepository,
        publisher: RabbitMqOutboxPublisher,
        config: ConfigService<WorkerEnvironment, true>,
        signals: OutboxRelaySignalService,
      ): OutboxRelayService =>
        new OutboxRelayService(repository, publisher, {
          batchSize: config.get('OUTBOX_RELAY_BATCH_SIZE', { infer: true }),
          retryBaseMs: config.get('OUTBOX_RELAY_RETRY_BASE_MS', { infer: true }),
          retryMaxMs: config.get('OUTBOX_RELAY_RETRY_MAX_MS', { infer: true }),
          signal: (value) => signals.record(value),
        }),
    },
  ],
})
export class WorkerModule {}
