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
  LocalWebhookKeyring,
  NodeWebhookHttpClient,
  NodeWebhookUrlPolicy,
  PaymentCreatedWebhookProjectionService,
  PrismaWebhookDeliveryRepository,
  PrismaWebhookProjectionRepository,
  WebhookDeliveryService,
  WebhookSecretCipher,
} from '@settleflow/webhooks';

import { validateWorkerEnvironment, WorkerEnvironment } from './config/environment';
import { WorkerHealthService } from './health/worker-health.service';
import { OutboxRelaySignalService } from './runtime/outbox-relay-signal.service';
import { WebhookDeliverySignalService } from './runtime/webhook-delivery-signal.service';
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
    WebhookDeliverySignalService,
    WorkerRuntimeService,
    MonotonicUlidGenerator,
    {
      provide: LocalWebhookKeyring,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnvironment, true>): LocalWebhookKeyring =>
        new LocalWebhookKeyring({
          activeKeyId: config.get('WEBHOOK_LOCAL_ACTIVE_KEY_ID', { infer: true }),
          keysJson: config.get('WEBHOOK_LOCAL_KEYS_JSON', { infer: true }),
          nodeEnvironment: config.get('NODE_ENV', { infer: true }),
          provider: config.get('WEBHOOK_KEYRING_PROVIDER', { infer: true }),
        }),
    },
    {
      provide: WebhookSecretCipher,
      inject: [LocalWebhookKeyring],
      useFactory: (keyring: LocalWebhookKeyring): WebhookSecretCipher =>
        new WebhookSecretCipher(keyring),
    },
    {
      provide: NodeWebhookUrlPolicy,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnvironment, true>): NodeWebhookUrlPolicy =>
        new NodeWebhookUrlPolicy({
          developmentAllowedOrigins: config.get('WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS', {
            infer: true,
          }),
          mode: config.get('WEBHOOK_URL_POLICY_MODE', { infer: true }),
        }),
    },
    {
      provide: NodeWebhookHttpClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnvironment, true>): NodeWebhookHttpClient =>
        new NodeWebhookHttpClient({
          maxResponseBytes: config.get('WEBHOOK_DELIVERY_RESPONSE_LIMIT_BYTES', { infer: true }),
          timeoutMs: config.get('WEBHOOK_DELIVERY_ATTEMPT_TIMEOUT_MS', { infer: true }),
        }),
    },
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
      provide: PrismaWebhookDeliveryRepository,
      inject: [PrismaDatabase, ConfigService],
      useFactory: (
        database: PrismaDatabase,
        config: ConfigService<WorkerEnvironment, true>,
      ): PrismaWebhookDeliveryRepository =>
        new PrismaWebhookDeliveryRepository(database, {
          leaseDurationMs: config.get('WEBHOOK_DELIVERY_LEASE_MS', { infer: true }),
          retryAttempts: config.get('WEBHOOK_DELIVERY_TRANSACTION_RETRIES', { infer: true }),
          transactionTimeoutMs: config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
        }),
    },
    {
      provide: WebhookDeliveryService,
      inject: [
        PrismaWebhookDeliveryRepository,
        LocalWebhookKeyring,
        WebhookSecretCipher,
        NodeWebhookUrlPolicy,
        NodeWebhookHttpClient,
        WebhookDeliverySignalService,
      ],
      useFactory: (
        repository: PrismaWebhookDeliveryRepository,
        keyring: LocalWebhookKeyring,
        cipher: WebhookSecretCipher,
        urlPolicy: NodeWebhookUrlPolicy,
        httpClient: NodeWebhookHttpClient,
        signals: WebhookDeliverySignalService,
      ): WebhookDeliveryService =>
        new WebhookDeliveryService(repository, keyring, cipher, urlPolicy, httpClient, {
          signal: (value) => signals.record(value),
        }),
    },
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
