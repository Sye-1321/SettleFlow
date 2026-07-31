import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { DependencyConnections } from '@settleflow/infrastructure';

@Injectable()
export class ApiLifecycleService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(ApiLifecycleService.name);

  public constructor(private readonly dependencies: DependencyConnections) {}

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
    await this.dependencies.close();
  }
}
