import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DependencyConnections, PrismaDatabase } from '@settleflow/infrastructure';

import { WorkerEnvironment } from '../config/environment';
import { WorkerHealthService } from '../health/worker-health.service';

@Injectable()
export class WorkerRuntimeService
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerRuntimeService.name);
  private keepAliveTimer: NodeJS.Timeout | undefined;
  private readinessRefresh: Promise<void> | undefined;

  public constructor(
    private readonly config: ConfigService<WorkerEnvironment, true>,
    private readonly dependencies: DependencyConnections,
    private readonly prisma: PrismaDatabase,
    private readonly health: WorkerHealthService,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    const heartbeatIntervalMs = this.config.get('WORKER_HEARTBEAT_INTERVAL_MS', {
      infer: true,
    });

    this.keepAliveTimer = setInterval(() => {
      void this.recordHeartbeat();
    }, heartbeatIntervalMs);

    await this.refreshReadiness();
    this.health.markRunning();
    this.logger.log(
      JSON.stringify({
        event: 'worker.readiness',
        readiness: this.health.getReadiness(),
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

  public async onApplicationShutdown(): Promise<void> {
    if (this.keepAliveTimer !== undefined) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }

    await Promise.all([this.dependencies.close(), this.prisma.close()]);
  }

  private async recordHeartbeat(): Promise<void> {
    await this.refreshReadiness();
    this.logger.debug(
      JSON.stringify({
        event: 'worker.heartbeat',
        liveness: this.health.getLiveness(),
        readiness: this.health.getReadiness(),
      }),
    );
  }

  private async refreshReadiness(): Promise<void> {
    this.readinessRefresh ??= this.dependencies
      .checkReadiness()
      .then((readiness) => {
        this.health.updateDependencies(readiness);
      })
      .finally(() => {
        this.readinessRefresh = undefined;
      });

    await this.readinessRefresh;
  }
}
