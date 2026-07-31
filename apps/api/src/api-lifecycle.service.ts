import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { DependencyConnections, PrismaDatabase } from '@settleflow/infrastructure';

@Injectable()
export class ApiLifecycleService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(ApiLifecycleService.name);

  public constructor(
    private readonly dependencies: DependencyConnections,
    private readonly prisma: PrismaDatabase,
  ) {}

  public beforeApplicationShutdown(signal?: string): void {
    this.logger.log(
      JSON.stringify({
        event: 'api.stopping',
        service: 'api',
        signal: signal ?? 'application',
      }),
    );
  }

  public async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.dependencies.close(), this.prisma.close()]);
  }
}
