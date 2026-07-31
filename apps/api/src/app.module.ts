import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ApiLifecycleService } from './api-lifecycle.service';
import { ApiVersionController } from './api-version.controller';
import { validateApiEnvironment } from './config/environment';
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
  providers: [ApiLifecycleService],
})
export class AppModule {}
