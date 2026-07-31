import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { DependencyConnections, PrismaDatabase } from '@settleflow/infrastructure';
import {
  ApiKeyCredentialService,
  MerchantAccessService,
  PrismaMerchantAccessRepository,
} from '@settleflow/merchant-access';

import { ApiLifecycleService } from './api-lifecycle.service';
import { ApiVersionController } from './api-version.controller';
import { ApiEnvironment, validateApiEnvironment } from './config/environment';
import { HealthController } from './health/health.controller';
import { MerchantApiKeyGuard } from './merchant-access/merchant-api-key.guard';

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
    ApiKeyCredentialService,
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
    MerchantApiKeyGuard,
    {
      provide: APP_GUARD,
      useExisting: MerchantApiKeyGuard,
    },
  ],
})
export class AppModule {}
