import type {
  DependencyConnections,
  PrismaDatabase,
  TelemetryRuntime,
} from '@settleflow/infrastructure';

import { ApiLifecycleService } from './api-lifecycle.service';

describe('ApiLifecycleService', () => {
  it('starts the internal health source with the existing dependency policy', async () => {
    const dependencies = {
      checkReadiness: jest.fn().mockResolvedValue({
        postgresql: { status: 'up' },
        rabbitmq: { status: 'up' },
      }),
    } as unknown as DependencyConnections;
    let source:
      { readiness(): Promise<{ checks: Record<string, boolean>; ready: boolean }> } | undefined;
    const start = jest.fn((value: typeof source): Promise<void> => {
      source = value;
      return Promise.resolve();
    });
    const telemetry = { start } as unknown as TelemetryRuntime;
    const lifecycle = new ApiLifecycleService(dependencies, {} as PrismaDatabase, telemetry);

    await lifecycle.onApplicationBootstrap();
    await expect(source?.readiness()).resolves.toEqual({
      checks: { configuration: true, postgresql: true, rabbitmq_publisher: true },
      ready: true,
    });
  });

  it('closes dependency connections during application shutdown', async () => {
    const closeDependencies = jest.fn((): Promise<void> => Promise.resolve());
    const closePrisma = jest.fn((): Promise<void> => Promise.resolve());
    const dependencies = { close: closeDependencies } as unknown as DependencyConnections;
    const prisma = { close: closePrisma } as unknown as PrismaDatabase;
    const shutdownTelemetry = jest.fn((): Promise<void> => Promise.resolve());
    const telemetry = { shutdown: shutdownTelemetry } as unknown as TelemetryRuntime;
    const lifecycle = new ApiLifecycleService(dependencies, prisma, telemetry);

    await lifecycle.onApplicationShutdown();

    expect(closeDependencies).toHaveBeenCalledTimes(1);
    expect(closePrisma).toHaveBeenCalledTimes(1);
    expect(shutdownTelemetry).toHaveBeenCalledTimes(1);
  });
});
