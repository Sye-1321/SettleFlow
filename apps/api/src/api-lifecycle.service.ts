import {
  BeforeApplicationShutdown,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  areRequiredDependenciesReady,
  DependencyConnections,
  PrismaDatabase,
  TelemetryRuntime,
} from '@settleflow/infrastructure';

@Injectable()
export class ApiLifecycleService
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  public constructor(
    private readonly dependencies: DependencyConnections,
    private readonly prisma: PrismaDatabase,
    private readonly telemetry: TelemetryRuntime,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    await this.telemetry.start({
      liveness: () => ({ service: 'api', status: 'ok' }),
      readiness: async () => {
        const dependencies = await this.dependencies.checkReadiness();
        return {
          checks: {
            configuration: true,
            postgresql: dependencies.postgresql.status === 'up',
            rabbitmq_publisher: dependencies.rabbitmq.status === 'up',
          },
          ready: areRequiredDependenciesReady(dependencies),
        };
      },
    });
  }

  public beforeApplicationShutdown(signal?: string): void {
    this.telemetry.beginShutdown();
    this.telemetry.logger.record('info', {
      event: 'api.stopping',
      signal: signal ?? 'application',
    });
  }

  public async onApplicationShutdown(): Promise<void> {
    try {
      await Promise.all([this.dependencies.close(), this.prisma.close()]);
    } finally {
      await this.telemetry.shutdown();
    }
  }
}
