import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import {
  InboxService,
  OutboxRelayService,
  PrismaInboxRepository,
  PrismaOutboxRelayRepository,
  PrismaOutboxRepository,
  EventingService,
  RabbitMqOutboxPublisher,
  RabbitMqPaymentCreatedConsumer,
  RabbitMqSettlementLifecycleConsumer,
} from '@settleflow/eventing';
import {
  MonotonicUlidGenerator,
  PrismaDatabase,
  TelemetryRuntime,
} from '@settleflow/infrastructure';
import { PrismaLedgerReconciliationReader } from '@settleflow/ledger';
import {
  PrismaPaymentReconciliationReader,
  PrismaPaymentSettlementReader,
} from '@settleflow/payments';
import {
  PrismaReconciliationRepository,
  ReconciliationProcessor,
} from '@settleflow/reconciliation';
import {
  PrismaSettlementReconciliationReader,
  PrismaSettlementRepository,
  SettlementProjectionService,
} from '@settleflow/settlements';
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
import { OperationalMetricsService } from './runtime/operational-metrics.service';
import { ReconciliationPlatformReadAdapter } from './runtime/reconciliation-platform-read.adapter';
import { SettlementLifecycleSignalService } from './runtime/settlement-lifecycle-signal.service';
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
    SettlementLifecycleSignalService,
    WebhookProjectionSignalService,
    WebhookDeliverySignalService,
    OperationalMetricsService,
    WorkerRuntimeService,
    MonotonicUlidGenerator,
    {
      provide: TelemetryRuntime,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnvironment, true>): TelemetryRuntime =>
        new TelemetryRuntime({
          environment: config.get('NODE_ENV', { infer: true }),
          internalListener: {
            allowContainerWildcard:
              config.get('SETTLEFLOW_DEPLOYMENT_MODE', { infer: true }) === 'release-simulation',
            enabled: config.get('INTERNAL_TELEMETRY_ENABLED', { infer: true }),
            host: config.get('INTERNAL_TELEMETRY_HOST', { infer: true }),
            port: config.get('INTERNAL_TELEMETRY_PORT', { infer: true }),
          },
          releaseCommit: config.get('RELEASE_COMMIT', { infer: true }),
          releaseVersion: config.get('RELEASE_VERSION', { infer: true }),
          service: 'worker',
          tracing: {
            demo: config.get('OTEL_DEMO_TRACE_MODE', { infer: true }),
            enabled: config.get('OTEL_TRACING_ENABLED', { infer: true }),
            endpoint: config.get('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', { infer: true }),
            exportTimeoutMs: config.get('OTEL_TRACE_EXPORT_TIMEOUT_MS', { infer: true }),
            sampleRatio: config.get('OTEL_TRACE_SAMPLE_RATIO', { infer: true }),
          },
        }),
    },
    PrismaLedgerReconciliationReader,
    PrismaPaymentReconciliationReader,
    PrismaPaymentSettlementReader,
    PrismaSettlementReconciliationReader,
    {
      provide: ReconciliationPlatformReadAdapter,
      inject: [
        PrismaPaymentReconciliationReader,
        PrismaSettlementReconciliationReader,
        PrismaLedgerReconciliationReader,
      ],
      useFactory: (
        payments: PrismaPaymentReconciliationReader,
        settlements: PrismaSettlementReconciliationReader,
        ledger: PrismaLedgerReconciliationReader,
      ): ReconciliationPlatformReadAdapter =>
        new ReconciliationPlatformReadAdapter(payments, settlements, ledger),
    },
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
      provide: PrismaSettlementRepository,
      inject: [PrismaDatabase],
      useFactory: (database: PrismaDatabase): PrismaSettlementRepository =>
        new PrismaSettlementRepository(database),
    },
    {
      provide: SettlementProjectionService,
      inject: [
        PrismaSettlementRepository,
        MonotonicUlidGenerator,
        PrismaPaymentSettlementReader,
        InboxService,
      ],
      useFactory: (
        repository: PrismaSettlementRepository,
        identifiers: MonotonicUlidGenerator,
        payments: PrismaPaymentSettlementReader,
        inbox: InboxService,
      ): SettlementProjectionService =>
        new SettlementProjectionService(repository, identifiers, payments, inbox),
    },
    {
      provide: RabbitMqSettlementLifecycleConsumer,
      inject: [SettlementProjectionService, ConfigService, SettlementLifecycleSignalService],
      useFactory: (
        handler: SettlementProjectionService,
        config: ConfigService<WorkerEnvironment, true>,
        signals: SettlementLifecycleSignalService,
      ): RabbitMqSettlementLifecycleConsumer =>
        new RabbitMqSettlementLifecycleConsumer(handler, {
          bodyLimitBytes: config.get('SETTLEMENT_CONSUMER_BODY_LIMIT_BYTES', { infer: true }),
          connectionTimeoutMs: config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
          prefetch: config.get('SETTLEMENT_CONSUMER_PREFETCH', { infer: true }),
          rabbitmqUrl: config.get('RABBITMQ_URL', { infer: true }),
          reconnectBaseMs: config.get('SETTLEMENT_CONSUMER_RECONNECT_BASE_MS', { infer: true }),
          reconnectMaxMs: config.get('SETTLEMENT_CONSUMER_RECONNECT_MAX_MS', { infer: true }),
          shutdownTimeoutMs: config.get('SETTLEMENT_CONSUMER_SHUTDOWN_TIMEOUT_MS', { infer: true }),
          signal: (value) => signals.record(value),
        }),
    },
    PrismaOutboxRepository,
    {
      provide: EventingService,
      inject: [PrismaOutboxRepository, MonotonicUlidGenerator],
      useFactory: (
        repository: PrismaOutboxRepository,
        identifiers: MonotonicUlidGenerator,
      ): EventingService => new EventingService(repository, identifiers),
    },
    {
      provide: PrismaReconciliationRepository,
      inject: [PrismaDatabase],
      useFactory: (database: PrismaDatabase): PrismaReconciliationRepository =>
        new PrismaReconciliationRepository(database),
    },
    {
      provide: ReconciliationProcessor,
      inject: [PrismaReconciliationRepository, EventingService, ReconciliationPlatformReadAdapter],
      useFactory: (
        repository: PrismaReconciliationRepository,
        eventing: EventingService,
        platformReader: ReconciliationPlatformReadAdapter,
      ): ReconciliationProcessor =>
        new ReconciliationProcessor(repository, eventing, platformReader),
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
