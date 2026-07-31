import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WorkerEnvironment } from '../config/environment';
import { WorkerHealthService } from '../health/worker-health.service';

@Injectable()
export class WorkerRuntimeService
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerRuntimeService.name);
  private keepAliveTimer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly config: ConfigService<WorkerEnvironment, true>,
    private readonly health: WorkerHealthService,
  ) {}

  public onApplicationBootstrap(): void {
    const heartbeatIntervalMs = this.config.get('WORKER_HEARTBEAT_INTERVAL_MS', {
      infer: true,
    });

    this.keepAliveTimer = setInterval(() => {
      this.logger.debug(
        JSON.stringify({
          event: 'worker.heartbeat',
          ...this.health.getLiveness(),
        }),
      );
    }, heartbeatIntervalMs);

    this.health.markReady();
    this.logger.log(
      JSON.stringify({
        event: 'worker.ready',
        ...this.health.getReadiness(),
      }),
    );
  }

  public beforeApplicationShutdown(signal?: string): void {
    this.health.markStopping();
    this.logger.log(
      JSON.stringify({
        event: 'worker.stopping',
        readiness: this.health.getReadiness(),
        signal: signal ?? 'application',
      }),
    );
  }

  public onApplicationShutdown(): void {
    if (this.keepAliveTimer !== undefined) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }
}
