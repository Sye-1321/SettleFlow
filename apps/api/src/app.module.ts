import { MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventingService, PrismaOutboxRepository } from '@settleflow/eventing';
import { IdempotencyService, PrismaIdempotencyRepository } from '@settleflow/idempotency';
import {
  DependencyConnections,
  MonotonicUlidGenerator,
  PrismaDatabase,
} from '@settleflow/infrastructure';
import {
  ApiKeyCredentialService,
  MerchantAccessService,
  PrismaMerchantAccessRepository,
} from '@settleflow/merchant-access';
import { AuditService, PrismaAuditRepository } from '@settleflow/operations';
import { PaymentIntentService, PrismaPaymentIntentRepository } from '@settleflow/payments';
import {
  LocalWebhookKeyring,
  NodeWebhookUrlPolicy,
  PrismaWebhookEndpointRepository,
  WebhookEndpointService,
  WebhookSecretCipher,
} from '@settleflow/webhooks';

import { ApiLifecycleService } from './api-lifecycle.service';
import { ApiVersionController } from './api-version.controller';
import { ApiEnvironment, validateApiEnvironment } from './config/environment';
import { HealthController } from './health/health.controller';
import { ProblemDetailsFilter } from './http/problem-details.filter';
import { RequestIdMiddleware } from './http/request-id';
import { MerchantApiKeyGuard } from './merchant-access/merchant-api-key.guard';
import { PaymentIntentController } from './payment-intents/payment-intent.controller';
import { WebhookEndpointController } from './webhook-endpoints/webhook-endpoint.controller';

@Module({
  controllers: [
    ApiVersionController,
    HealthController,
    PaymentIntentController,
    WebhookEndpointController,
  ],
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
    ApiKeyCredentialService,
    MonotonicUlidGenerator,
    {
      provide: PrismaDatabase,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiEnvironment, true>): PrismaDatabase =>
        new PrismaDatabase({
          connectionTimeoutMs: config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
          databaseUrl: config.get('DATABASE_URL', { infer: true }),
        }),
    },
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
    {
      provide: PrismaMerchantAccessRepository,
      inject: [PrismaDatabase],
      useFactory: (prisma: PrismaDatabase): PrismaMerchantAccessRepository =>
        new PrismaMerchantAccessRepository(prisma),
    },
    {
      provide: MerchantAccessService,
      inject: [PrismaMerchantAccessRepository, ApiKeyCredentialService],
      useFactory: (
        repository: PrismaMerchantAccessRepository,
        credentials: ApiKeyCredentialService,
      ): MerchantAccessService => new MerchantAccessService(repository, credentials),
    },
    {
      provide: PrismaIdempotencyRepository,
      inject: [PrismaDatabase, ConfigService],
      useFactory: (
        database: PrismaDatabase,
        config: ConfigService<ApiEnvironment, true>,
      ): PrismaIdempotencyRepository =>
        new PrismaIdempotencyRepository(database, {
          leaseDurationMs: config.get('IDEMPOTENCY_LEASE_MS', { infer: true }),
          lockTimeoutMs: config.get('IDEMPOTENCY_LOCK_TIMEOUT_MS', { infer: true }),
          replayDurationMs:
            config.get('IDEMPOTENCY_REPLAY_TTL_HOURS', { infer: true }) * 60 * 60 * 1_000,
          statementTimeoutMs: config.get('IDEMPOTENCY_STATEMENT_TIMEOUT_MS', { infer: true }),
        }),
    },
    {
      provide: IdempotencyService,
      inject: [PrismaIdempotencyRepository],
      useFactory: (repository: PrismaIdempotencyRepository): IdempotencyService =>
        new IdempotencyService(repository),
    },
    PrismaOutboxRepository,
    {
      provide: EventingService,
      inject: [PrismaOutboxRepository],
      useFactory: (repository: PrismaOutboxRepository): EventingService =>
        new EventingService(repository, new MonotonicUlidGenerator()),
    },
    {
      provide: PrismaPaymentIntentRepository,
      inject: [PrismaDatabase],
      useFactory: (database: PrismaDatabase): PrismaPaymentIntentRepository =>
        new PrismaPaymentIntentRepository(database),
    },
    {
      provide: PaymentIntentService,
      inject: [PrismaPaymentIntentRepository, IdempotencyService, EventingService],
      useFactory: (
        repository: PrismaPaymentIntentRepository,
        idempotency: IdempotencyService,
        eventing: EventingService,
      ): PaymentIntentService =>
        new PaymentIntentService(repository, idempotency, eventing, new MonotonicUlidGenerator()),
    },
    PrismaAuditRepository,
    {
      provide: AuditService,
      inject: [PrismaAuditRepository],
      useFactory: (repository: PrismaAuditRepository): AuditService => new AuditService(repository),
    },
    {
      provide: NodeWebhookUrlPolicy,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiEnvironment, true>): NodeWebhookUrlPolicy =>
        new NodeWebhookUrlPolicy({
          developmentAllowedOrigins: config.get('WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS', {
            infer: true,
          }),
          mode: config.get('WEBHOOK_URL_POLICY_MODE', { infer: true }),
        }),
    },
    {
      provide: LocalWebhookKeyring,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiEnvironment, true>): LocalWebhookKeyring =>
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
      provide: PrismaWebhookEndpointRepository,
      inject: [PrismaDatabase, ConfigService],
      useFactory: (
        database: PrismaDatabase,
        config: ConfigService<ApiEnvironment, true>,
      ): PrismaWebhookEndpointRepository =>
        new PrismaWebhookEndpointRepository(database, {
          lockTimeoutMs: config.get('WEBHOOK_ENDPOINT_LOCK_TIMEOUT_MS', { infer: true }),
          statementTimeoutMs: config.get('WEBHOOK_ENDPOINT_STATEMENT_TIMEOUT_MS', { infer: true }),
        }),
    },
    {
      provide: WebhookEndpointService,
      inject: [
        PrismaWebhookEndpointRepository,
        AuditService,
        NodeWebhookUrlPolicy,
        WebhookSecretCipher,
        MonotonicUlidGenerator,
      ],
      useFactory: (
        repository: PrismaWebhookEndpointRepository,
        audit: AuditService,
        urlPolicy: NodeWebhookUrlPolicy,
        secrets: WebhookSecretCipher,
        identifiers: MonotonicUlidGenerator,
      ): WebhookEndpointService =>
        new WebhookEndpointService(repository, audit, urlPolicy, secrets, identifiers),
    },
    MerchantApiKeyGuard,
    {
      provide: APP_GUARD,
      useExisting: MerchantApiKeyGuard,
    },
    {
      provide: APP_FILTER,
      useClass: ProblemDetailsFilter,
    },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
