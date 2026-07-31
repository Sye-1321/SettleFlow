import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ApiLifecycleService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ApiLifecycleService.name);

  public beforeApplicationShutdown(signal?: string): void {
    this.logger.log(
      JSON.stringify({
        event: 'api.stopping',
        service: 'api',
        signal: signal ?? 'application',
      }),
    );
  }
}
