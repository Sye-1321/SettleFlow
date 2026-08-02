import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import {
  InboxService,
  OutboxRelayService,
  PrismaInboxRepository,
  PrismaOutboxRelayRepository,
  RabbitMqOutboxPublisher,
  RabbitMqPaymentCreatedConsumer,
} from '@settleflow/eventing';
import { MonotonicUlidGenerator, PrismaDatabase } from '@settleflow/infrastructure';
import {
  PaymentCreatedWebhookProjectionService,
  PrismaWebhookProjectionRepository,
} from '@settleflow/webhooks';

import { validateWorkerEnvironment, WorkerEnvironment } from './config/environment';
import { WorkerHealthService } from './health/worker-health.service';
import { OutboxRelaySignalService } from './runtime/outbox-relay-signal.service';
import { WebhookProjectionSignalService } from './runtime/webhook-projection-signal.service';
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
    WebhookProjectionSignalService,
    WorkerRuntimeService,
    MonotonicUlidGenerator,
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
      provide: PrismaInboxRepository,
      inject: [PrismaDatabase, ConfigService],
      useFactory: (
        database: PrismaDatabase,
        config: ConfigService<WorkerEnvironment, true>,
      ): PrismaInboxRepository => {
        const shutdownTimeoutMs = config.get('WEBHOOK_PROJECTION_SHUTDOWN_TIMEOUT_MS', {
          infer: true,
        });
        return new PrismaInboxRepository(database, {
          lockTimeoutMs: config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
          statementTimeoutMs: shutdownTimeoutMs - 2_000,
          transactionTimeoutMs: shutdownTimeoutMs - 1_000,
        });
      },
    },
    {
      provide: InboxService,
      inject: [PrismaInboxRepository, ConfigService],
      useFactory: (
        repository: PrismaInboxRepository,
        config: ConfigService<WorkerEnvironment, true>,
      ): InboxService =>
        new InboxService(repository, {
          retryAttempts: config.get('WEBHOOK_PROJECTION_TRANSACTION_RETRIES', { infer: true }),
        }),
    },
    PrismaWebhookProjectionRepository,
    {
      provide: PaymentCreatedWebhookProjectionService,
      inject: [InboxService, PrismaWebhookProjectionRepository, MonotonicUlidGenerator],
      useFactory: (
        inbox: InboxService,
        repository: PrismaWebhookProjectionRepository,
        identifiers: MonotonicUlidGenerator,
      ): PaymentCreatedWebhookProjectionService =>
        new PaymentCreatedWebhookProjectionService(inbox, repository, identifiers),
    },
    {
      provide: RabbitMqPaymentCreatedConsumer,
      inject: [
        PaymentCreatedWebhookProjectionService,
        ConfigService,
        WebhookProjectionSignalService,
      ],
      useFactory: (
        handler: PaymentCreatedWebhookProjectionService,
        config: ConfigService<WorkerEnvironment, true>,
        signals: WebhookProjectionSignalService,
      ): RabbitMqPaymentCreatedConsumer =>
        new RabbitMqPaymentCreatedConsumer(handler, {
          bodyLimitBytes: config.get('WEBHOOK_PROJECTION_BODY_LIMIT_BYTES', { infer: true }),
          connectionTimeoutMs: config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
          prefetch: config.get('WEBHOOK_PROJECTION_PREFETCH', { infer: true }),
          rabbitmqUrl: config.get('RABBITMQ_URL', { infer: true }),
          reconnectBaseMs: config.get('WEBHOOK_PROJECTION_RECONNECT_BASE_MS', { infer: true }),
          reconnectMaxMs: config.get('WEBHOOK_PROJECTION_RECONNECT_MAX_MS', { infer: true }),
          shutdownTimeoutMs: config.get('WEBHOOK_PROJECTION_SHUTDOWN_TIMEOUT_MS', {
            infer: true,
          }),
          signal: (value) => signals.record(value),
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
